import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import {
  DnsRecords,
  Route,
  TanStackStart,
  Tunnel,
  createCloudflareApi,
  findZoneForHostname,
} from "alchemy/cloudflare";
import type { Bindings } from "alchemy/cloudflare";
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
 * https://alchemy.run/providers/cloudflare/tunnel/ and docs/os2-environments.md.
 *
 * **Observability:**
 * All Iterate workers use the same observability config: full sampling with
 * persistent logs and traces. See https://developers.cloudflare.com/workers/observability/
 *
 * ```ts
 * const ctx = await initAlchemy(manifest, AppConfig, process.env);
 * const db = await D1Database("db", { name: `${ctx.workerName}-db` });
 * const { worker, afterFinalize } = await IterateApp(ctx, {
 *   bindings: { DB: db },
 * });
 * await ctx.app.finalize();
 * await afterFinalize();
 * ```
 */
export async function IterateApp<B extends Bindings>(
  ctx: Awaited<ReturnType<typeof initAlchemy>>,
  props: {
    /** App-specific worker bindings (D1, DOs, etc). APP_CONFIG is added automatically. */
    bindings: B;
    /**
     * Additional compatibility flags. `nodejs_compat` is always included because
     * TanStack Start and several shared packages depend on Node-compatible APIs.
     * Events adds `enable_request_signal` for oRPC abort detection:
     * https://developers.cloudflare.com/workers/runtime-apis/request/
     */
    compatibilityFlags?: string[];
    /**
     * Additional hostnames to route to this worker beyond `baseUrl`.
     * Each hostname gets a worker route and (for non-local deploys) a DNS CNAME.
     * For example, os2 passes `["iterate2.app", "*.iterate2.app"]` for project
     * subdomain routing.
     */
    extraRouteHostnames?: string[];
    /** Override build command (default: `pnpm exec vite build --config vite.config.ts`). */
    build?: string;
    /** Override dev command (default: `pnpm exec vite dev --config vite.config.ts`). */
    dev?: { command: string };
  },
) {
  const { app, workerName, rawAppConfig, compiledAppConfig, manifest } = ctx;
  const routeHosts = deriveWorkerRouteHosts(compiledAppConfig.baseUrl, props.extraRouteHostnames);
  const compatibilityFlags = [...new Set(["nodejs_compat", ...(props.compatibilityFlags ?? [])])];
  const buildCommand = withSequentialCloudflareAssetPreupload({
    command: props.build ?? "pnpm exec vite build --config vite.config.ts",
    workerName,
  });

  const worker = await TanStackStart(manifest.slug, {
    name: workerName,
    // adopt: take ownership of existing resources instead of failing on conflict.
    // Needed because dev/preview workers persist across alchemy runs.
    // See https://alchemy.run/concepts/resources/ (adopt section)
    adopt: true,
    compatibilityFlags,
    bindings: {
      ...props.bindings,
      APP_CONFIG: alchemy.secret(JSON.stringify(rawAppConfig, null, 2)),
    },
    wrangler: { main: "./src/entry.workerd.ts" },
    // Full sampling with persistent logs/traces for all Iterate workers.
    // https://developers.cloudflare.com/workers/observability/logs/workers-logs/
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { enabled: true, headSamplingRate: 1, persist: true, invocationLogs: true },
      traces: { enabled: true, persist: true, headSamplingRate: 1 },
    },
    build: buildCommand,
    dev: props.dev ?? { command: "pnpm exec vite dev --config vite.config.ts" },
  });

  // --- Dev tunnel: route real domains to the local vite server ---
  // When baseUrl points to a real domain (not localhost) in local mode, create
  // a Cloudflare Tunnel so the app is reachable at that domain during dev.
  // The Tunnel resource auto-creates DNS CNAMEs for each ingress hostname.
  // https://alchemy.run/providers/cloudflare/tunnel/

  let tunnelToken: string | undefined;
  let tunnelVitePort: number | undefined;

  const baseUrlHostname = compiledAppConfig.baseUrl
    ? new URL(compiledAppConfig.baseUrl).hostname
    : undefined;

  if (app.local && baseUrlHostname && !baseUrlHostname.startsWith("localhost") && worker.url) {
    tunnelVitePort = Number(new URL(worker.url).port || "5173");

    // Wildcard hostnames from extraRouteHostnames (e.g. *.iterate2.app)
    const wildcardHosts = (props.extraRouteHostnames ?? []).filter((h) => h.startsWith("*."));

    console.log(
      `Creating dev tunnel: ${[baseUrlHostname, ...wildcardHosts].join(", ")} -> localhost:${tunnelVitePort}`,
    );

    const tunnel = await Tunnel(`dev-tunnel-${app.stage}`, {
      name: `dev-${app.stage}-${manifest.slug}`,
      adopt: true,
      // Don't auto-delete dev tunnels — they persist across sessions so
      // DNS records stay stable and cloudflared reconnects instantly.
      delete: false,
      ingress: [
        { hostname: baseUrlHostname, service: `http://localhost:${tunnelVitePort}` },
        ...wildcardHosts.map((hostname) => ({
          hostname,
          service: `http://localhost:${tunnelVitePort}`,
        })),
        // Catch-all rule required by the Cloudflare tunnel API.
        { service: "http_status:404" as const },
      ],
    });

    tunnelToken = tunnel.token.unencrypted;
  }

  // --- Production/preview DNS ---
  // Worker routes tell Cloudflare "send requests matching this pattern to this
  // worker", but the hostname still needs a DNS record to resolve. We create
  // routes after TanStackStart returns so the route resource depends on an
  // uploaded Worker script; Cloudflare rejects route creation for scripts that
  // do not exist yet. We then create proxied CNAME records pointing each route
  // hostname to the worker's workers.dev hostname. Without these, requests to
  // the custom domain 404.
  // https://developers.cloudflare.com/workers/configuration/routing/routes/#subdomains-must-have-a-dns-record

  if (!app.local && worker.url && routeHosts.length > 0) {
    const cloudflareApi = await createCloudflareApi({});
    const workerHostname = new URL(worker.url).hostname;

    await Promise.all(
      routeHosts.map((hostname) =>
        Route(routeResourceIdForHostname(hostname), {
          pattern: `${hostname}/*`,
          script: worker,
          adopt: true,
        }),
      ),
    );

    await Promise.all(
      routeHosts.map(async (hostname) => {
        const { zoneId } = await findZoneForHostname(cloudflareApi, hostname);
        const dnsResourceId = hostname.startsWith("*.")
          ? `project-wildcard-dns-${slugify(hostname)}`
          : `dns-${slugify(hostname)}`;

        return DnsRecords(dnsResourceId, {
          zoneId,
          records: [
            {
              type: "CNAME",
              name: hostname,
              content: workerHostname,
              proxied: true,
              ttl: 1,
              comment: `Managed by ${manifest.slug} alchemy (${app.stage}).`,
            },
          ],
        });
      }),
    );
  }

  console.dir(
    {
      config: compiledAppConfig,
      url: compiledAppConfig.baseUrl ?? worker.url,
      workersDevUrl: worker.url,
    },
    { depth: null },
  );

  /** Call after `app.finalize()` to start cloudflared. No-op when no tunnel is active. */
  async function afterFinalize() {
    if (!tunnelToken || !tunnelVitePort) return;
    await startCloudflared({
      tunnelToken,
      vitePort: tunnelVitePort,
      displayUrl: compiledAppConfig.baseUrl ?? `localhost:${tunnelVitePort}`,
    });
  }

  return { worker, afterFinalize };
}

function routeResourceIdForHostname(hostname: string) {
  return hostname.startsWith("*.")
    ? `route-wildcard-${slugify(hostname.slice(2))}`
    : `route-${slugify(hostname)}`;
}

function withSequentialCloudflareAssetPreupload(input: { command: string; workerName: string }) {
  const preuploadScriptPath = fileURLToPath(
    new URL("./preupload-worker-assets.ts", import.meta.url),
  );

  // Alchemy's Cloudflare Assets helper currently uploads multiple asset buckets
  // concurrently. The Cloudflare Assets API returns the final completion JWT only
  // from the bucket that completes the upload session, so concurrent buckets can
  // race and leave the later Worker upload with an `ASSETS` binding but no
  // completed asset set. This pre-upload uses the same manifest shape as
  // Cloudflare's documented direct-upload flow, but uploads buckets
  // sequentially before Alchemy creates the Worker. Alchemy then opens its own
  // session, sees no remaining buckets, and attaches a stable completion token.
  // https://developers.cloudflare.com/workers/static-assets/direct-upload/
  return `${input.command} && pnpm exec tsx ${JSON.stringify(preuploadScriptPath)} --worker-name ${JSON.stringify(input.workerName)} --assets ${JSON.stringify("dist/client")}`;
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
 * 1. `baseUrl` — the app's canonical URL (e.g. `https://os.iterate2.com`).
 *    The hostname (`os.iterate2.com`) becomes a route.
 * 2. `extraRouteHostnames` — additional hostnames passed by the caller.
 *    os2 uses this for project subdomain routing (`iterate2.app`, `*.iterate2.app`).
 *
 * Returns a deduplicated array of hostnames. Returns empty if no routes are
 * configured (localhost-only dev).
 *
 * @see https://developers.cloudflare.com/workers/configuration/routing/routes/
 */
function deriveWorkerRouteHosts(baseUrl: string | undefined, extraRouteHostnames: string[] = []) {
  const baseUrlHostname = baseUrl ? new URL(baseUrl).hostname : undefined;
  return [...new Set([...(baseUrlHostname ? [baseUrlHostname] : []), ...extraRouteHostnames])];
}
