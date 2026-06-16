import * as Cloudflare from "alchemy/Cloudflare";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { BaseAppConfig } from "../config.ts";
import { appConfigBinding, type AlchemyBootstrap } from "./init.ts";
import { startCloudflared } from "./start-cloudflared.ts";

/**
 * The observability config every Iterate worker uses: full sampling with
 * persistent logs and traces.
 * https://developers.cloudflare.com/workers/observability/logs/workers-logs/
 */
export const ITERATE_WORKER_OBSERVABILITY = {
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, headSamplingRate: 1, persist: true, invocationLogs: true },
  traces: { enabled: true, persist: true, headSamplingRate: 1 },
} satisfies Cloudflare.WorkerObservability;

type IterateCtx = AlchemyBootstrap<BaseAppConfig>;

export type IterateWorkerProps<B extends Cloudflare.WorkerBindingProps> = Omit<
  Cloudflare.WorkerProps<B>,
  "compatibility" | "dev" | "env" | "observability"
> & {
  /** Runtime env/bindings. APP_CONFIG is added automatically unless disabled. */
  env: B;
  /** Additional compatibility flags. `nodejs_compat` is included by default. */
  compatibilityFlags?: string[];
  /** Worker compatibility date. Defaults to Alchemy's current Workers runtime date. */
  compatibilityDate?: string;
  /** Override local worker dev settings. Defaults to PORT/HOST in local mode. */
  dev?: Cloudflare.WorkerProps<B>["dev"];
  /** Override Iterate's standard observability settings. */
  observability?: Cloudflare.WorkerObservability;
  /** Disable automatic APP_CONFIG injection for tiny routing workers. */
  includeAppConfig?: boolean;
  /** Disable the default `nodejs_compat` flag. */
  nodeCompat?: boolean;
};

export type IterateViteWorkerProps<B extends Cloudflare.WorkerBindingProps> = Omit<
  Cloudflare.ViteProps<B>,
  "compatibility" | "dev" | "env" | "observability"
> & {
  /** Runtime env/bindings. APP_CONFIG is added automatically unless disabled. */
  env: B;
  /** Additional compatibility flags. `nodejs_compat` is included by default. */
  compatibilityFlags?: string[];
  /** Worker compatibility date. Defaults to Alchemy's current Workers runtime date. */
  compatibilityDate?: string;
  /** Override local worker dev settings. Defaults to PORT/HOST in local mode. */
  dev?: Cloudflare.ViteProps<B>["dev"];
  /** Override Iterate's standard observability settings. */
  observability?: Cloudflare.WorkerObservability;
  /** Disable automatic APP_CONFIG injection for tiny routing workers. */
  includeAppConfig?: boolean;
  /** Disable the default `nodejs_compat` flag. */
  nodeCompat?: boolean;
};

export function iterateCompatibility(input: {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  nodeCompat?: boolean;
}): Cloudflare.WorkerProps["compatibility"] {
  const flags = [
    ...new Set([
      ...(input.nodeCompat === false ? [] : ["nodejs_compat"]),
      ...(input.compatibilityFlags ?? []),
    ]),
  ];
  return {
    ...(input.compatibilityDate ? { date: input.compatibilityDate } : {}),
    ...(flags.length > 0 ? { flags } : {}),
  };
}

export function iterateWorkerEnv<B extends Cloudflare.WorkerBindingProps>(
  ctx: AlchemyBootstrap,
  env: B,
  opts: { includeAppConfig?: boolean } = {},
) {
  if (opts.includeAppConfig === false) return env;
  return {
    ...env,
    APP_CONFIG: appConfigBinding(ctx),
  };
}

export function iterateLocalWorkerDev(
  ctx: Pick<AlchemyBootstrap, "local">,
): Cloudflare.WorkerProps["dev"] {
  if (!ctx.local) return undefined;
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
  };
}

export function iterateWorkerProps<B extends Cloudflare.WorkerBindingProps>(
  ctx: AlchemyBootstrap,
  props: IterateWorkerProps<B>,
): Cloudflare.WorkerProps<Cloudflare.WorkerBindingProps> {
  const workerProps = stripIterateWorkerProps(props);
  return {
    ...workerProps,
    compatibility: iterateCompatibility(props),
    dev: props.dev ?? iterateLocalWorkerDev(ctx),
    env: iterateWorkerEnv(ctx, props.env, { includeAppConfig: props.includeAppConfig }),
    observability: props.observability ?? ITERATE_WORKER_OBSERVABILITY,
  };
}

export function iterateViteWorkerProps<B extends Cloudflare.WorkerBindingProps>(
  ctx: AlchemyBootstrap,
  props: IterateViteWorkerProps<B>,
): Cloudflare.ViteProps<Cloudflare.WorkerBindingProps> {
  const workerProps = stripIterateWorkerProps(props);
  return {
    ...workerProps,
    compatibility: iterateCompatibility(props),
    dev: props.dev ?? iterateLocalWorkerDev(ctx),
    env: iterateWorkerEnv(ctx, props.env, { includeAppConfig: props.includeAppConfig }),
    observability: props.observability ?? ITERATE_WORKER_OBSERVABILITY,
  };
}

function stripIterateWorkerProps<T extends object>(
  props: T,
): Omit<T, "compatibilityDate" | "compatibilityFlags" | "includeAppConfig" | "nodeCompat"> {
  const cloudflareProps = { ...props } as T & {
    compatibilityDate?: unknown;
    compatibilityFlags?: unknown;
    includeAppConfig?: unknown;
    nodeCompat?: unknown;
  };
  delete cloudflareProps.compatibilityDate;
  delete cloudflareProps.compatibilityFlags;
  delete cloudflareProps.includeAppConfig;
  delete cloudflareProps.nodeCompat;
  return cloudflareProps as Omit<
    T,
    "compatibilityDate" | "compatibilityFlags" | "includeAppConfig" | "nodeCompat"
  >;
}

export function IterateWorker<B extends Cloudflare.WorkerBindingProps>(
  ctx: AlchemyBootstrap,
  id: string,
  props: IterateWorkerProps<B>,
) {
  return Cloudflare.Worker(id, iterateWorkerProps(ctx, props)).pipe(adopt(true));
}

/**
 * Standard Iterate Vite/TanStack Start worker for Alchemy v2.
 *
 * V2's `Cloudflare.Vite` owns the build and asset upload path. The old v1
 * `TanStackStart` wrapper, wrangler transforms, custom build command, and
 * asset preupload workaround intentionally do not survive this helper.
 */
export function IterateAppWorker<B extends Cloudflare.WorkerBindingProps>(
  ctx: AlchemyBootstrap,
  props: IterateViteWorkerProps<B>,
) {
  return Cloudflare.Vite("app", iterateViteWorkerProps(ctx, props)).pipe(adopt(true));
}

export function IterateApp<B extends Cloudflare.WorkerBindingProps>(
  ctx: IterateCtx,
  props: IterateViteWorkerProps<B> & { extraRouteHostnames?: string[] },
) {
  return Effect.gen(function* () {
    const workerName = props.name ?? ctx.workerName;
    const worker = yield* IterateAppWorker(ctx, props);
    const routeHosts = deriveWorkerRouteHosts(ctx.runtimeConfig.baseUrl, props.extraRouteHostnames);
    yield* IterateRoutes(ctx, { hostnames: routeHosts, workerName });
    const tunnel = yield* IterateDevTunnel(ctx, {
      extraRouteHostnames: props.extraRouteHostnames,
      targetPort: Number(process.env.PORT ?? 5173),
    });

    yield* Effect.sync(() => {
      console.dir(
        {
          config: ctx.runtimeConfig,
          url: ctx.runtimeConfig.baseUrl,
          workerName,
        },
        { depth: null },
      );
    });

    return { afterDeploy: tunnel.afterDeploy, worker };
  });
}

/**
 * Dev tunnel: route real domains to the local dev server.
 *
 * In v2 this is an Effect helper that declares a `Cloudflare.Tunnel` resource
 * with `retain(true)` so dev tunnels survive stack destroys and keep DNS
 * stable. Call the returned `afterDeploy` after the stack has been applied to
 * start the long-running `cloudflared` connector.
 */
export function IterateDevTunnel(
  ctx: IterateCtx,
  props: {
    baseUrl?: string;
    extraRouteHostnames?: string[];
    targetOrigin?: string;
    targetPort?: number;
  } = {},
) {
  return Effect.gen(function* () {
    const baseUrl = props.baseUrl ?? ctx.runtimeConfig.baseUrl;
    const baseUrlHostname = baseUrl ? new URL(baseUrl).hostname : undefined;
    const targetPort = props.targetPort ?? Number(process.env.PORT ?? 5173);
    const targetOrigin = props.targetOrigin ?? `http://localhost:${targetPort}`;

    if (!ctx.local || !baseUrlHostname || isLoopbackHostname(baseUrlHostname)) {
      return { afterDeploy: async () => {} };
    }

    const tunnelExtraHosts = (props.extraRouteHostnames ?? []).filter(
      (hostname) => hostname !== baseUrlHostname,
    );

    yield* Effect.sync(() => {
      console.log(
        `Creating dev tunnel: ${[baseUrlHostname, ...tunnelExtraHosts].join(", ")} -> ${targetOrigin}`,
      );
    });

    const tunnel = yield* Cloudflare.Tunnel(`dev-tunnel-${ctx.stage}`, {
      name: `dev-${ctx.stage}-${ctx.slug}`,
      configSrc: "cloudflare",
      ingress: [
        { hostname: baseUrlHostname, service: targetOrigin },
        ...tunnelExtraHosts.map((hostname) => ({ hostname, service: targetOrigin })),
        { service: "http_status:404" },
      ],
    }).pipe(adopt(true), retain(true));

    const tunnelId = yield* tunnel.tunnelId;
    const tunnelToken = yield* tunnel.token;

    yield* Effect.promise(async () => {
      const cloudflareApi = createCloudflareApi();
      await Promise.all(
        tunnelExtraHosts
          .filter((hostname) => hostname.startsWith("*."))
          .map(async (hostname) => {
            const { zoneId } = await findActiveZoneForHostname(cloudflareApi, hostname);
            await ensureDevTunnelWildcardDnsRecord({
              cloudflareApi,
              zoneId,
              name: hostname,
              target: `${tunnelId}.cfargotunnel.com`,
              comment: `Managed by ${ctx.slug} dev tunnel (${ctx.stage}).`,
            });
          }),
      );
    });

    return {
      afterDeploy: async () => {
        await startCloudflared({
          tunnelToken: Redacted.value(tunnelToken),
          vitePort: targetPort,
          displayUrl: baseUrl ?? targetOrigin,
        });
      },
    };
  });
}

/**
 * Routes + DNS for a deployed worker.
 *
 * Alchemy v2 has `Worker.domain` for custom hostnames, but OS still needs
 * Cloudflare Worker route patterns plus proxied DNS records. This helper keeps
 * that custom API behavior in deploy-space as an Effect, outside Worker
 * runtime code.
 */
export function IterateRoutes(
  ctx: Pick<AlchemyBootstrap, "local" | "slug" | "stage">,
  props: {
    hostnames: string[];
    workerName: string;
  },
) {
  return Effect.promise(async () => {
    if (ctx.local || props.hostnames.length === 0) return;

    const cloudflareApi = createCloudflareApi();
    await waitForCloudflareWorkerScript({
      cloudflareApi,
      workerName: props.workerName,
    });

    const routeZoneIds = new Map<string, string>();
    for (const hostname of props.hostnames) {
      const { zoneId } = await findActiveZoneForHostname(cloudflareApi, hostname);
      routeZoneIds.set(hostname, zoneId);

      await retryCloudflareWorkerRouteCreation(() =>
        ensureCloudflareWorkerRoute({
          cloudflareApi,
          pattern: `${hostname}/*`,
          script: props.workerName,
          zoneId,
        }),
      );
    }

    const dnsRouteHosts = props.hostnames.filter(shouldCreateDnsRecordForRouteHostname);
    await Promise.all(
      dnsRouteHosts.map(async (hostname) => {
        const zoneId =
          routeZoneIds.get(hostname) ??
          (await findActiveZoneForHostname(cloudflareApi, hostname)).zoneId;
        await ensureCloudflareDnsRecord({
          cloudflareApi,
          record: {
            type: "A",
            name: hostname,
            content: "192.0.2.1",
            proxied: true,
            ttl: 1,
            comment: `Managed by ${ctx.slug} alchemy (${ctx.stage}).`,
          },
          zoneId,
        });
      }),
    );
  });
}

/**
 * Ensure proxied originless DNS records exist for worker-route hostnames.
 */
export function ensureProxiedDnsForHostnames(input: {
  hostnames: readonly string[];
  comment: string;
}) {
  return Effect.promise(async () => {
    if (input.hostnames.length === 0) return;
    const cloudflareApi = createCloudflareApi();
    await Promise.all(
      input.hostnames.map(async (hostname) => {
        const { zoneId } = await findActiveZoneForHostname(cloudflareApi, hostname);
        await ensureCloudflareDnsRecord({
          cloudflareApi,
          record: {
            type: "A",
            name: hostname,
            content: "192.0.2.1",
            proxied: true,
            ttl: 1,
            comment: input.comment,
          },
          zoneId,
        });
      }),
    );
  });
}

/**
 * Derive the set of Cloudflare worker route hostnames from the app's `baseUrl`
 * and any extra hostnames.
 */
export function deriveWorkerRouteHosts(
  baseUrl: string | undefined,
  extraRouteHostnames: string[] = [],
) {
  const baseUrlHostname = baseUrl ? new URL(baseUrl).hostname : undefined;
  return [
    ...new Set([...(baseUrlHostname ? [baseUrlHostname] : []), ...extraRouteHostnames]),
  ].filter((hostname) => !hostname.endsWith(".workers.dev"));
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function shouldCreateDnsRecordForRouteHostname(hostname: string) {
  // Cloudflare accepts route patterns like `*-preview-1.iterate.app/*`, but
  // DNS has no equivalent partial-label wildcard record. OS preview relies on
  // the existing proxied `*.iterate.app` DNS record for those one-label project
  // hosts, while ordinary exact and `*.` wildcard routes still get app-owned DNS.
  return !hostname.startsWith("*") || hostname.startsWith("*.");
}

type CloudflareApi = ReturnType<typeof createCloudflareApi>;

function createCloudflareApi() {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const baseUrl = "https://api.cloudflare.com/client/v4";

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  return {
    accountId,
    get: (path: string) => request(path),
    post: (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body) }),
    put: (path: string, body: unknown) =>
      request(path, { method: "PUT", body: JSON.stringify(body) }),
  };
}

async function ensureCloudflareWorkerRoute(input: {
  cloudflareApi: CloudflareApi;
  pattern: string;
  script: string;
  zoneId: string;
}) {
  const params = new URLSearchParams({ pattern: input.pattern });
  const listResponse = await input.cloudflareApi.get(
    `/zones/${input.zoneId}/workers/routes?${params.toString()}`,
  );
  if (!listResponse.ok) {
    throw new Error(
      `Failed to check Worker route ${input.pattern}: ${listResponse.status} ${await listResponse.text()}`,
    );
  }

  const listResult = (await listResponse.json()) as {
    result?: Array<{ id: string; pattern?: string; script?: string }>;
  };
  const existing = listResult.result?.find((route) => route.pattern === input.pattern);
  const body = { pattern: input.pattern, script: input.script };
  const response = existing
    ? await input.cloudflareApi.put(`/zones/${input.zoneId}/workers/routes/${existing.id}`, body)
    : await input.cloudflareApi.post(`/zones/${input.zoneId}/workers/routes`, body);

  if (!response.ok) {
    throw new Error(
      `Failed to upsert Worker route ${input.pattern}: ${response.status} ${await response.text()}`,
    );
  }
}

async function ensureCloudflareDnsRecord(input: {
  cloudflareApi: CloudflareApi;
  record: {
    comment: string;
    content: string;
    name: string;
    proxied: boolean;
    ttl: number;
    type: "A";
  };
  zoneId: string;
}) {
  const params = new URLSearchParams({ name: input.record.name });
  const listResponse = await input.cloudflareApi.get(
    `/zones/${input.zoneId}/dns_records?${params.toString()}`,
  );
  if (!listResponse.ok) {
    throw new Error(
      `Failed to check DNS record ${input.record.name}: ${listResponse.status} ${await listResponse.text()}`,
    );
  }

  const listResult = (await listResponse.json()) as {
    result?: Array<{ id: string; name?: string; proxied?: boolean; type?: string }>;
  };
  const existingProxiedRecord = listResult.result?.find(
    (record) => record.name === input.record.name && record.proxied,
  );
  if (existingProxiedRecord) return;

  const existingRecordId = listResult.result?.find(
    (record) => record.name === input.record.name && record.type === input.record.type,
  )?.id;
  const response = existingRecordId
    ? await input.cloudflareApi.put(
        `/zones/${input.zoneId}/dns_records/${existingRecordId}`,
        input.record,
      )
    : await input.cloudflareApi.post(`/zones/${input.zoneId}/dns_records`, input.record);

  if (!response.ok) {
    throw new Error(
      `Failed to upsert DNS record ${input.record.name}: ${response.status} ${await response.text()}`,
    );
  }
}

async function ensureDevTunnelWildcardDnsRecord(input: {
  cloudflareApi: CloudflareApi;
  comment: string;
  name: string;
  target: string;
  zoneId: string;
}) {
  const params = new URLSearchParams({ name: input.name, per_page: "100" });
  const listResponse = await input.cloudflareApi.get(
    `/zones/${input.zoneId}/dns_records?${params.toString()}`,
  );
  if (!listResponse.ok) {
    throw new Error(
      `Failed to check dev tunnel wildcard DNS record ${input.name}: ${listResponse.status} ${await listResponse.text()}`,
    );
  }

  const listResult = (await listResponse.json()) as {
    result?: Array<{
      content?: string;
      id: string;
      name?: string;
      proxied?: boolean;
      type?: string;
    }>;
  };
  const records = listResult.result?.filter((record) => record.name === input.name) ?? [];
  const cname = records.find((record) => record.type === "CNAME");
  const conflictingRecords = records.filter((record) => record.type !== "CNAME");

  if (conflictingRecords.length > 0) {
    throw new Error(
      `Dev tunnel wildcard DNS record ${input.name} has conflicting ${[
        ...new Set(conflictingRecords.map((record) => record.type ?? "unknown")),
      ].join(", ")} record(s). Replace them with a proxied CNAME to ${input.target}.`,
    );
  }

  const record = {
    type: "CNAME" as const,
    name: input.name,
    content: input.target,
    proxied: true,
    ttl: 1,
    comment: input.comment,
  };

  const response = cname
    ? await input.cloudflareApi.put(`/zones/${input.zoneId}/dns_records/${cname.id}`, record)
    : await input.cloudflareApi.post(`/zones/${input.zoneId}/dns_records`, record);

  if (!response.ok) {
    throw new Error(
      `Failed to upsert dev tunnel wildcard DNS record ${input.name}: ${response.status} ${await response.text()}`,
    );
  }
}

async function findActiveZoneForHostname(cloudflareApi: CloudflareApi, hostname: string) {
  let page = 1;
  let totalPages = 1;
  const zones: CloudflareZone[] = [];

  do {
    const response = await cloudflareApi.get(`/zones?per_page=50&page=${page}`);
    if (!response.ok) {
      throw new Error(`Failed to list zones (page ${page}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      result: Array<{
        account?: { id?: string };
        id: string;
        name: string;
        status?: string;
      }>;
      result_info?: { total_pages?: number };
    };
    zones.push(...data.result);
    totalPages = data.result_info?.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages);

  const bestZone = selectBestCloudflareZoneForHostname({
    accountId: cloudflareApi.accountId,
    hostname,
    zones,
  });

  if (!bestZone) {
    throw new Error(
      `Could not find zone for hostname '${hostname}'. Available zones: ${zones.map((zone) => zone.name).join(", ")}`,
    );
  }

  return { zoneId: bestZone.id, zoneName: bestZone.name };
}

type CloudflareZone = {
  account?: { id?: string };
  id: string;
  name: string;
  status?: string;
};

export function selectBestCloudflareZoneForHostname(input: {
  accountId: string;
  hostname: string;
  zones: CloudflareZone[];
}) {
  const cleanHostname = input.hostname.replace(/^\*\./, "");
  const matchingZones = input.zones
    .filter((zone) => cleanHostname === zone.name || cleanHostname.endsWith(`.${zone.name}`))
    .sort((a, b) => b.name.length - a.name.length);

  return (
    matchingZones.find(
      (zone) => zone.account?.id === input.accountId && zone.status === "active",
    ) ??
    matchingZones.find((zone) => zone.status === "active") ??
    matchingZones.find((zone) => zone.account?.id === input.accountId) ??
    matchingZones[0]
  );
}

async function waitForCloudflareWorkerScript(params: {
  cloudflareApi: CloudflareApi;
  workerName: string;
}) {
  const deadline = Date.now() + 120_000;
  let visibleChecks = 0;
  let lastStatus = 0;
  let lastBody = "";

  while (Date.now() < deadline) {
    const response = await params.cloudflareApi.get(
      `/accounts/${params.cloudflareApi.accountId}/workers/scripts/${encodeURIComponent(params.workerName)}`,
    );

    if (response.ok) {
      visibleChecks += 1;
      if (visibleChecks >= 2) return;
      await sleep(5_000);
      continue;
    }

    lastStatus = response.status;
    lastBody = await response.text();

    if (response.status !== 404) {
      throw new Error(
        `Cloudflare Workers Scripts API returned ${response.status} while checking ${params.workerName}: ${lastBody}`,
      );
    }

    await sleep(5_000);
  }

  throw new Error(
    `Cloudflare Worker script ${params.workerName} was not visible before route creation. Last status: ${lastStatus}. Last body: ${lastBody}`,
  );
}

async function retryCloudflareWorkerRouteCreation(createRoute: () => Promise<unknown>) {
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await createRoute();
      return;
    } catch (error) {
      if (attempt === maxAttempts || !isCloudflareWorkerRouteMissingError(error)) {
        throw error;
      }

      await sleep(5_000);
    }
  }
}

function isCloudflareWorkerRouteMissingError(error: unknown) {
  const maybeError = error as {
    message?: unknown;
  };
  return String(maybeError.message ?? "").includes("10019");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
