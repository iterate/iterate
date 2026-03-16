import alchemy from "alchemy";
import { D1Database, Worker, WranglerJson } from "alchemy/cloudflare";
import { z } from "zod/v4";
import { TypeIdPrefixSchema } from "./typeid-prefix.ts";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const E2E_WILDCARD_LABEL = "example-with-wildcards-for-e2e-tests";

const Env = z.object({
  ALCHEMY_PASSWORD: z.string().optional(),
  WORKER_NAME: z.string().trim().min(1, "WORKER_NAME is required"),
  INGRESS_PROXY_API_TOKEN: z.string().trim().min(1, "INGRESS_PROXY_API_TOKEN is required"),
  TYPEID_PREFIX: TypeIdPrefixSchema,
  INGRESS_PROXY_HOSTNAME: z.string().trim().optional(),
  INGRESS_PROXY_ROUTE_PATTERN: z.string().trim().optional(),
  INGRESS_PROXY_ROUTE_PATTERNS: z.string().trim().optional(),
  INGRESS_PROXY_ROUTE_ZONE_ID: z.string().trim().optional(),
});

const env = Env.parse(process.env);
const adminToken = env.INGRESS_PROXY_API_TOKEN;

const app = await alchemy("ingress-proxy", {
  password: env.ALCHEMY_PASSWORD,
});

const db = await D1Database("routes-db", {
  name: `${env.WORKER_NAME}-routes`,
  migrationsDir: "./migrations",
  adopt: true,
});

const routePatternConfig = env.INGRESS_PROXY_ROUTE_PATTERNS ?? env.INGRESS_PROXY_ROUTE_PATTERN;
const routeZoneId = env.INGRESS_PROXY_ROUTE_ZONE_ID;
const routePatterns = (() => {
  const ingressHostname = normalizeHostname(env.INGRESS_PROXY_HOSTNAME ?? "ingress.iterate.com");
  const defaultPatterns = [`${ingressHostname}/*`, `*.${ingressHostname}/*`];
  const configuredPatterns = routePatternConfig
    ? routePatternConfig
        .split(",")
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
    : [];
  return [...new Set(configuredPatterns.length > 0 ? configuredPatterns : defaultPatterns)];
})();
const routes = routePatterns.map((pattern) => ({
  pattern,
  adopt: true,
  ...(routeZoneId ? { zoneId: routeZoneId } : {}),
}));

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function routePatternToHostname(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;
  const pathIndex = trimmed.indexOf("/");
  const hostPart = pathIndex === -1 ? trimmed : trimmed.slice(0, pathIndex);
  const host = normalizeHostname(hostPart);
  if (host.length === 0 || host === "*") return null;
  return host;
}

function deriveIngressBaseDomains(routePatterns: string[]): string[] {
  return [
    ...new Set(
      routePatterns
        .map((pattern) => routePatternToHostname(pattern))
        .filter((hostname): hostname is string => hostname !== null)
        .map((hostname) => normalizeHostname(hostname).replace(/^\*\./, "")),
    ),
  ];
}

function buildE2EWildcardHostnames(baseDomains: string[]): string[] {
  return baseDomains.flatMap((domain) => {
    const base = `${E2E_WILDCARD_LABEL}.${domain}`;
    // TODO: confirm Cloudflare accepts proxied records for this deeper wildcard shape.
    // Keep generating both hostnames for now so the manual live-E2E workflow exercises
    // the exact deployment path we care about; validate provider behavior separately.
    return [base, `*.${base}`];
  });
}

function deriveZoneNameFromHostname(hostname: string): string {
  const withoutWildcard = hostname.replace(/^\*\./, "");
  const parts = withoutWildcard.split(".").filter((part) => part.length > 0);
  if (parts.length < 2) {
    throw new Error(`cannot derive zone name from hostname '${hostname}'`);
  }
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

async function resolveZoneId(params: {
  apiToken: string;
  explicitZoneId?: string;
  fallbackHostnames: string[];
}): Promise<string> {
  if (params.explicitZoneId && params.explicitZoneId.length > 0) {
    return params.explicitZoneId;
  }

  const zoneName = deriveZoneNameFromHostname(params.fallbackHostnames[0] ?? "");
  if (!zoneName) {
    throw new Error("cannot resolve Cloudflare zone: missing zone name and no hostnames");
  }

  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/zones?name=${encodeURIComponent(zoneName)}&status=active&per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${params.apiToken}`,
        "Content-Type": "application/json",
      },
    },
  );
  const payload = (await response.json()) as {
    result?: Array<{ id?: string }>;
    errors?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      `Cloudflare zone lookup failed for '${zoneName}': ${JSON.stringify(payload?.errors ?? payload)}`,
    );
  }
  const zoneId = payload.result?.[0]?.id;
  if (!zoneId) {
    throw new Error(`Cloudflare zone lookup failed for '${zoneName}': no zone id found`);
  }
  return zoneId;
}

async function upsertCnameRecord(params: {
  apiToken: string;
  zoneId: string;
  name: string;
  content: string;
  comment: string;
}): Promise<"created" | "updated"> {
  const headers = {
    Authorization: `Bearer ${params.apiToken}`,
    "Content-Type": "application/json",
  };
  const queryResponse = await fetch(
    `${CLOUDFLARE_API_BASE}/zones/${params.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(params.name)}&per_page=1`,
    { headers },
  );
  const queryPayload = (await queryResponse.json()) as {
    result?: Array<{ id?: string }>;
    errors?: unknown;
  };
  if (!queryResponse.ok) {
    throw new Error(
      `Cloudflare DNS lookup failed for '${params.name}': ${JSON.stringify(queryPayload?.errors ?? queryPayload)}`,
    );
  }

  const existingId = queryPayload.result?.[0]?.id;
  const body = JSON.stringify({
    type: "CNAME",
    name: params.name,
    content: params.content,
    proxied: true,
    ttl: 1,
    comment: params.comment,
  });
  if (existingId) {
    const updateResponse = await fetch(
      `${CLOUDFLARE_API_BASE}/zones/${params.zoneId}/dns_records/${existingId}`,
      {
        method: "PUT",
        headers,
        body,
      },
    );
    if (!updateResponse.ok) {
      throw new Error(
        `Cloudflare DNS update failed for '${params.name}': ${await updateResponse.text()}`,
      );
    }
    return "updated";
  }

  const createResponse = await fetch(`${CLOUDFLARE_API_BASE}/zones/${params.zoneId}/dns_records`, {
    method: "POST",
    headers,
    body,
  });
  if (!createResponse.ok) {
    throw new Error(
      `Cloudflare DNS create failed for '${params.name}': ${await createResponse.text()}`,
    );
  }
  return "created";
}

async function ensureIngressDnsRecords(params: {
  routePatterns: string[];
  routeZoneId?: string;
  workerUrl: string;
  workerName: string;
}): Promise<void> {
  const routeHostnames = params.routePatterns
    .map((pattern) => routePatternToHostname(pattern))
    .filter((hostname): hostname is string => hostname !== null);
  const baseDomains = deriveIngressBaseDomains(params.routePatterns);
  const hardcodedE2EHostnames = buildE2EWildcardHostnames(baseDomains);
  const hostnames = [
    ...new Set([...routeHostnames, ...hardcodedE2EHostnames].map(normalizeHostname)),
  ];
  if (hostnames.length === 0) {
    console.log("No ingress DNS hostnames derived from route patterns; skipping CNAME upsert");
    return;
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error(
      `CLOUDFLARE_API_TOKEN is required to manage ingress DNS CNAME records (${hostnames.join(", ")})`,
    );
  }

  const workerHost = new URL(params.workerUrl).hostname;
  const zoneId = await resolveZoneId({
    apiToken,
    explicitZoneId: params.routeZoneId,
    fallbackHostnames: hostnames,
  });
  const comment = `Managed by apps/cf-ingress-proxy-worker/alchemy.run.ts (worker=${params.workerName})`;

  for (const hostname of hostnames) {
    const action = await upsertCnameRecord({
      apiToken,
      zoneId,
      name: hostname,
      content: workerHost,
      comment,
    });
    console.log(
      `${action === "created" ? "Created" : "Updated"} CNAME: ${hostname} -> ${workerHost}`,
    );
  }
}

export const worker = await Worker("worker", {
  name: env.WORKER_NAME,
  entrypoint: "./server.ts",
  compatibilityDate: "2025-02-24",
  compatibility: "node",
  bindings: {
    DB: db,
    INGRESS_PROXY_API_TOKEN: alchemy.secret(adminToken),
    TYPEID_PREFIX: env.TYPEID_PREFIX,
  },
  routes,
  adopt: true,
});

await WranglerJson({
  worker,
  path: "./wrangler.jsonc",
  secrets: false,
  transform: {
    wrangler: (spec) => ({
      ...spec,
      vars: {
        ...(spec.vars ?? {}),
        INGRESS_PROXY_API_TOKEN: "test-token",
        TYPEID_PREFIX: "tst",
      },
    }),
  },
});

if (!worker.url) {
  throw new Error("Worker URL is missing after deployment");
}

await ensureIngressDnsRecords({
  routePatterns,
  routeZoneId,
  workerUrl: worker.url,
  workerName: env.WORKER_NAME,
});

console.log(worker.url);

await app.finalize();
