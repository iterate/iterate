import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { Route, TanStackStart, Tunnel, createCloudflareApi } from "alchemy/cloudflare";
import type { Bindings, WorkerProps } from "alchemy/cloudflare";
import type { BaseAppConfig } from "../config.ts";
import { slugify } from "../slugify.ts";
import type { initAlchemy } from "./init.ts";
import { startCloudflared } from "./start-cloudflared.ts";

/**
 * Create a standard Iterate app worker with automatic route derivation, DNS,
 * observability, and dev tunnel support.
 *
 * This is the standard way to deploy an Iterate app to Cloudflare Workers. It
 * wraps alchemy's TanStackStart (https://alchemy.run/providers/cloudflare/tanstack-start/)
 * and adds our conventions on top:
 *
 * **Route + DNS derivation from `baseUrl`:**
 * Each environment (dev, preview, prod) sets `APP_CONFIG_BASE_URL` in Doppler.
 * This function extracts the hostname and creates both a Cloudflare worker route
 * and a proxied CNAME DNS record pointing to the worker. Worker routes alone are
 * not enough — Cloudflare requires a DNS record on the zone for the proxied
 * hostname to resolve. See https://developers.cloudflare.com/workers/configuration/routing/routes/
 *
 * **Dev tunnel (local development):**
 * When running locally with a real `baseUrl` (not localhost), creates a Cloudflare
 * Tunnel so the app is reachable at the configured domain. The tunnel resource
 * auto-creates DNS CNAMEs for each ingress hostname. See
 * https://alchemy.run/providers/cloudflare/tunnel/ and
 * docs/devops-cloudflare-doppler-alchemy-setup.md.
 *
 * **Observability:**
 * All Iterate workers use the same observability config: full sampling with
 * persistent logs and traces. See https://developers.cloudflare.com/workers/observability/
 *
 * ```ts
 * const ctx = await initAlchemy("my-app", AppConfig, process.env);
 * const db = await D1Database("db", { name: `${ctx.workerName}-db` });
 * const { worker, afterFinalize } = await IterateApp(ctx, {
 *   bindings: { DB: db },
 * });
 * await ctx.app.finalize();
 * await afterFinalize();
 * ```
 */
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
} as const;

type IterateCtx = Awaited<ReturnType<typeof initAlchemy>>;

export type IterateAppProps<B extends Bindings> = {
  /** App-specific worker bindings (D1, DOs, etc). APP_CONFIG is added automatically. */
  bindings: B;
  /**
   * Additional compatibility flags. `nodejs_compat` is always included because
   * TanStack Start and several shared packages depend on Node-compatible APIs.
   * Events adds `enable_request_signal` for oRPC abort detection:
   * https://developers.cloudflare.com/workers/runtime-apis/request/
   */
  compatibilityFlags?: string[];
  /** Worker compatibility date. Defaults to Alchemy's current Workers runtime date. */
  compatibilityDate?: string;
  /**
   * Additional hostnames to route to this worker beyond `baseUrl`.
   * Each hostname gets a worker route and (for non-local deploys) a DNS CNAME.
   * For example, os passes `["iterate.app", "*.iterate.app"]` for project
   * subdomain routing.
   */
  extraRouteHostnames?: string[];
  /** Worker entry module (default: `./src/entry.workerd.ts`). */
  main?: string;
  /**
   * Deployed worker name (default: `ctx.workerName`). Apps fronted by a
   * router worker (apps/os) give the router the canonical `ctx.workerName`
   * and pass a distinct name here (e.g. `${ctx.workerName}-app`).
   */
  name?: string;
  /** Override build command (default: `pnpm exec vite build --config vite.config.ts`). */
  build?: string;
  /** Override dev command (default: `pnpm exec vite dev --config vite.config.ts`). */
  dev?: { command: string };
  /**
   * Event sources this worker consumes, e.g. queues. Passed through to
   * alchemy's Worker. https://alchemy.run/providers/cloudflare/queue/
   */
  eventSources?: WorkerProps<B>["eventSources"];
  /** Hook to modify the generated wrangler config for bindings Alchemy does not model yet. */
  wranglerTransform?: (
    spec: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Whether the worker gets a public workers.dev URL (alchemy default when
   * unset). Apps fronted by a router worker (apps/os) pass `false` so the
   * app worker is reachable only via service bindings — that unreachability
   * is what makes the router's internal headers trustworthy.
   */
  url?: boolean;
};

export async function IterateApp<B extends Bindings>(ctx: IterateCtx, props: IterateAppProps<B>) {
  const runtimeConfig = ctx.runtimeConfig as BaseAppConfig;
  const routeHosts = deriveWorkerRouteHosts(runtimeConfig.baseUrl, props.extraRouteHostnames);

  const worker = await IterateAppWorker(ctx, props);
  const { afterFinalize } = await IterateDevTunnel(ctx, {
    extraRouteHostnames: props.extraRouteHostnames,
    worker,
  });
  await IterateRoutes(ctx, { hostnames: routeHosts, worker });

  console.dir(
    {
      config: runtimeConfig,
      url: runtimeConfig.baseUrl ?? worker.url,
      workersDevUrl: worker.url,
    },
    { depth: null },
  );

  return { worker, afterFinalize };
}

/**
 * The app worker with Iterate conventions — TanStack Start build via Vite,
 * APP_CONFIG injection, standard observability, asset preupload + server
 * bundle pruning — but no routes, DNS, or tunnel. Apps that put a router
 * worker in front (apps/os) call this directly and give the routes to the
 * router via {@link IterateRoutes}.
 */
export async function IterateAppWorker<B extends Bindings>(
  ctx: IterateCtx,
  props: Omit<IterateAppProps<B>, "extraRouteHostnames">,
) {
  const { app, rawRuntimeConfig, slug } = ctx;
  const workerName = props.name ?? ctx.workerName;
  const compatibilityFlags = [...new Set(["nodejs_compat", ...(props.compatibilityFlags ?? [])])];
  const buildCommand = withSequentialCloudflareAssetPreupload({
    command: props.build ?? "pnpm exec vite build --config vite.config.ts",
    workerName,
  });

  const worker = await TanStackStart(slug, {
    name: workerName,
    // adopt: take ownership of existing resources instead of failing on conflict.
    // Needed because dev/preview workers persist across alchemy runs.
    // See https://alchemy.run/concepts/resources/ (adopt section)
    adopt: true,
    ...(props.url === undefined ? {} : { url: props.url }),
    compatibilityDate: props.compatibilityDate,
    compatibilityFlags,
    eventSources: props.eventSources,
    bindings: {
      ...props.bindings,
      APP_CONFIG: app.local
        ? JSON.stringify(rawRuntimeConfig, null, 2)
        : alchemy.secret(JSON.stringify(rawRuntimeConfig, null, 2)),
    },
    wrangler: {
      main: props.main ?? "./src/entry.workerd.ts",
      transform: props.wranglerTransform,
    },
    observability: ITERATE_WORKER_OBSERVABILITY,
    build: buildCommand,
    dev: props.dev ?? {
      // --strictPort: fail loudly if the port is taken instead of vite silently
      // falling through to the next one. The local-dev flow bakes a specific
      // port into APP_CONFIG_BASE_URL + the discovery file, so a silent drift
      // would leave the running server, base URL, and OAuth resource pointing
      // at different ports.
      command:
        "pnpm exec vite dev --config vite.config.ts --strictPort --host ${HOST:-127.0.0.1} --port ${PORT:-5173}",
    },
  });

  return worker;
}

/**
 * Dev tunnel: route real domains to the local vite server.
 *
 * When baseUrl points to a real domain (not localhost) in local mode, create
 * a Cloudflare Tunnel so the app is reachable at that domain during dev.
 * The Tunnel resource auto-creates DNS CNAMEs for each ingress hostname.
 * https://alchemy.run/providers/cloudflare/tunnel/
 *
 * Returns `afterFinalize` — call it after `app.finalize()` to start
 * cloudflared. No-op (and no tunnel resource) outside tunnel-backed dev.
 */
export async function IterateDevTunnel(
  ctx: IterateCtx,
  props: {
    extraRouteHostnames?: string[];
    /** The locally-served worker the tunnel points at (its url carries the vite port). */
    worker: { url?: string };
  },
) {
  const { app, slug } = ctx;
  const runtimeConfig = ctx.runtimeConfig as BaseAppConfig;
  const { worker } = props;

  let tunnelToken: string | undefined;
  let tunnelVitePort: number | undefined;

  const baseUrlHostname = runtimeConfig.baseUrl
    ? new URL(runtimeConfig.baseUrl).hostname
    : undefined;
  // `*.localhost` resolves to loopback in every browser (RFC 6761) — those
  // base URLs are fully local and never need a tunnel.
  const baseUrlIsLoopback =
    !!baseUrlHostname &&
    (baseUrlHostname === "localhost" ||
      baseUrlHostname.endsWith(".localhost") ||
      baseUrlHostname === "127.0.0.1" ||
      baseUrlHostname === "::1");

  if (app.local && baseUrlHostname && !baseUrlIsLoopback && worker.url) {
    tunnelVitePort = Number(new URL(worker.url).port || "5173");

    const tunnelExtraHosts = (props.extraRouteHostnames ?? []).filter(
      (hostname) => hostname !== baseUrlHostname,
    );

    console.log(
      `Creating dev tunnel: ${[baseUrlHostname, ...tunnelExtraHosts].join(", ")} -> localhost:${tunnelVitePort}`,
    );

    const tunnel = await Tunnel(`dev-tunnel-${app.stage}`, {
      name: `dev-${app.stage}-${slug}`,
      adopt: true,
      // Don't auto-delete dev tunnels — they persist across sessions so
      // DNS records stay stable and cloudflared reconnects instantly.
      delete: false,
      ingress: [
        { hostname: baseUrlHostname, service: `http://localhost:${tunnelVitePort}` },
        ...tunnelExtraHosts.map((hostname) => ({
          hostname,
          service: `http://localhost:${tunnelVitePort}`,
        })),
        // Catch-all rule required by the Cloudflare tunnel API.
        { service: "http_status:404" as const },
      ],
    });

    const cloudflareApi = await createCloudflareApi({});
    await Promise.all(
      tunnelExtraHosts
        .filter((hostname) => hostname.startsWith("*."))
        .map(async (hostname) => {
          const { zoneId } = await findActiveZoneForHostnameFromApi(cloudflareApi, hostname);
          await ensureDevTunnelWildcardDnsRecord({
            cloudflareApi,
            zoneId,
            name: hostname,
            target: `${tunnel.tunnelId}.cfargotunnel.com`,
            comment: `Managed by ${slug} dev tunnel (${app.stage}).`,
          });
        }),
    );

    tunnelToken = tunnel.token.unencrypted;
  }

  /** Call after `app.finalize()` to start cloudflared. No-op when no tunnel is active. */
  async function afterFinalize() {
    if (!tunnelToken || !tunnelVitePort) return;
    await startCloudflared({
      tunnelToken,
      vitePort: tunnelVitePort,
      displayUrl: runtimeConfig.baseUrl ?? `localhost:${tunnelVitePort}`,
    });
  }

  return { afterFinalize };
}

/**
 * Routes + DNS for a deployed worker.
 *
 * Worker routes tell Cloudflare "send requests matching this pattern to this
 * worker", but the hostname still needs a proxied DNS record. We create
 * routes only after the worker script is uploaded and visible; Cloudflare
 * rejects route creation for scripts that do not exist yet. We then create
 * originless dummy A records so Cloudflare can terminate DNS/TLS and invoke
 * the route without trying to resolve the worker's workers.dev hostname as
 * an origin. No-op in local mode.
 * https://developers.cloudflare.com/workers/configuration/routing/routes/#subdomains-must-have-a-dns-record
 * https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/hostname-routing/
 */
export async function IterateRoutes(
  ctx: IterateCtx,
  props: {
    hostnames: string[];
    /** The worker the routes point at (an alchemy Worker resource). */
    worker: { name: string; url?: string };
  },
) {
  const { app, slug } = ctx;
  const { worker } = props;
  const routeHosts = props.hostnames;

  if (!app.local && routeHosts.length > 0) {
    const cloudflareApi = await createCloudflareApi({});
    const zones = await listCloudflareZones(cloudflareApi);

    await waitForCloudflareWorkerScript({
      cloudflareApi,
      workerName: worker.name,
    });

    const routeZoneIds = new Map<string, string>();
    await Promise.all(
      routeHosts.map(async (hostname) => {
        const { zoneId } = findActiveZoneForHostname({
          accountId: cloudflareApi.accountId,
          hostname,
          zones,
        });
        routeZoneIds.set(hostname, zoneId);

        await retryCloudflareWorkerRouteCreation(() =>
          Route(routeResourceIdForHostname(hostname), {
            pattern: `${hostname}/*`,
            script: worker.name,
            adopt: true,
            zoneId,
          }),
        );
      }),
    );

    const dnsRouteHosts = routeHosts.filter(shouldCreateDnsRecordForRouteHostname);
    await Promise.all(
      dnsRouteHosts.map(async (hostname) => {
        const zoneId =
          routeZoneIds.get(hostname) ??
          findActiveZoneForHostname({
            accountId: cloudflareApi.accountId,
            hostname,
            zones,
          }).zoneId;
        const record = {
          type: "A" as const,
          name: hostname,
          content: "192.0.2.1",
          proxied: true,
          ttl: 1,
          comment: `Managed by ${slug} alchemy (${app.stage}).`,
        };

        await ensureCloudflareDnsRecord({
          cloudflareApi,
          record,
          zoneId,
        });
      }),
    );
  }
}

/**
 * Ensure proxied originless DNS records exist for worker-route hostnames.
 *
 * Worker routes only fire when the hostname has a proxied DNS record on the
 * zone. IterateApp does this automatically from `baseUrl`; apps that declare
 * routes directly (apps/auth via WORKER_ROUTES) call this after deploy so new
 * hostnames like auth.iterate-preview-N.com resolve without manual DNS work.
 */
export async function ensureProxiedDnsForHostnames(input: {
  hostnames: readonly string[];
  comment: string;
}) {
  if (input.hostnames.length === 0) return;
  const cloudflareApi = await createCloudflareApi({});
  const zones = await listCloudflareZones(cloudflareApi);
  await Promise.all(
    input.hostnames.map(async (hostname) => {
      const { zoneId } = findActiveZoneForHostname({
        accountId: cloudflareApi.accountId,
        hostname,
        zones,
      });
      await ensureCloudflareDnsRecord({
        cloudflareApi,
        record: {
          type: "A" as const,
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
}

function routeResourceIdForHostname(hostname: string) {
  return hostname.startsWith("*.")
    ? `route-wildcard-${slugify(hostname.slice(2))}`
    : `route-${slugify(hostname)}`;
}

function shouldCreateDnsRecordForRouteHostname(hostname: string) {
  // Cloudflare accepts route patterns like `*-preview-1.iterate.app/*`, but
  // DNS has no equivalent partial-label wildcard record. OS preview relies on
  // the existing proxied `*.iterate.app` DNS record for those one-label project
  // hosts, while ordinary exact and `*.` wildcard routes still get app-owned DNS.
  return !hostname.startsWith("*") || hostname.startsWith("*.");
}

/**
 * Verify the DNS record exists after Worker route creation.
 *
 * Worker routes only require a proxied DNS record for the hostname. Some zones
 * already use a proxied CNAME to the worker's workers.dev hostname, while newer
 * routes use an originless dummy A record. Keep either shape instead of trying
 * to convert CNAMEs into A records and failing on Cloudflare's record conflict
 * rules.
 */
async function ensureCloudflareDnsRecord(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
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
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
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

async function listCloudflareZones(cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>) {
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

  return zones;
}

async function findActiveZoneForHostnameFromApi(
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>,
  hostname: string,
) {
  const zones = await listCloudflareZones(cloudflareApi);
  return findActiveZoneForHostname({
    accountId: cloudflareApi.accountId,
    hostname,
    zones,
  });
}

function findActiveZoneForHostname(input: {
  accountId: string;
  hostname: string;
  zones: CloudflareZone[];
}) {
  const bestZone = selectBestCloudflareZoneForHostname({
    accountId: input.accountId,
    hostname: input.hostname,
    zones: input.zones,
  });

  if (!bestZone) {
    throw new Error(
      `Could not find zone for hostname '${input.hostname}'. Available zones: ${input.zones.map((zone) => zone.name).join(", ")}`,
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

function withSequentialCloudflareAssetPreupload(input: { command: string; workerName: string }) {
  const preuploadScriptPath = fileURLToPath(
    new URL("./preupload-worker-assets.ts", import.meta.url),
  );
  const pruneScriptPath = fileURLToPath(new URL("./prune-server-bundle.ts", import.meta.url));

  // The prune step keeps the uploaded worker script small: alchemy's noBundle
  // upload globs everything under dist/server, but the Vite SSR build also
  // emits browser-only modules (web workers, wasm) the server graph never
  // imports. Script size is what every cold Durable Object isolate pays to
  // start, and our request paths chain several DOs — see
  // prune-server-bundle.ts for the measured impact.
  //
  // Alchemy's Cloudflare Assets helper currently uploads multiple asset buckets
  // concurrently. The Cloudflare Assets API returns the final completion JWT only
  // from the bucket that completes the upload session, so concurrent buckets can
  // race and leave the later Worker upload with an `ASSETS` binding but no
  // completed asset set. This pre-upload uses the same manifest shape as
  // Cloudflare's documented direct-upload flow, but uploads buckets
  // sequentially before Alchemy creates the Worker. Alchemy then opens its own
  // session, sees no remaining buckets, and attaches a stable completion token.
  // https://developers.cloudflare.com/workers/static-assets/direct-upload/
  return [
    input.command,
    `pnpm exec tsx ${JSON.stringify(pruneScriptPath)} --server-dir ${JSON.stringify("dist/server")} --entrypoint ${JSON.stringify("index.js")}`,
    `pnpm exec tsx ${JSON.stringify(preuploadScriptPath)} --worker-name ${JSON.stringify(input.workerName)} --assets ${JSON.stringify("dist/client")}`,
  ].join(" && ");
}

/**
 * Wait until Cloudflare's Workers Scripts API can read the just-uploaded
 * script before creating zone routes for it.
 *
 * Alchemy's `TanStackStart` returns after the upload step, but in CI we have
 * seen the immediately-following Routes API call fail with Cloudflare error
 * 10019 ("Worker does not exist"). Polling the first-party script-read endpoint
 * catches the ordinary upload lag. Requiring a second successful read after a
 * short pause also covers the awkward edge where the Scripts API can see the
 * Worker but the Routes API has not accepted it yet.
 *
 * Cloudflare routes docs:
 * https://developers.cloudflare.com/workers/configuration/routing/routes/
 *
 * Workers Scripts API:
 * https://developers.cloudflare.com/workers/api/
 */
async function waitForCloudflareWorkerScript(params: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
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
      await sleep(1_000);
      continue;
    }

    lastStatus = response.status;
    lastBody = await response.text();

    if (response.status !== 404) {
      throw new Error(
        `Cloudflare Workers Scripts API returned ${response.status} while checking ${params.workerName}: ${lastBody}`,
      );
    }

    await sleep(1_000);
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

      await sleep(2_000);
    }
  }
}

function isCloudflareWorkerRouteMissingError(error: unknown) {
  const maybeError = error as {
    errorData?: unknown;
    message?: unknown;
    status?: unknown;
  };
  const details = `${String(maybeError.message ?? "")}\n${JSON.stringify(maybeError.errorData ?? "")}`;

  return details.includes("10019") && details.includes("Worker which does not exist");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the set of Cloudflare worker route hostnames from the app's `baseUrl`
 * and any extra hostnames.
 *
 * Cloudflare worker routes use `hostname/*` patterns to match incoming requests.
 * We derive these from two sources:
 *
 * 1. `baseUrl` — the app's canonical URL (e.g. `https://os.iterate.com`).
 *    The hostname (`os.iterate.com`) becomes a route.
 * 2. `extraRouteHostnames` — additional hostnames passed by the caller.
 *    os uses this for project subdomain routing (`iterate.app`, `*.iterate.app`).
 *
 * Returns a deduplicated array of hostnames. Returns empty if no routes are
 * configured (localhost-only dev, or workers.dev-only previews).
 *
 * @see https://developers.cloudflare.com/workers/configuration/routing/routes/
 * @see https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
 */
function deriveWorkerRouteHosts(baseUrl: string | undefined, extraRouteHostnames: string[] = []) {
  const baseUrlHostname = baseUrl ? new URL(baseUrl).hostname : undefined;
  return [
    ...new Set([...(baseUrlHostname ? [baseUrlHostname] : []), ...extraRouteHostnames]),
  ].filter((hostname) => !hostname.endsWith(".workers.dev"));
}
