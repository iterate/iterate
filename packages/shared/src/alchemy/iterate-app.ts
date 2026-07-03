import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { TanStackStart, createCloudflareApi } from "alchemy/cloudflare";
import type { Bindings, WorkerProps } from "alchemy/cloudflare";
import type { initAlchemy } from "./init.ts";

/**
 * Iterate's Cloudflare worker + edge-routing conventions.
 *
 * Two layers with deliberately different lifecycles:
 *
 * **Workers** ({@link IterateAppWorker}) are alchemy resources: created,
 * updated, and destroyed with the app's stage.
 *
 * **Routes + DNS** ({@link IterateRoutes}) are NOT alchemy resources. They are
 * idempotently ENSURED against the Cloudflare API and never deleted by any
 * deploy or destroy. Rationale: creating a zone route is the only edge
 * operation we have that can silently fail — the route is visible in the API
 * but never fires at the edge ("zombie route"), so every request falls through
 * to the originless placeholder DNS record and dies with a 522 after ~20s
 * (tasks/os-cold-create-latency.md). Script uploads, by contrast, are the
 * battle-tested steady-state path. So route creation is pushed to the rarest
 * possible moment (a genuinely fresh hostname, or re-parking after a slot
 * teardown — see {@link parkWorkerRoutes}), always ordered after DNS, and
 * always verified with a live edge probe that heals zombies by recreation.
 * Steady-state deploys mutate no route or DNS state at all.
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

/**
 * The subset of an initAlchemy context the route helpers need. Structural on
 * purpose: apps that hand-roll their alchemy app (apps/auth) can construct it
 * directly.
 */
export type IterateRoutesCtx = {
  app: { local?: boolean; stage: string };
  slug: string;
};

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

/** The context initAlchemy returns — the full ctx IterateAppWorker consumes. */
type IterateCtx = Awaited<ReturnType<typeof initAlchemy>>;

/**
 * The app worker with Iterate conventions — TanStack Start build via Vite,
 * APP_CONFIG injection, standard observability, asset preupload + server
 * bundle pruning — but no routes or DNS. Callers ensure routes with
 * {@link IterateRoutes} AFTER `ctx.app.finalize()`: the ensure is not an
 * alchemy resource, so running it before finalize would let a stale Route
 * resource in state orphan-delete the very route it just verified.
 *
 * ```ts
 * const ctx = await initAlchemy("my-app", AppConfig, process.env);
 * const worker = await IterateAppWorker(ctx, { bindings: { DB: db } });
 * await ctx.app.finalize();
 * await IterateRoutes(ctx, {
 *   worker,
 *   hostnames: deriveWorkerRouteHosts(ctx.runtimeConfig.baseUrl),
 * });
 * ```
 */
export async function IterateAppWorker<B extends Bindings>(
  ctx: IterateCtx,
  props: IterateAppProps<B>,
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
      // falling through to the next one. The local-dev flow writes a specific
      // port into the discovery file, so silent drift would leave CLIs and
      // tests pointing at the wrong local server.
      command:
        "pnpm exec vite dev --config vite.config.ts --strictPort --host ${HOST:-127.0.0.1} --port ${PORT:-5173}",
    },
  });

  return worker;
}

/**
 * Ensure routes + DNS for a deployed worker. Idempotent and create-only:
 * routes are never deleted here or anywhere else (see the module docstring
 * for why), so on a slot that has been deployed before this is a read + probe
 * pass with zero mutations. Call AFTER `app.finalize()`. No-op in local mode.
 *
 * Worker routes tell Cloudflare "send requests matching this pattern to this
 * worker", but the hostname still needs a proxied DNS record — originless
 * dummy A/AAAA records so Cloudflare terminates DNS/TLS and invokes the route
 * without trying to reach an origin. Routes are created only after the script
 * is visible to the API (Cloudflare rejects routes for unknown scripts), and
 * every hostname — including `*.` wildcards, via a synthetic probe host — is
 * verified to actually fire at the edge, healing zombies by recreation.
 * https://developers.cloudflare.com/workers/configuration/routing/routes/#subdomains-must-have-a-dns-record
 */
export async function IterateRoutes(
  ctx: IterateRoutesCtx,
  props: {
    hostnames: string[];
    /** The worker the routes point at — only the deployed script name is used. */
    worker: { name: string };
  },
) {
  if (ctx.app.local || props.hostnames.length === 0) return;
  await ensureWorkerRoutesAndDns({
    comment: `Managed by ${ctx.slug} alchemy (${ctx.app.stage}).`,
    hostnames: props.hostnames,
    scriptName: props.worker.name,
  });
}

/**
 * Re-park a slot's edge after its stage was destroyed: upload a placeholder
 * script under the routed worker's name (only when no script exists — a live
 * deployment is never clobbered) and re-ensure DNS + routes against it.
 *
 * This exists because routes cannot outlive their script: force-deleting a
 * worker CASCADES and deletes its zone routes, and re-uploading a same-named
 * script does not bring them back (verified empirically against
 * iterate-preview-9.com, 2026-07-03 — the hostname 522s indefinitely). So a
 * teardown that stopped at `alchemy --destroy` would push route re-creation
 * onto the next tenant's deploy, which is exactly the edge-propagation
 * lottery behind the post-deploy 522s. Parking instead recreates and VERIFIES
 * the routes at teardown time, when nobody is waiting; the next PR's deploy
 * then finds live routes and only re-uploads script code.
 *
 * Wired as `alchemy.run.ts --park`, chained after `--destroy` (alchemy exits
 * the process inside the destroy phase, so this must be a separate run).
 */
export async function parkWorkerRoutes(input: {
  hostnames: string[];
  /** App slug + stage, for DNS/route comments and the placeholder body. */
  slug: string;
  stage: string;
  workerName: string;
}) {
  const cloudflareApi = await createCloudflareApi({});
  const settingsResponse = await cloudflareApi.get(
    `/accounts/${cloudflareApi.accountId}/workers/scripts/${encodeURIComponent(input.workerName)}/settings`,
  );
  if (settingsResponse.status === 404) {
    const metadata = new Blob(
      [JSON.stringify({ main_module: "index.mjs", compatibility_date: "2025-05-01" })],
      { type: "application/json" },
    );
    const script = new Blob(
      [
        `export default { fetch() { return new Response(` +
          `${JSON.stringify(`${input.slug} (${input.stage}) is parked between deployments.\n`)}, ` +
          `{ status: 503, headers: { "content-type": "text/plain" } }); } };`,
      ],
      { type: "application/javascript+module" },
    );
    const form = new FormData();
    form.append("metadata", metadata);
    form.append("index.mjs", script, "index.mjs");
    const uploadResponse = await cloudflareApi.put(
      `/accounts/${cloudflareApi.accountId}/workers/scripts/${encodeURIComponent(input.workerName)}`,
      form,
    );
    if (!uploadResponse.ok) {
      throw new Error(
        `Failed to upload parked placeholder for ${input.workerName}: ${uploadResponse.status} ${await uploadResponse.text()}`,
      );
    }
    console.log(`[iterate-routes] parked ${input.workerName} with a placeholder script`);
  } else if (!settingsResponse.ok) {
    throw new Error(
      `Failed to check worker script ${input.workerName} before parking: ${settingsResponse.status} ${await settingsResponse.text()}`,
    );
  } else {
    console.log(
      `[iterate-routes] ${input.workerName} still has a deployed script — keeping it, only ensuring routes`,
    );
  }

  await ensureWorkerRoutesAndDns({
    comment: `Managed by ${input.slug} alchemy (${input.stage}).`,
    hostnames: input.hostnames,
    scriptName: input.workerName,
  });
}

async function ensureWorkerRoutesAndDns(input: {
  comment: string;
  hostnames: string[];
  scriptName: string;
}) {
  const cloudflareApi = await createCloudflareApi({});
  const zones = await listCloudflareZones(cloudflareApi);

  const routeZoneIds = new Map<string, string>();
  for (const hostname of input.hostnames) {
    const { zoneId } = findActiveZoneForHostname({
      accountId: cloudflareApi.accountId,
      hostname,
      zones,
    });
    routeZoneIds.set(hostname, zoneId);
  }

  // DNS records BEFORE routes. A Worker route only fires for hostnames with
  // a proxied DNS record on the zone. Creating the route while the record
  // does not exist yet has produced zombie routes on fresh preview slots:
  // the route is visible in the API but never fires at the edge, so every
  // request falls through to the (originless) placeholder record and dies
  // with a 522 after ~20s (tasks/os-cold-create-latency.md). The verification
  // pass below heals any zombie that slips through regardless of order.
  const dnsRouteHosts = input.hostnames.filter(shouldCreateDnsRecordForRouteHostname);
  await Promise.all(
    dnsRouteHosts.flatMap((hostname) =>
      placeholderDnsRecordsForHostname({
        comment: input.comment,
        hostname,
      }).map(async (record) => {
        const zoneId =
          routeZoneIds.get(record.name) ??
          findActiveZoneForHostname({
            accountId: cloudflareApi.accountId,
            hostname: record.name,
            zones,
          }).zoneId;
        await ensureCloudflareDnsRecord({
          cloudflareApi,
          record,
          zoneId,
        });
      }),
    ),
  );

  const routesByZone = new Map<string, ExistingCloudflareWorkerRoute[]>();
  for (const zoneId of new Set(routeZoneIds.values())) {
    routesByZone.set(zoneId, await listCloudflareWorkerRoutes({ cloudflareApi, zoneId }));
  }

  // Create-if-missing / repoint-if-wrong-script. The script-visibility wait
  // and the 10019 retry only run when a route is actually being created —
  // the ordinary deploy finds every route already present and skips both.
  let waitedForScript = false;
  for (const hostname of input.hostnames) {
    const zoneId = routeZoneIds.get(hostname)!;
    const pattern = `${hostname}/*`;
    const existing = routesByZone.get(zoneId)!.find((route) => route.pattern === pattern);
    if (existing?.script === input.scriptName) continue;

    if (existing) {
      console.warn(
        `[iterate-routes] ${pattern} pointed at ${existing.script ?? "<none>"} — repointing to ${input.scriptName}`,
      );
      const response = await cloudflareApi.put(`/zones/${zoneId}/workers/routes/${existing.id}`, {
        pattern,
        script: input.scriptName,
      });
      if (!response.ok) {
        throw new Error(
          `Failed to repoint route ${pattern}: ${response.status} ${await response.text()}`,
        );
      }
      continue;
    }

    if (!waitedForScript) {
      await waitForCloudflareWorkerScript({
        cloudflareApi,
        workerName: input.scriptName,
      });
      waitedForScript = true;
    }
    console.log(`[iterate-routes] creating route ${pattern} -> ${input.scriptName}`);
    await createWorkerRouteWithRetry({
      cloudflareApi,
      pattern,
      script: input.scriptName,
      zoneId,
    });
  }

  // Verify every hostname actually fires at the edge and heal zombies.
  // Wildcards are probed through a synthetic child host resolved by the
  // wildcard DNS record ensured above — previously the biggest verification
  // gap: a zombie `*.<base>` project-host route sailed through deploys and
  // 522'd the first real project request.
  await Promise.all(
    input.hostnames.map((hostname) => {
      const probeHostname = probeHostnameForRoutePattern(hostname);
      if (!probeHostname) return undefined;
      return verifyWorkerRouteFires({
        cloudflareApi,
        probeHostname,
        routeHostname: hostname,
        script: input.scriptName,
        zoneId: routeZoneIds.get(hostname)!,
      });
    }),
  );
}

/**
 * The hostname to probe to prove a route pattern fires at the edge.
 *
 * Exact hostnames probe themselves. `*.base` wildcards probe a synthetic
 * child host (resolvable via the wildcard DNS record the ensure pass
 * creates). `*base` catch-alls have no probeable hostname of their own — the
 * exact `base` route ensured alongside them covers the apex.
 */
function probeHostnameForRoutePattern(hostname: string): string | null {
  if (hostname.startsWith("*.")) return `iterate-route-probe.${hostname.slice(2)}`;
  if (hostname.startsWith("*")) return null;
  return hostname;
}

/**
 * HTTP statuses the Cloudflare edge returns when a request to a proxied
 * hostname falls through to the origin instead of a Worker route. Our route
 * hostnames sit on originless placeholder records (192.0.2.1 / 100::), so any
 * of these means the route exists in the API but is NOT firing at the edge.
 */
const ORIGIN_FALLTHROUGH_STATUSES = new Set([521, 522, 523, 530]);

/**
 * Probe a route hostname and, when the edge answers with an origin-error
 * status (route not firing — the zombie-route failure mode), heal it by
 * deleting and recreating the identical route via the raw API. Recreation has
 * been observed to activate a zombie route instantly.
 */
async function verifyWorkerRouteFires(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  /** The hostname to fetch — differs from routeHostname for wildcards. */
  probeHostname: string;
  /** The hostname of the route pattern, used when healing. */
  routeHostname: string;
  script: string;
  zoneId: string;
}) {
  const maxAttempts = 3;
  let healed = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let status = await probeEdgeStatus(input.probeHostname);
    // Any worker/app response (including app-level 4xx/5xx) proves the route
    // fires. A network-level probe failure is inconclusive (local DNS lag,
    // egress hiccup) — do not fail the deploy over it.
    if (status === null || !ORIGIN_FALLTHROUGH_STATUSES.has(status)) {
      if (!healed) return;
      // A heal propagates across the edge over a few seconds; one good probe
      // can race it. Require a second good probe so the deploy only reports
      // success once the hostname is consistently served.
      await sleep(5_000);
      status = await probeEdgeStatus(input.probeHostname);
      if (status === null || !ORIGIN_FALLTHROUGH_STATUSES.has(status)) return;
      // Fell back to origin again — keep healing.
    }

    console.warn(
      `[iterate-routes] ${input.probeHostname} answered ${status} — route ${input.routeHostname}/* exists but is not firing at the edge; recreating it (attempt ${attempt}/${maxAttempts})`,
    );
    await recreateWorkerRoute(input);
    healed = true;
    await sleep(2_000);
  }

  const status = await probeEdgeStatus(input.probeHostname);
  if (status !== null && ORIGIN_FALLTHROUGH_STATUSES.has(status)) {
    throw new Error(
      `Worker route for ${input.routeHostname} never became active: the edge keeps answering ${status} (origin fallthrough) after ${maxAttempts} recreations.`,
    );
  }
}

/** GET the hostname root; returns the HTTP status, or null when the probe itself failed. */
async function probeEdgeStatus(hostname: string): Promise<number | null> {
  try {
    const response = await fetch(`https://${hostname}/`, {
      redirect: "manual",
      // A non-firing route 522s after ~20s of origin connect timeout; give the
      // probe enough headroom to observe that instead of aborting into null.
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

async function recreateWorkerRoute(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  routeHostname: string;
  script: string;
  zoneId: string;
}) {
  const pattern = `${input.routeHostname}/*`;
  const existingRoutes = await listCloudflareWorkerRoutes({
    cloudflareApi: input.cloudflareApi,
    zoneId: input.zoneId,
  });
  const existing = existingRoutes.find((route) => route.pattern === pattern);
  if (existing) {
    const deleteResponse = await input.cloudflareApi.delete(
      `/zones/${input.zoneId}/workers/routes/${existing.id}`,
    );
    if (!deleteResponse.ok) {
      throw new Error(
        `Failed to delete zombie route ${pattern}: ${deleteResponse.status} ${await deleteResponse.text()}`,
      );
    }
  }
  const createResponse = await input.cloudflareApi.post(`/zones/${input.zoneId}/workers/routes`, {
    pattern,
    script: input.script,
  });
  if (!createResponse.ok) {
    throw new Error(
      `Failed to recreate route ${pattern}: ${createResponse.status} ${await createResponse.text()}`,
    );
  }
}

/** A zone worker route as the Cloudflare API returns it. */
type ExistingCloudflareWorkerRoute = {
  id: string;
  pattern?: string;
  script?: string;
};

async function listCloudflareWorkerRoutes(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  zoneId: string;
}): Promise<ExistingCloudflareWorkerRoute[]> {
  const response = await input.cloudflareApi.get(`/zones/${input.zoneId}/workers/routes`);
  if (!response.ok) {
    throw new Error(
      `Failed to list worker routes for zone ${input.zoneId}: ${response.status} ${await response.text()}`,
    );
  }
  const result = (await response.json()) as { result?: ExistingCloudflareWorkerRoute[] };
  return result.result ?? [];
}

function placeholderDnsRecordsForHostname(input: {
  comment: string;
  hostname: string;
}): DesiredCloudflareDnsRecord[] {
  return [
    {
      type: "A",
      name: input.hostname,
      content: "192.0.2.1",
      proxied: true,
      ttl: 1,
      comment: input.comment,
    },
    {
      type: "AAAA",
      name: input.hostname,
      content: "100::",
      proxied: true,
      ttl: 1,
      comment: input.comment,
    },
  ];
}

/**
 * Ensure proxied originless DNS records exist for hostnames served by
 * something other than an app worker route (apps/tunnels points wildcard
 * tunnel hosts at its own worker routes declared inline). Apps deployed via
 * {@link IterateRoutes} get this automatically.
 */
export async function ensureProxiedDnsForHostnames(input: {
  hostnames: readonly string[];
  comment: string;
}) {
  if (input.hostnames.length === 0) return;
  const cloudflareApi = await createCloudflareApi({});
  const zones = await listCloudflareZones(cloudflareApi);
  await Promise.all(
    input.hostnames.flatMap((hostname) =>
      placeholderDnsRecordsForHostname({ comment: input.comment, hostname }).map(async (record) => {
        const zoneId = findActiveZoneForHostname({
          accountId: cloudflareApi.accountId,
          hostname: record.name,
          zones,
        }).zoneId;
        await ensureCloudflareDnsRecord({
          cloudflareApi,
          record,
          zoneId,
        });
      }),
    ),
  );
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
    type: "A" | "AAAA";
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
    result?: ExistingCloudflareDnsRecord[];
  };
  const plan = planCloudflareDnsRecordReconciliation({
    desired: input.record,
    existing: listResult.result || [],
  });
  if (plan.action === "keep") return;

  const response = plan.recordId
    ? await input.cloudflareApi.put(
        `/zones/${input.zoneId}/dns_records/${plan.recordId}`,
        input.record,
      )
    : await input.cloudflareApi.post(`/zones/${input.zoneId}/dns_records`, input.record);

  if (!response.ok) {
    throw new Error(
      `Failed to upsert DNS record ${input.record.name}: ${response.status} ${await response.text()}`,
    );
  }

  await Promise.all(
    plan.deleteRecordIds.map(async (recordId) => {
      const deleteResponse = await input.cloudflareApi.delete(
        `/zones/${input.zoneId}/dns_records/${recordId}`,
      );
      if (!deleteResponse.ok) {
        throw new Error(
          `Failed to delete duplicate DNS record ${input.record.name}: ${deleteResponse.status} ${await deleteResponse.text()}`,
        );
      }
    }),
  );
}

type ExistingCloudflareDnsRecord = {
  content?: string;
  id: string;
  name?: string;
  proxied?: boolean;
  type?: string;
};

type DesiredCloudflareDnsRecord = {
  comment: string;
  content: string;
  name: string;
  proxied: boolean;
  ttl: number;
  type: "A" | "AAAA";
};

export function planCloudflareDnsRecordReconciliation(input: {
  desired: DesiredCloudflareDnsRecord;
  existing: ExistingCloudflareDnsRecord[];
}): { action: "keep" } | { action: "upsert"; deleteRecordIds: string[]; recordId: string | null } {
  const sameName = input.existing.filter((record) => record.name === input.desired.name);
  const proxiedSameName = sameName.filter((record) => record.proxied === true);

  // A proxied CNAME or non-address shape is already enough to put the hostname on
  // Cloudflare's edge. Leave it alone to avoid fighting hand-managed origins.
  if (
    proxiedSameName.some(
      (record) =>
        record.type !== "A" && record.type !== "AAAA" && record.type !== input.desired.type,
    )
  ) {
    return { action: "keep" };
  }

  const sameType = sameName.filter((record) => record.type === input.desired.type);
  const desiredRecord = sameType.find(
    (record) =>
      record.proxied === input.desired.proxied && record.content === input.desired.content,
  );
  if (desiredRecord && sameType.length === 1) return { action: "keep" };

  const target = desiredRecord || sameType[0];
  return {
    action: "upsert",
    deleteRecordIds: sameType
      .filter((record) => record.id !== target?.id)
      .map((record) => record.id),
    recordId: target?.id || null,
  };
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
  const cleanHostname = input.hostname.replace(/^\*\.?/, "");
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
 * script before creating zone routes for it. Only runs when a route is
 * actually about to be created — on the first deploy of a fresh hostname or
 * when re-parking a torn-down slot.
 *
 * Alchemy's worker resources return after the upload step, but in CI we have
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

async function createWorkerRouteWithRetry(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  pattern: string;
  script: string;
  zoneId: string;
}) {
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await input.cloudflareApi.post(`/zones/${input.zoneId}/workers/routes`, {
      pattern: input.pattern,
      script: input.script,
    });
    if (response.ok) return;
    const body = await response.text();
    // 10019 "Worker which does not exist": the Routes API can lag the Scripts
    // API by a few seconds right after an upload — retry, everything else is
    // a real error.
    const scriptNotVisibleYet = body.includes("10019") && attempt < maxAttempts;
    if (!scriptNotVisibleYet) {
      throw new Error(`Failed to create route ${input.pattern}: ${response.status} ${body}`);
    }
    await sleep(2_000);
  }
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
export function deriveWorkerRouteHosts(
  baseUrl: string | undefined,
  extraRouteHostnames: string[] = [],
) {
  const baseUrlHostname = baseUrl ? new URL(baseUrl).hostname : undefined;
  return [
    ...new Set([...(baseUrlHostname ? [baseUrlHostname] : []), ...extraRouteHostnames]),
  ].filter((hostname) => !hostname.endsWith(".workers.dev"));
}
