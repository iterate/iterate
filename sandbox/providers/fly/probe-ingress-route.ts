import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { FlyProvider } from "./provider.ts";

type IngressRouteRecord = {
  routeId: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function callIngressProxyProcedure<TResponse>(params: {
  baseUrl: string;
  apiToken: string;
  name: string;
  input: unknown;
}): Promise<TResponse> {
  const response = await fetch(`${params.baseUrl}/api/orpc/${params.name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: params.input }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    json?: TResponse;
    error?: unknown;
  };

  if (!response.ok) {
    throw new Error(
      `ingress proxy ${params.name} failed (${response.status}): ${JSON.stringify(payload.json ?? payload.error ?? payload)}`,
    );
  }
  if (payload.json === undefined) {
    throw new Error(`ingress proxy ${params.name} returned no json payload`);
  }

  return payload.json;
}

async function createRoute(params: {
  baseUrl: string;
  apiToken: string;
  metadata: Record<string, unknown>;
  patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>;
}): Promise<IngressRouteRecord> {
  return await callIngressProxyProcedure<IngressRouteRecord>({
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
    name: "createRoute",
    input: {
      metadata: params.metadata,
      patterns: params.patterns,
    },
  });
}

async function waitForReachable(params: {
  url: string;
  timeoutMs?: number;
}): Promise<{ status: number }> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(params.url, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      if (response.status > 0) {
        return { status: response.status };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }

  throw new Error(
    `timed out waiting for reachable URL ${params.url} (lastStatus=${String(lastStatus)})`,
    {
      cause: lastError,
    },
  );
}

async function probeUrl(url: string): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    const body = await response.text().catch(() => "");
    console.log(`[probe] ${url}`);
    console.log(`  status=${String(response.status)} ok=${String(response.ok)}`);
    console.log(`  body=${JSON.stringify(body.slice(0, 200))}`);
  } catch (error) {
    console.log(`[probe] ${url}`);
    console.log(`  error=${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const rawEnv = process.env as Record<string, string | undefined>;
  const image = rawEnv.FLY_PROBE_IMAGE ?? rawEnv.FLY_DEFAULT_IMAGE;
  if (!image) {
    throw new Error("FLY_PROBE_IMAGE or FLY_DEFAULT_IMAGE is required");
  }

  const ingressProxyBaseUrl = normalizeUrl(
    rawEnv.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
      rawEnv.INGRESS_PROXY_BASE_URL ??
      "https://ingress.iterate.com",
  );
  const ingressProxyDomain = (
    rawEnv.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
    rawEnv.INGRESS_PROXY_DOMAIN ??
    "ingress.iterate.com"
  ).trim();
  const ingressProxyApiToken =
    rawEnv.INGRESS_PROXY_API_TOKEN ?? rawEnv.INGRESS_PROXY_E2E_API_TOKEN ?? "";
  if (!ingressProxyApiToken.trim()) {
    throw new Error("INGRESS_PROXY_API_TOKEN or INGRESS_PROXY_E2E_API_TOKEN is required");
  }

  const flyBaseDomain = rawEnv.FLY_BASE_DOMAIN ?? "fly.dev";
  const externalId =
    rawEnv.FLY_PROBE_EXTERNAL_ID?.trim() || `dev-fly-ingress-probe-${randomUUID().slice(0, 8)}`;
  const flyPublicBaseUrl = `https://${externalId}.${flyBaseDomain}`;
  const ingressBaseHost = `${externalId}.${ingressProxyDomain}`;
  const ingressServiceHost = `events__${externalId}.${ingressProxyDomain}`;

  const provider = new FlyProvider(rawEnv);
  const sandbox = await provider.create({
    externalId,
    name: externalId,
    envVars: {
      ITERATE_PUBLIC_BASE_URL: flyPublicBaseUrl,
      ITERATE_PUBLIC_BASE_URL_TYPE: "subdomain",
    },
    providerSnapshotId: image,
  });

  console.log(
    `[created] fly app=${sandbox.providerId} machineId=${sandbox.machineId ?? "unknown"}`,
  );

  const publicProbe = await waitForReachable({
    url: `${flyPublicBaseUrl}/healthz`,
    timeoutMs: 240_000,
  });
  console.log(`[ready] ${flyPublicBaseUrl}/healthz status=${String(publicProbe.status)}`);

  const baseRoute = await createRoute({
    baseUrl: ingressProxyBaseUrl,
    apiToken: ingressProxyApiToken,
    metadata: {
      source: "fly-probe-ingress-route-script",
      appName: externalId,
      routeType: "base",
      createdAt: new Date().toISOString(),
    },
    patterns: [
      {
        pattern: ingressBaseHost,
        target: flyPublicBaseUrl,
        headers: {
          Host: ingressBaseHost,
        },
      },
    ],
  });

  const wildcardRoute = await createRoute({
    baseUrl: ingressProxyBaseUrl,
    apiToken: ingressProxyApiToken,
    metadata: {
      source: "fly-probe-ingress-route-script",
      appName: externalId,
      routeType: "service-wildcard",
      createdAt: new Date().toISOString(),
    },
    patterns: [
      {
        pattern: `*__${externalId}.${ingressProxyDomain}`,
        target: flyPublicBaseUrl,
      },
    ],
  });

  console.log(`[created] ingress base routeId=${baseRoute.routeId} pattern=${ingressBaseHost}`);
  console.log(
    `[created] ingress wildcard routeId=${wildcardRoute.routeId} pattern=*__${externalId}.${ingressProxyDomain}`,
  );

  try {
    const resolved = await dnsLookup(ingressBaseHost);
    console.log(`[dns] ${ingressBaseHost} -> ${resolved.address}`);
  } catch (error) {
    console.log(
      `[dns] ${ingressBaseHost} unresolved (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  await probeUrl(`https://${ingressBaseHost}/healthz`);
  await probeUrl(`http://${ingressBaseHost}/healthz`);
  await probeUrl(`https://${ingressBaseHost}/healthz`);
  await probeUrl(`http://${ingressBaseHost}/healthz`);
  await probeUrl(`https://${ingressServiceHost}/healthz`);
  await probeUrl(`http://${ingressServiceHost}/healthz`);

  console.log("");
  console.log("Resources intentionally left running.");
  console.log(`App: ${externalId}`);
  console.log(`Route IDs: ${baseRoute.routeId}, ${wildcardRoute.routeId}`);
  console.log("Cleanup:");
  console.log(
    `  doppler run --config dev -- sh -lc 'curl -sS ${ingressProxyBaseUrl}/api/orpc/deleteRoute -H "authorization: Bearer $INGRESS_PROXY_API_TOKEN" -H "content-type: application/json" --data "{\\"json\\":{\\"routeId\\":\\"${baseRoute.routeId}\\"}}"'`,
  );
  console.log(
    `  doppler run --config dev -- sh -lc 'curl -sS ${ingressProxyBaseUrl}/api/orpc/deleteRoute -H "authorization: Bearer $INGRESS_PROXY_API_TOKEN" -H "content-type: application/json" --data "{\\"json\\":{\\"routeId\\":\\"${wildcardRoute.routeId}\\"}}"'`,
  );
  console.log(`  doppler run --config dev -- fly apps destroy ${externalId} -y`);
}

await main();
