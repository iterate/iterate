import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { HttpBindings } from "@hono/node-server";
import type { ServiceAppEnv } from "@iterate-com/shared/jonasland";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  registryContract,
  registryServiceEnvSchema,
  registryServiceManifest,
} from "@iterate-com/registry-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceOpenAPIHandler,
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  infoFromContext,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
  transformSqlResultSet,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { ORPCError, implement } from "@orpc/server";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { reconcileCaddyConfig } from "../caddy-sync.ts";
import { ServicesStore } from "../db.ts";
import { ResolvePublicUrlError, resolvePublicUrl } from "../resolve-public-url.ts";

type RegistryEnv = ReturnType<typeof registryServiceEnvSchema.parse>;

interface RegistryContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
  store: ServicesStore;
  env: RegistryEnv;
}

const SEEDED_ROUTE_DEFINITIONS = [
  {
    host: "events.iterate.localhost",
    target: "127.0.0.1:17320",
  },
  {
    host: "openobserve.iterate.localhost",
    target: "127.0.0.1:5080",
    caddyDirectives: [
      'header_up Authorization "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="',
    ],
  },
  {
    host: "otel-collector.iterate.localhost",
    target: "127.0.0.1:15333",
  },
  {
    host: "frp.iterate.localhost",
    target: "127.0.0.1:27000",
    caddyDirectives: ["stream_close_delay 5m"],
  },
] as const;

let storePromise: Promise<ServicesStore> | null = null;
let envCache: RegistryEnv | null = null;

const registryRuntimeDefaults = {
  CADDY_CONFIG_DIR: "/home/iterate/.iterate/caddy",
  CADDY_ROOT_CADDYFILE: "/home/iterate/.iterate/caddy/Caddyfile",
  CADDY_BIN_PATH: "/usr/local/bin/caddy",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
} as const;

function applyRegistryRuntimeEnvDefaults() {
  for (const [key, value] of Object.entries(registryRuntimeDefaults)) {
    const current = process.env[key];
    if (current === undefined || current.trim().length === 0) {
      process.env[key] = value;
    }
  }
}

function getEnv() {
  envCache ??= registryServiceEnvSchema.parse({
    ...process.env,
    CADDY_CONFIG_DIR: registryRuntimeDefaults.CADDY_CONFIG_DIR,
    CADDY_ROOT_CADDYFILE: registryRuntimeDefaults.CADDY_ROOT_CADDYFILE,
    CADDY_BIN_PATH: registryRuntimeDefaults.CADDY_BIN_PATH,
  });
  return envCache;
}

export async function ensureStore(): Promise<ServicesStore> {
  if (!storePromise) {
    storePromise = ServicesStore.open(getEnv().REGISTRY_DB_PATH);
  }
  return await storePromise;
}

const serviceName = "jonasland-registry-service";
const os = implement(registryContract).$context<RegistryContext>();
applyRegistryRuntimeEnvDefaults();
initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

async function synchronizeCaddyFromStore(params: {
  store: ServicesStore;
  env: RegistryEnv;
  forceReload?: boolean;
}) {
  const routes = await params.store.listRoutes();
  const result = await reconcileCaddyConfig({
    routes,
    caddyConfigDir: params.env.CADDY_CONFIG_DIR,
    rootCaddyfilePath: params.env.CADDY_ROOT_CADDYFILE,
    caddyBinPath: params.env.CADDY_BIN_PATH,
    iteratePublicBaseHost: params.env.ITERATE_PUBLIC_BASE_HOST,
    iteratePublicBaseHostType: params.env.ITERATE_PUBLIC_BASE_HOST_TYPE,
    forceReload: params.forceReload,
  });

  return { routes, result };
}

async function upsertRouteAndSynchronize(params: {
  input: {
    host: string;
    target: string;
    metadata?: Record<string, string>;
    tags?: string[];
    caddyDirectives?: string[];
  };
  context: RegistryContext;
}) {
  const route = await params.context.store.upsertRoute(params.input);
  const sync = await synchronizeCaddyFromStore({
    store: params.context.store,
    env: params.context.env,
  });

  return { route, routes: sync.routes, sync: sync.result };
}

async function removeRouteAndSynchronize(params: { host: string; context: RegistryContext }) {
  const removed = await params.context.store.removeRoute(params.host);
  const sync = await synchronizeCaddyFromStore({
    store: params.context.store,
    env: params.context.env,
  });

  return { removed, routes: sync.routes, sync: sync.result };
}

async function handleCaddyLoadInvocation(params: {
  input: {
    listenAddress?: string;
    adminUrl?: string;
    apply?: boolean;
  };
  context: RegistryContext;
}) {
  const listenAddress = params.input.listenAddress ?? params.context.env.CADDY_LISTEN_ADDRESS;
  const adminUrl = params.input.adminUrl ?? params.context.env.CADDY_ADMIN_URL;
  const routes = await params.context.store.listRoutes();
  const payload = {
    note: "registry now uses caddy validate/reload with file fragments in CADDY_CONFIG_DIR",
    listenAddress,
    routeHosts: routes.map((route) => route.host),
    caddyConfigDir: params.context.env.CADDY_CONFIG_DIR,
    caddyRootCaddyfile: params.context.env.CADDY_ROOT_CADDYFILE,
  };

  const invocation = {
    method: "POST" as const,
    path: "/load" as const,
    url: `${adminUrl}/load`,
    body: payload,
  };

  if (params.input.apply === true) {
    await synchronizeCaddyFromStore({
      store: params.context.store,
      env: params.context.env,
      forceReload: true,
    });
  }

  return {
    invocation,
    routeCount: routes.length,
    applied: params.input.apply === true,
  };
}

export async function ensureInitialCaddySynchronization(params: {
  store: ServicesStore;
  env: RegistryEnv;
}) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const sync = await synchronizeCaddyFromStore({
        store: params.store,
        env: params.env,
        forceReload: true,
      });

      serviceLog.info({
        event: "registry.caddy.initial_sync_ok",
        route_count: sync.routes.length,
        changed_files: sync.result.changedFiles.length,
        removed_files: sync.result.removedFiles.length,
        attempt,
      });
      return;
    } catch (error) {
      lastError = error;
      serviceLog.warn({
        event: "registry.caddy.initial_sync_retry",
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      await sleep(1_000);
    }
  }

  throw new Error("failed initial caddy synchronization", { cause: lastError });
}

export async function ensureSeededRoutes(params: { store: ServicesStore }): Promise<void> {
  for (const route of SEEDED_ROUTE_DEFINITIONS) {
    await params.store.upsertRoute({
      host: route.host,
      target: route.target,
      caddyDirectives: "caddyDirectives" in route ? [...route.caddyDirectives] : [],
      tags: ["seeded"],
      metadata: { source: "registry-seed" },
    });
  }
}

export const registryRouter = os.router({
  getPublicURL: os.getPublicURL.handler(async ({ input, context }) => {
    try {
      return {
        publicURL: resolvePublicUrl({
          ITERATE_PUBLIC_BASE_HOST: context.env.ITERATE_PUBLIC_BASE_HOST,
          ITERATE_PUBLIC_BASE_HOST_TYPE: context.env.ITERATE_PUBLIC_BASE_HOST_TYPE,
          internalURL: input.internalURL,
        }),
      };
    } catch (error) {
      if (error instanceof ResolvePublicUrlError) {
        throw new ORPCError("BAD_REQUEST", {
          message: error.message,
          cause: error,
        });
      }
      throw error;
    }
  }),
  service: {
    health: os.service.health.handler(async ({ context }) => ({
      ok: true,
      service: context.serviceName,
      version: registryServiceManifest.version,
    })),
    sql: os.service.sql.handler(async ({ input, context }) => {
      const startedAt = Date.now();
      const result = transformSqlResultSet(await context.store.executeSql(input.statement));
      infoFromContext(context, "registry.service.sql", {
        service: context.serviceName,
        request_id: context.requestId,
        duration_ms: Date.now() - startedAt,
        rows: result.rows.length,
      });
      return result;
    }),
    debug: os.service.debug.handler(async () => {
      const env: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(process.env)) {
        env[key] = value ?? null;
      }
      const memoryUsage = process.memoryUsage();
      return {
        pid: process.pid,
        ppid: process.ppid,
        uptimeSec: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        hostname: hostname(),
        cwd: process.cwd(),
        execPath: process.execPath,
        argv: process.argv,
        env,
        memoryUsage: {
          rss: memoryUsage.rss,
          heapTotal: memoryUsage.heapTotal,
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
          arrayBuffers: memoryUsage.arrayBuffers,
        },
      };
    }),
  },
  routes: {
    upsert: os.routes.upsert.handler(async ({ input, context }) => {
      const { route, routes, sync } = await upsertRouteAndSynchronize({ input, context });
      infoFromContext(context, "registry.routes.upsert", {
        host: route.host,
        route_count: routes.length,
        caddy_reloaded: sync.reloaded,
        caddy_changed_files: sync.changedFiles.length,
        caddy_removed_files: sync.removedFiles.length,
      });
      return { route, routeCount: routes.length };
    }),
    remove: os.routes.remove.handler(async ({ input, context }) => {
      const { removed, routes, sync } = await removeRouteAndSynchronize({
        host: input.host,
        context,
      });
      infoFromContext(context, "registry.routes.remove", {
        host: input.host,
        removed,
        route_count: routes.length,
        caddy_reloaded: sync.reloaded,
        caddy_changed_files: sync.changedFiles.length,
        caddy_removed_files: sync.removedFiles.length,
      });
      return { removed, routeCount: routes.length };
    }),
    list: os.routes.list.handler(async ({ context }) => {
      const routes = await context.store.listRoutes();
      return { routes, total: routes.length };
    }),
    caddyLoadInvocation: os.routes.caddyLoadInvocation.handler(
      async ({ input, context }) => await handleCaddyLoadInvocation({ input, context }),
    ),
  },
  caddy: {
    loadInvocation: os.caddy.loadInvocation.handler(
      async ({ input, context }) => await handleCaddyLoadInvocation({ input, context }),
    ),
  },
  config: {
    get: os.config.get.handler(async ({ input, context }) => {
      const entry = await context.store.getConfig(input.key);
      return { found: entry !== null, ...(entry ? { entry } : {}) };
    }),
    set: os.config.set.handler(async ({ input, context }) => {
      const entry = await context.store.setConfig({ key: input.key, value: input.value });
      return { entry };
    }),
    list: os.config.list.handler(async ({ context }) => {
      const entries = await context.store.listConfig();
      return { entries, total: entries.length };
    }),
  },
});

const app = new Hono<ServiceAppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);

const store = await ensureStore();
const env = getEnv();

const openAPIHandler = createServiceOpenAPIHandler({
  router: registryRouter,
  title: "jonasland registry-service API",
  version: registryServiceManifest.version,
});

const wsHandler = new WebSocketRPCHandler(registryRouter);

app.get(
  "/orpc/ws",
  upgradeWebSocket(() => ({
    onOpen: (_evt, ws) => {
      const requestId = randomUUID();
      serviceLog.info({ event: "orpc.ws.upgrade", pathname: "/orpc/ws" });
      void wsHandler.upgrade(ws.raw as import("ws").WebSocket, {
        context: {
          requestId,
          serviceName,
          log: createServiceRequestLogger({ requestId, method: "WS", path: "/orpc/ws" }),
          store,
          env,
        },
      });
    },
  })),
);

app.get("/api/ingress-env", async (c) =>
  c.json({
    ITERATE_PUBLIC_BASE_HOST: env.ITERATE_PUBLIC_BASE_HOST ?? null,
    ITERATE_PUBLIC_BASE_HOST_TYPE: env.ITERATE_PUBLIC_BASE_HOST_TYPE,
  }),
);

app.get("/api/routes", async (c) => {
  const routes = await store.listRoutes();
  return c.json({ routes, total: routes.length });
});

app.post("/api/routes/upsert", async (c) => {
  const body = await c.req.json();
  const context: RegistryContext = {
    requestId: c.get("requestId"),
    serviceName,
    log: c.get("requestLog"),
    store,
    env,
  };
  const input = {
    host: String(body.host ?? ""),
    target: String(body.target ?? ""),
    ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? { metadata: body.metadata as Record<string, string> }
      : {}),
    ...(Array.isArray(body.tags) ? { tags: body.tags.map((tag: unknown) => String(tag)) } : {}),
    ...(Array.isArray(body.caddyDirectives)
      ? { caddyDirectives: body.caddyDirectives.map((d: unknown) => String(d)) }
      : {}),
  };
  const { route, routes } = await upsertRouteAndSynchronize({ input, context });
  return c.json({ route, routeCount: routes.length });
});

app.post("/api/routes/remove", async (c) => {
  const body = await c.req.json();
  const context: RegistryContext = {
    requestId: c.get("requestId"),
    serviceName,
    log: c.get("requestLog"),
    store,
    env,
  };
  const hostVal = String(body.host ?? "");
  const { removed, routes } = await removeRouteAndSynchronize({ host: hostVal, context });
  return c.json({ removed, routeCount: routes.length });
});

app.post("/api/routes/caddy-load-invocation", async (c) => {
  const body = await c.req.json();
  const context: RegistryContext = {
    requestId: c.get("requestId"),
    serviceName,
    log: c.get("requestLog"),
    store,
    env,
  };
  const result = await handleCaddyLoadInvocation({
    input: {
      ...(typeof body.listenAddress === "string" ? { listenAddress: body.listenAddress } : {}),
      ...(typeof body.adminUrl === "string" ? { adminUrl: body.adminUrl } : {}),
      ...(typeof body.apply === "boolean" ? { apply: body.apply } : {}),
    },
    context,
  });
  return c.json(result);
});

app.get("/api/config", async (c) => {
  const entries = await store.listConfig();
  return c.json({ entries, total: entries.length });
});

app.get("/api/config/:key", async (c) => {
  const key = decodeURIComponent(c.req.param("key"));
  if (key.length === 0) return c.json({ error: "invalid_config_key" }, 400);
  const entry = await store.getConfig(key);
  return c.json({ found: entry !== null, ...(entry ? { entry } : {}) });
});

app.post("/api/config/:key", async (c) => {
  const key = decodeURIComponent(c.req.param("key"));
  if (key.length === 0) return c.json({ error: "invalid_config_key" }, 400);
  const body = await c.req.json();
  const entry = await store.setConfig({ key, value: body.value });
  return c.json({ entry });
});

applyOpenAPIRoute(app, openAPIHandler, serviceName, {
  extraContext: () => ({ store, env }),
});

export default app;
export { injectWebSocket, store, env, serviceName, getOtelRuntimeConfig };
