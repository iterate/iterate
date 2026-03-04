import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { ROOT_CONTEXT, context as otelContext, propagation } from "@opentelemetry/api";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import {
  createOrpcErrorInterceptor,
  createServiceObservabilityHandler,
  createServiceRequestLogger,
  extractIncomingTraceContext,
  getOtelRuntimeConfig,
  getRequestIdHeader,
  initializeServiceEvlog,
  initializeServiceOtel,
  registerServiceWithRegistry,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";
import { Hono, type Context } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createServer as createViteServer, searchForWorkspaceRoot } from "vite";
import { getExampleDbRuntimeConfig, initializeExampleDb } from "./db.ts";
import { exampleRouter } from "./router.ts";

type AppVariables = {
  requestId: string;
  requestLog: ServiceRequestLogger;
};

const BODY_PARSER_METHODS = new Set(["arrayBuffer", "blob", "formData", "json", "text"] as const);
type BodyParserMethod = typeof BODY_PARSER_METHODS extends Set<infer T> ? T : never;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createBodyParserSafeRequest(
  c: Context<{ Bindings: HttpBindings; Variables: AppVariables }>,
): Request {
  return new Proxy(c.req.raw, {
    get(target, prop) {
      if (BODY_PARSER_METHODS.has(prop as BodyParserMethod)) {
        return () => c.req[prop as BodyParserMethod]();
      }
      return Reflect.get(target, prop, target);
    },
  });
}

const serviceName = "jonasland-example";
const viteServiceRoot = fileURLToPath(new URL("..", import.meta.url));
const viteUiRoot = fileURLToPath(new URL("./ui", import.meta.url));
const viteUiIndexHtmlPath = fileURLToPath(new URL("./ui/index.html", import.meta.url));
const viteUiPackageRoot = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url));
const viteUiGlobalsCss = `${viteUiPackageRoot}/styles/globals.css`;
const port = Number(process.env.PORT) || exampleServiceManifest.port;

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const openAPIHandler = new OpenAPIHandler(exampleRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "jonasland example API",
          version: exampleServiceManifest.version,
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
  interceptors: [createOrpcErrorInterceptor()],
});

const rpcHandler = new RPCHandler(exampleRouter, {
  interceptors: [createOrpcErrorInterceptor()],
});

const app = new Hono<{ Bindings: HttpBindings; Variables: AppVariables }>();

app.use("*", async (c, next) => {
  const incomingContext = extractIncomingTraceContext(c.req.raw.headers, (carrier) =>
    propagation.extract(ROOT_CONTEXT, carrier),
  );
  return otelContext.with(incomingContext, next);
});

app.use("*", async (c, next) => {
  const requestId = getRequestIdHeader(c.req.header("x-request-id")) ?? randomUUID();
  const requestLog = createServiceRequestLogger({
    requestId,
    method: c.req.method,
    path: c.req.path,
  });
  const startedAt = Date.now();

  c.set("requestId", requestId);
  c.set("requestLog", requestLog);

  let status = 500;
  try {
    await next();
    status = c.res.status;
  } catch (error) {
    requestLog.error(toError(error));
    status = 500;
    throw error;
  } finally {
    const outgoingStatus = c.env.outgoing.statusCode;
    if (typeof outgoingStatus === "number" && outgoingStatus > 0) {
      status = outgoingStatus;
    }
    requestLog.emit({
      status,
      durationMs: Date.now() - startedAt,
    });
  }
});

app.get("/api/observability", createServiceObservabilityHandler(getExampleDbRuntimeConfig));

app.get("/", async (c) => {
  const html = await readFile(viteUiIndexHtmlPath, "utf8");
  return c.html(html);
});

app.all("/orpc/*", async (c) => {
  const { matched, response } = await rpcHandler.handle(createBodyParserSafeRequest(c), {
    prefix: "/orpc",
    context: {
      requestId: c.get("requestId"),
      serviceName,
      log: c.get("requestLog"),
    },
  });
  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

app.all("/api/*", async (c) => {
  const { matched, response } = await openAPIHandler.handle(c.req.raw, {
    prefix: "/api",
    context: {
      requestId: c.get("requestId"),
      serviceName,
      log: c.get("requestLog"),
    },
  });
  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

await initializeExampleDb();

const vite = await createViteServer({
  configFile: false,
  root: viteUiRoot,
  cacheDir: "/tmp/vite-example",
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
  appType: "spa",
  server: {
    middlewareMode: true,
    fs: {
      strict: false,
      allow: ["/", searchForWorkspaceRoot(viteServiceRoot), viteUiRoot, viteUiPackageRoot],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**"],
    },
  },
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
server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  const boundPort = address && typeof address === "object" ? (address as AddressInfo).port : port;
  void registerServiceWithRegistry({
    manifest: exampleServiceManifest,
    port: boundPort,
    metadata: { openapiPath: "/api/openapi.json", title: "Example Service" },
    tags: ["openapi", "example"],
  });
});
