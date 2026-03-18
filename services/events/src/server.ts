import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { serviceManifest } from "@iterate-com/events-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceObservabilityHandler,
  createServiceOpenAPIHandler,
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  registerServiceWithRegistry,
  serviceLog,
  type ServiceAppEnv,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { createServer as createViteServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { getEventsDbRuntimeConfig } from "./db.ts";
import { disposeEventsRouterOperations, eventsRouter } from "./router.ts";

const serviceName = "jonasland-events-service";
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
const port = Number(process.env.PORT) || serviceManifest.port;
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

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const openAPIHandler = createServiceOpenAPIHandler({
  router: eventsRouter,
  title: "jonasland events-service API",
  version: serviceManifest.version,
});

const rpcHandler = new RPCHandler(eventsRouter);
const wsHandler = new WebSocketRPCHandler(eventsRouter);
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
    },
  });
});

const app = new Hono<ServiceAppEnv>();
applyServiceMiddleware(app);

app.get("/api/observability", createServiceObservabilityHandler(getEventsDbRuntimeConfig));

app.get("/", async (c) => {
  const html = await readFile(viteUiIndexHtmlPath, "utf8");
  return c.html(html);
});

app.all("/orpc/*", async (c) => {
  const context = {
    requestId: c.get("requestId"),
    serviceName,
    log: c.get("requestLog"),
  };
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/orpc",
    context,
  });
  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

applyOpenAPIRoute(app, openAPIHandler, serviceName);

app.get("/@fs/opt/packages/*", async (c) => {
  const url = new URL(c.req.raw.url, "http://localhost");
  const relativePath = url.pathname.slice(PACKAGE_FS_PREFIX.length);
  const normalizedPath = relativePath.replaceAll("..", "");
  const absolutePath = `${PACKAGE_ROOT}${normalizedPath}`;

  try {
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

app.use("*", async (c) => {
  await new Promise<void>((resolve) => {
    vite.middlewares(c.env.incoming, c.env.outgoing, () => {
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
  const protocolHeader = req.headers["sec-websocket-protocol"] as string | string[] | undefined;
  const protocolValue: string = Array.isArray(protocolHeader)
    ? protocolHeader.join(",")
    : (protocolHeader ?? "");
  const isViteUpgrade = protocolValue
    .split(",")
    .map((value: string) => value.trim())
    .some((value: string) => value === "vite-hmr" || value === "vite-ping");

  if (pathname === "/orpc/ws" || pathname === "/orpc/ws/") {
    serviceLog.info({ event: "orpc.ws.upgrade", pathname });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }

  if (!isViteUpgrade) {
    socket.destroy();
  }
});

const vite: ViteDevServer = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  cacheDir: "/tmp/vite-events-service",
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
    allowedHosts: true,
    middlewareMode: true,
    hmr: {
      server: server as unknown as HttpServer,
    },
    fs: {
      strict: false,
      allow: viteFsAllow,
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**"],
    },
  },
});

server.listen(port, "0.0.0.0", () => {
  serviceLog.info({
    event: "service.started",
    service: serviceName,
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    orpc_path: "/orpc",
    orpc_ws_path: "/orpc/ws",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });

  void getEventsDbRuntimeConfig().then((runtime) =>
    registerServiceWithRegistry({
      manifest: serviceManifest,
      port,
      metadata: {
        openapiPath: "/api/openapi.json",
        title: "Events Service",
        sqlitePath: runtime.path,
        sqliteAlias: "events",
      },
      tags: ["openapi", "events", "sqlite"],
    }),
  );
});

const shutdown = async () => {
  await Promise.allSettled([
    vite.close(),
    disposeEventsRouterOperations(),
    new Promise<void>((resolve) => {
      wss.close(() => resolve());
    }),
  ]);

  server.close(() => process.exit(0));
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
