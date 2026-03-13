import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
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
  type ServiceAppEnv,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { ORPCError, implement } from "@orpc/server";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { createServer as createViteServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { reconcileCaddyConfig } from "./caddy-sync.ts";
import { ServicesStore } from "./db.ts";
import { ResolvePublicUrlError, resolvePublicUrl } from "./resolve-public-url.ts";

type RegistryEnv = ReturnType<typeof registryServiceEnvSchema.parse>;

interface RegistryContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
  store: ServicesStore;
  env: RegistryEnv;
}

// These will eventually be run with a service registry wrapper that registers them
// with the service registry. But in the meantime we have this
const SEEDED_ROUTE_DEFINITIONS = [
  {
    host: "home.iterate.localhost",
    target: "127.0.0.1:19030",
  },
  {
    host: "events.iterate.localhost",
    target: "127.0.0.1:17320",
  },
  {
    host: "openobserve.iterate.localhost",
    target: "127.0.0.1:5080",
    caddyDirectives: [
      // Keep local sandbox login friction-free.
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

const CADDY_CONFIG_DIR = "/home/iterate/.iterate/caddy";
const CADDY_ROOT_CADDYFILE = `${CADDY_CONFIG_DIR}/Caddyfile`;
const CADDY_BIN_PATH = "/usr/local/bin/caddy";
const CADDY_ADMIN_URL = "http://127.0.0.1:2019";
const CADDY_LISTEN_ADDRESS = ":80";

let storePromise: Promise<ServicesStore> | null = null;
let envCache: RegistryEnv | null = null;

const registryRuntimeDefaults = {
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
  });
  return envCache;
}

async function ensureStore(): Promise<ServicesStore> {
  if (!storePromise) {
    storePromise = ServicesStore.open(getEnv().REGISTRY_DB_PATH);
  }
  return await storePromise;
}

const serviceName = "jonasland-registry-service";
const viteServiceRoot = fileURLToPath(new URL("..", import.meta.url));
const viteUiRoot = fileURLToPath(new URL("./ui", import.meta.url));
const viteUiIndexHtmlPath = fileURLToPath(new URL("./ui/index.html", import.meta.url));
const viteUiPackageRoot = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url));
const viteUiGlobalsCss = `${viteUiPackageRoot}/styles/globals.css`;
const viteFsAllow = [
  "/",
  searchForWorkspaceRoot(viteServiceRoot),
  viteUiRoot,
  viteUiPackageRoot,
  "/opt/packages",
  "/opt/packages/ui",
  fileURLToPath(new URL("../../../packages", import.meta.url)),
];
const PACKAGE_FS_PREFIX = "/@fs/opt/packages/";
const PACKAGE_ROOT = "/opt/packages/";

function contentTypeForPath(filePath: string): string {
  const contentTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".ts": "text/javascript; charset=utf-8",
    ".tsx": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jsx": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  return contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

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
    caddyConfigDir: CADDY_CONFIG_DIR,
    rootCaddyfilePath: CADDY_ROOT_CADDYFILE,
    caddyBinPath: CADDY_BIN_PATH,
    iterateIngressHost: params.env.ITERATE_INGRESS_HOST,
    iterateIngressRoutingType: params.env.ITERATE_INGRESS_ROUTING_TYPE,
    iterateIngressDefaultService: params.env.ITERATE_INGRESS_DEFAULT_SERVICE,
    forceReload: params.forceReload,
  });

  return {
    routes,
    result,
  };
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

  return {
    route,
    routes: sync.routes,
    sync: sync.result,
  };
}

async function removeRouteAndSynchronize(params: { host: string; context: RegistryContext }) {
  const removed = await params.context.store.removeRoute(params.host);
  const sync = await synchronizeCaddyFromStore({
    store: params.context.store,
    env: params.context.env,
  });

  return {
    removed,
    routes: sync.routes,
    sync: sync.result,
  };
}

async function handleCaddyLoadInvocation(params: {
  input: {
    listenAddress?: string;
    adminUrl?: string;
    apply?: boolean;
  };
  context: RegistryContext;
}) {
  const listenAddress = params.input.listenAddress ?? CADDY_LISTEN_ADDRESS;
  const adminUrl = params.input.adminUrl ?? CADDY_ADMIN_URL;
  const routes = await params.context.store.listRoutes();
  const payload = {
    note: "registry now uses caddy validate/reload with file fragments in the fixed caddy config directory",
    listenAddress,
    routeHosts: routes.map((route) => route.host),
    caddyConfigDir: CADDY_CONFIG_DIR,
    caddyRootCaddyfile: CADDY_ROOT_CADDYFILE,
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

async function ensureInitialCaddySynchronization(params: {
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

async function ensureSeededRoutes(params: { store: ServicesStore }): Promise<void> {
  // Seed built-in platform services that do not yet run through a service wrapper
  // with automatic registry registration. Aspiration: all of these eventually
  // self-register, making this seed list unnecessary.
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
          ITERATE_INGRESS_HOST: context.env.ITERATE_INGRESS_HOST,
          ITERATE_INGRESS_ROUTING_TYPE: context.env.ITERATE_INGRESS_ROUTING_TYPE,
          ITERATE_INGRESS_DEFAULT_SERVICE: context.env.ITERATE_INGRESS_DEFAULT_SERVICE,
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
      const { route, routes, sync } = await upsertRouteAndSynchronize({
        input,
        context,
      });
      infoFromContext(context, "registry.routes.upsert", {
        host: route.host,
        route_count: routes.length,
        caddy_reloaded: sync.reloaded,
        caddy_changed_files: sync.changedFiles.length,
        caddy_removed_files: sync.removedFiles.length,
      });
      return {
        route,
        routeCount: routes.length,
      };
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
      return {
        removed,
        routeCount: routes.length,
      };
    }),
    list: os.routes.list.handler(async ({ context }) => {
      const routes = await context.store.listRoutes();
      return {
        routes,
        total: routes.length,
      };
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
      return {
        found: entry !== null,
        ...(entry ? { entry } : {}),
      };
    }),
    set: os.config.set.handler(async ({ input, context }) => {
      const entry = await context.store.setConfig({ key: input.key, value: input.value });
      return { entry };
    }),
    list: os.config.list.handler(async ({ context }) => {
      const entries = await context.store.listConfig();
      return {
        entries,
        total: entries.length,
      };
    }),
  },
});

export async function startRegistryService(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const env = getEnv();
  const host = options?.host ?? env.REGISTRY_SERVICE_HOST;
  const port = options?.port ?? env.REGISTRY_SERVICE_PORT;
  const store = await ensureStore();

  const openAPIHandler = createServiceOpenAPIHandler({
    router: registryRouter,
    title: "jonasland registry-service API",
    version: registryServiceManifest.version,
  });
  const wsHandler = new WebSocketRPCHandler(registryRouter);
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    const requestId = randomUUID();
    void wsHandler.upgrade(ws, {
      context: {
        requestId,
        serviceName,
        log: createServiceRequestLogger({ requestId, method: "WS", path: "/orpc/ws" }),
        store,
        env,
      },
    });
  });

  const app = new Hono<ServiceAppEnv>();
  applyServiceMiddleware(app);

  app.get("/", async (c) => {
    const html = await readFile(viteUiIndexHtmlPath, "utf8");
    return c.html(html);
  });

  app.get("/@fs/opt/packages/*", async (c) => {
    const url = new URL(c.req.raw.url, "http://localhost");
    const relativePath = url.pathname.slice(PACKAGE_FS_PREFIX.length);
    const normalizedPath = relativePath.replaceAll("..", "");
    const absolutePath = `${PACKAGE_ROOT}${normalizedPath}`;

    try {
      if (vite) {
        const transformed = await vite.transformRequest(`${absolutePath}${url.search}`);
        if (transformed) {
          return c.newResponse(transformed.code, {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              ...(transformed.etag ? { etag: transformed.etag } : {}),
            },
          });
        }
      }

      const body = await readFile(absolutePath);
      return c.newResponse(body, {
        status: 200,
        headers: {
          "content-type": contentTypeForPath(absolutePath),
          "cache-control": "no-cache",
        },
      });
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
  });

  app.get("/api/ingress-env", async (c) =>
    c.json({
      ITERATE_INGRESS_HOST: env.ITERATE_INGRESS_HOST ?? null,
      ITERATE_INGRESS_ROUTING_TYPE: env.ITERATE_INGRESS_ROUTING_TYPE,
      ITERATE_INGRESS_DEFAULT_SERVICE: env.ITERATE_INGRESS_DEFAULT_SERVICE,
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

  app.use("*", async (c) => {
    if (!vite) return c.json({ error: "vite_not_ready" }, 503);

    await new Promise<void>((resolve) => {
      vite!.middlewares(c.env.incoming, c.env.outgoing, () => {
        if (!c.env.outgoing.writableEnded) {
          c.env.outgoing.writeHead(404, { "content-type": "application/json" });
          c.env.outgoing.end(JSON.stringify({ error: "not_found" }));
        }
        resolve();
      });
    });

    return RESPONSE_ALREADY_SENT;
  });

  const server = createAdaptorServer({ fetch: app.fetch });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/orpc/ws" || pathname === "/orpc/ws/") {
      serviceLog.info({ event: "orpc.ws.upgrade", pathname });
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  let vite: ViteDevServer | null = null;
  vite = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL("./ui", import.meta.url)),
    cacheDir: "/tmp/vite-registry-service",
    resolve: {
      alias: [
        { find: "@iterate-com/ui/globals.css", replacement: viteUiGlobalsCss },
        { find: "@iterate-com/ui/styles.css", replacement: viteUiGlobalsCss },
        {
          find: "@iterate-com/ui/components",
          replacement: `${viteUiPackageRoot}/components`,
        },
        { find: "@iterate-com/ui/lib", replacement: `${viteUiPackageRoot}/lib` },
        { find: "@iterate-com/ui/hooks", replacement: `${viteUiPackageRoot}/hooks` },
        { find: "@iterate-com/ui", replacement: `${viteUiPackageRoot}/index.ts` },
      ],
    },
    plugins: [tailwindcss(), react()],
    optimizeDeps: {
      exclude: ["fsevents", "lightningcss"],
    },
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: {
        server: server as unknown as import("node:http").Server,
      },
      fs: {
        strict: false,
        allow: viteFsAllow,
      },
    },
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  await ensureSeededRoutes({ store });

  await ensureInitialCaddySynchronization({ store, env });

  serviceLog.info({
    event: "service.started",
    service: serviceName,
    host,
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    orpc_path: "/orpc",
    orpc_ws_path: "/orpc/ws",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });

  return {
    close: async () => {
      await Promise.allSettled([
        vite?.close(),
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
      ]);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await store.close();
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startRegistryService().catch(() => {
    process.exit(1);
  });
}
