import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CaddyClient, buildHostRoute } from "@accelerated-software-development/caddy-api-client";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {
  registryContract,
  registryServiceEnvSchema,
  registryServiceManifest,
} from "@iterate-com/registry-contract";
import {
  createOrpcErrorInterceptor,
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  infoFromContext,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
  transformSqlResultSet,
  type ServiceRequestLogger,
} from "@iterate-com/jonasland-shared";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { createServer as createViteServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { ServicesStore } from "./db.ts";

type RegistryEnv = ReturnType<typeof registryServiceEnvSchema.parse>;

interface RegistryContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
  store: ServicesStore;
  env: RegistryEnv;
}

function buildCaddyLoadPayload(params: {
  routes: Array<{
    host: string;
    target: string;
  }>;
  listenAddress: string;
}): Record<string, unknown> {
  const staticRoutes: unknown[] = [
    buildHostRoute({ host: "pidnap.iterate.localhost", dial: "127.0.0.1:9876" }),
    buildHostRoute({ host: "registry.iterate.localhost", dial: "127.0.0.1:8777" }),
    buildHostRoute({ host: "docs.iterate.localhost", dial: "127.0.0.1:19050" }),
    buildHostRoute({ host: "home.iterate.localhost", dial: "127.0.0.1:19030" }),
    buildHostRoute({ host: "outerbase.iterate.localhost", dial: "127.0.0.1:19040" }),
    buildHostRoute({ host: "caddy-admin.iterate.localhost", dial: "127.0.0.1:2019" }),
  ];

  const dynamicRoutes = params.routes.map((route) =>
    buildHostRoute({
      host: route.host,
      dial: route.target,
    }),
  );

  return {
    admin: {
      listen: "0.0.0.0:2019",
      origins: ["*"],
    },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [params.listenAddress],
            routes: [
              ...staticRoutes,
              ...dynamicRoutes,
              {
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "127.0.0.1:19000" }],
                  },
                ],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  };
}

let storePromise: Promise<ServicesStore> | null = null;
let envCache: RegistryEnv | null = null;

function getEnv() {
  envCache ??= registryServiceEnvSchema.parse(process.env);
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
const viteUiPackageRoot = fileURLToPath(
  new URL("../../../packages/jonasland-ui/src", import.meta.url),
);
const viteUiGlobalsCss = `${viteUiPackageRoot}/styles/globals.css`;
const viteFsAllow = [
  "/",
  searchForWorkspaceRoot(viteServiceRoot),
  viteUiRoot,
  viteUiPackageRoot,
  "/opt/packages",
  "/opt/packages/jonasland-ui",
  fileURLToPath(new URL("../../../packages", import.meta.url)),
];
const PACKAGE_FS_PREFIX = "/@fs/opt/packages/";
const PACKAGE_ROOT = "/opt/packages/";

function contentTypeForPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

const os = implement(registryContract).$context<RegistryContext>();
initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

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
  const payload = buildCaddyLoadPayload({
    routes,
    listenAddress,
  });

  const invocation = {
    method: "POST" as const,
    path: "/load" as const,
    url: `${adminUrl}/load`,
    body: payload,
  };

  if (params.input.apply === true) {
    const caddy = new CaddyClient({ adminUrl });
    const response = await caddy.request(invocation.path, {
      method: invocation.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invocation.body),
    });

    if (!response.ok) {
      throw new Error(`caddy /load failed: ${response.status} ${response.statusText}`);
    }
  }

  return {
    invocation,
    routeCount: routes.length,
    applied: params.input.apply === true,
  };
}

function writeJsonResponse(
  res: import("node:http").ServerResponse,
  statusCode: number,
  body: unknown,
) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object body");
  }

  return parsed as Record<string, unknown>;
}

export const registryRouter = os.router({
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
  },
  routes: {
    upsert: os.routes.upsert.handler(async ({ input, context }) => {
      const route = await context.store.upsertRoute(input);
      const routes = await context.store.listRoutes();
      infoFromContext(context, "registry.routes.upsert", {
        host: route.host,
        route_count: routes.length,
      });
      return {
        route,
        routeCount: routes.length,
      };
    }),
    remove: os.routes.remove.handler(async ({ input, context }) => {
      const removed = await context.store.removeRoute(input.host);
      const routes = await context.store.listRoutes();
      infoFromContext(context, "registry.routes.remove", {
        host: input.host,
        removed,
        route_count: routes.length,
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

  const handler = new RPCHandler(registryRouter, {
    interceptors: [createOrpcErrorInterceptor()],
  });
  const wsHandler = new WebSocketRPCHandler(registryRouter);
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    const requestId = randomUUID();
    void wsHandler.upgrade(ws, {
      context: {
        requestId,
        serviceName,
        log: createServiceRequestLogger({
          requestId,
          method: "WS",
          path: "/orpc/ws",
        }),
        store,
        env,
      },
    });
  });

  let vite: ViteDevServer | null = null;

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const requestLog = createServiceRequestLogger({
      requestId,
      method: req.method,
      path: req.url,
    });

    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;
    const context: RegistryContext = {
      requestId,
      serviceName,
      log: requestLog,
      store,
      env,
    };
    const isApiRequest = pathname === "/api/routes" || pathname.startsWith("/api/");
    const isRpcRequest = pathname === "/orpc" || pathname.startsWith("/orpc/");

    if (pathname.startsWith(PACKAGE_FS_PREFIX)) {
      const relativePath = pathname.slice(PACKAGE_FS_PREFIX.length);
      const normalizedPath = relativePath.replaceAll("..", "");
      const absolutePath = `${PACKAGE_ROOT}${normalizedPath}`;

      try {
        if (vite) {
          const transformed = await vite.transformRequest(`${absolutePath}${requestUrl.search}`);
          if (transformed) {
            res.writeHead(200, {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              ...(transformed.etag ? { etag: transformed.etag } : {}),
            });
            res.end(transformed.code);
            return;
          }
        }

        const body = await readFile(absolutePath);
        res.writeHead(200, {
          "content-type": contentTypeForPath(absolutePath),
          "cache-control": "no-cache",
        });
        res.end(body);
      } catch {
        writeJsonResponse(res, 404, { error: "not_found" });
      }
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
      const html = await readFile(viteUiIndexHtmlPath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (isApiRequest) {
      try {
        if (req.method === "GET" && pathname === "/api/routes") {
          const routes = await store.listRoutes();
          writeJsonResponse(res, 200, { routes, total: routes.length });
          return;
        }

        if (req.method === "POST" && pathname === "/api/routes/upsert") {
          const body = await readJsonBody(req);
          const route = await store.upsertRoute({
            host: String(body.host ?? ""),
            target: String(body.target ?? ""),
            ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
              ? { metadata: body.metadata as Record<string, string> }
              : {}),
            ...(Array.isArray(body.tags) ? { tags: body.tags.map((tag) => String(tag)) } : {}),
          });
          const routes = await store.listRoutes();
          writeJsonResponse(res, 200, { route, routeCount: routes.length });
          return;
        }

        if (req.method === "POST" && pathname === "/api/routes/remove") {
          const body = await readJsonBody(req);
          const host = String(body.host ?? "");
          const removed = await store.removeRoute(host);
          const routes = await store.listRoutes();
          writeJsonResponse(res, 200, { removed, routeCount: routes.length });
          return;
        }

        if (req.method === "POST" && pathname === "/api/routes/caddy-load-invocation") {
          const body = await readJsonBody(req);
          const result = await handleCaddyLoadInvocation({
            input: {
              ...(typeof body.listenAddress === "string"
                ? { listenAddress: body.listenAddress }
                : {}),
              ...(typeof body.adminUrl === "string" ? { adminUrl: body.adminUrl } : {}),
              ...(typeof body.apply === "boolean" ? { apply: body.apply } : {}),
            },
            context,
          });
          writeJsonResponse(res, 200, result);
          return;
        }

        if (req.method === "GET" && pathname === "/api/config") {
          const entries = await store.listConfig();
          writeJsonResponse(res, 200, { entries, total: entries.length });
          return;
        }

        if (req.method === "GET" && pathname.startsWith("/api/config/")) {
          const key = decodeURIComponent(pathname.slice("/api/config/".length));
          if (key.length === 0) {
            writeJsonResponse(res, 400, { error: "invalid_config_key" });
            return;
          }

          const entry = await store.getConfig(key);
          writeJsonResponse(res, 200, {
            found: entry !== null,
            ...(entry ? { entry } : {}),
          });
          return;
        }

        if (req.method === "POST" && pathname.startsWith("/api/config/")) {
          const key = decodeURIComponent(pathname.slice("/api/config/".length));
          if (key.length === 0) {
            writeJsonResponse(res, 400, { error: "invalid_config_key" });
            return;
          }

          const body = await readJsonBody(req);
          const entry = await store.setConfig({ key, value: body.value });
          writeJsonResponse(res, 200, { entry });
          return;
        }

        writeJsonResponse(res, 404, { error: "not_found" });
      } catch (error) {
        writeJsonResponse(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (isRpcRequest) {
      const { matched } = await handler.handle(req, res, {
        prefix: "/orpc",
        context,
      });

      if (!matched) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
      return;
    }

    if (!vite) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vite_not_ready" }));
      return;
    }

    const viteServer = vite;
    await new Promise<void>((resolve, reject) => {
      viteServer.middlewares(req, res, (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!res.writableEnded) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
        }

        resolve();
      });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const protocolValue = Array.isArray(protocolHeader)
      ? protocolHeader.join(",")
      : (protocolHeader ?? "");
    const isViteUpgrade = protocolValue
      .split(",")
      .map((value) => value.trim())
      .some((value) => value === "vite-hmr" || value === "vite-ping");

    if (pathname === "/orpc/ws" || pathname === "/orpc/ws/") {
      serviceLog.info({ event: "orpc.ws.upgrade", pathname });
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    if (!isViteUpgrade) {
      socket.destroy();
    }
  });

  vite = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL("./ui", import.meta.url)),
    cacheDir: "/tmp/vite-registry-service",
    resolve: {
      alias: [
        { find: "@iterate-com/jonasland-ui/globals.css", replacement: viteUiGlobalsCss },
        { find: "@iterate-com/jonasland-ui/styles.css", replacement: viteUiGlobalsCss },
        {
          find: "@iterate-com/jonasland-ui/components",
          replacement: `${viteUiPackageRoot}/components`,
        },
        { find: "@iterate-com/jonasland-ui/lib", replacement: `${viteUiPackageRoot}/lib` },
        { find: "@iterate-com/jonasland-ui/hooks", replacement: `${viteUiPackageRoot}/hooks` },
        { find: "@iterate-com/jonasland-ui", replacement: `${viteUiPackageRoot}/index.ts` },
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
        server,
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

  serviceLog.info({
    event: "service.started",
    service: serviceName,
    host,
    port,
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
          if (error) {
            reject(error);
            return;
          }
          resolve();
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
