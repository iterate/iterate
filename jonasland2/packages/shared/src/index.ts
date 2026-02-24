import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { createORPCClient } from "@orpc/client";
import { RPCLink, type RPCLinkOptions } from "@orpc/client/fetch";
import {
  RPCLink as WebSocketRPCLink,
  type LinkWebsocketClientOptions,
} from "@orpc/client/websocket";
import {
  inferRPCMethodFromContractRouter,
  type AnyContractRouter,
  type ContractRouterClient,
} from "@orpc/contract";
import { LoggingHandlerPlugin, getLogger, type LoggerContext } from "@orpc/experimental-pino";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { ORPCInstrumentation } from "@orpc/otel";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import pino, { type Logger } from "pino";
import { type Plugin, type ViteDevServer } from "vite";
import { WebSocketServer } from "ws";

type RuntimeGlobal = typeof globalThis & {
  __jonasland2OtelInitialized?: boolean;
};

const runtimeGlobal = globalThis as RuntimeGlobal;

export interface ServiceContext extends LoggerContext {
  requestId: string;
  serviceName: string;
}

export interface ServiceInitialContext extends LoggerContext {
  requestId?: string;
}

function resolveTraceExporterUrl() {
  return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces";
}

function currentSpanFields() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext) return {};

  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: spanContext.traceFlags,
  };
}

export function initializeServiceOtel(serviceName: string): void {
  if (runtimeGlobal.__jonasland2OtelInitialized) return;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
      "deployment.environment.name": process.env.NODE_ENV || "development",
    }),
    traceExporter: new OTLPTraceExporter({
      url: resolveTraceExporterUrl(),
    }),
    instrumentations: [
      new ORPCInstrumentation(),
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });

  void sdk.start();
  runtimeGlobal.__jonasland2OtelInitialized = true;

  const shutdown = () => {
    void sdk.shutdown();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export function createServiceLogger(serviceName: string): Logger {
  const transport = pino.transport({
    targets: [
      {
        target: "pino/file",
        options: { destination: 1 },
      },
      {
        target: "pino-opentelemetry-transport",
        options: {
          loggerName: serviceName,
          resourceAttributes: {
            "service.name": serviceName,
            "service.version": process.env.npm_package_version || "0.0.0",
          },
        },
      },
    ],
  });

  return pino(
    {
      name: serviceName,
      level: process.env.LOG_LEVEL || "info",
      mixin() {
        return currentSpanFields();
      },
    },
    transport,
  );
}

export function createHandlerLoggingPlugin(logger: Logger) {
  return new LoggingHandlerPlugin({
    logger,
    generateId: () => randomUUID(),
    logRequestAbort: true,
    logRequestResponse: true,
  });
}

export function createServiceContextMiddleware(serviceName: string) {
  const middleware = async ({
    context,
    next,
  }: {
    context: ServiceInitialContext;
    next: (options: { context: ServiceContext }) => Promise<unknown>;
  }) => {
    return next({
      context: {
        ...context,
        requestId: context.requestId || randomUUID(),
        serviceName,
      },
    });
  };

  Object.defineProperty(middleware, "name", {
    value: "serviceContextMiddleware",
  });

  return middleware;
}

export function infoFromContext(
  context: LoggerContext,
  message: string,
  fields: Record<string, unknown>,
) {
  getLogger(context)?.info(fields, message);
}

export function getOtelRuntimeConfig() {
  return {
    tracesEndpoint: resolveTraceExporterUrl(),
    logsEndpoint: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? null,
    propagators: process.env.OTEL_PROPAGATORS ?? null,
  };
}

export function createOrpcErrorInterceptor(logger: Logger) {
  return onError((error, params) => {
    const request = "request" in params ? params.request : undefined;
    const path = "path" in params ? params.path : undefined;
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;

    logger.error(
      {
        event: "orpc.handler.error",
        request_method: request?.method,
        request_url: request?.url,
        procedure_path: Array.isArray(path) ? path.join(".") : path,
        status,
        error,
      },
      "oRPC handler error",
    );
  });
}

export function getRequestIdHeader(value: string | string[] | undefined) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value[0]) return value[0];
  return undefined;
}

export function extractIncomingTraceContext(
  headers: Record<string, string | string[] | undefined>,
  extract: (carrier: Record<string, string>) => unknown,
) {
  const carrier: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      carrier[key] = value;
    } else if (Array.isArray(value) && value[0]) {
      carrier[key] = value[0];
    }
  }

  return extract(carrier);
}

export function createBrowserErrorBridgePlugin(params: {
  eventName: string;
  logEventName: string;
  logger: Logger;
}): Plugin {
  return {
    name: `${params.logEventName}-browser-error-bridge`,
    configureServer(server) {
      server.ws.on(params.eventName, (payload) => {
        params.logger.error({
          event: params.logEventName,
          payload,
        });
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          injectTo: "body",
          children: `
            if (import.meta.hot) {
              const normalizeErrorData = (value) => {
                if (value instanceof Error) {
                  return { name: value.name, message: value.message, stack: value.stack ?? null };
                }
                if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
                  return value;
                }
                try {
                  return JSON.parse(JSON.stringify(value));
                } catch {
                  return String(value);
                }
              };
              const send = (kind, data) => {
                import.meta.hot.send("${params.eventName}", {
                  kind,
                  data,
                  href: location.href,
                  userAgent: navigator.userAgent,
                  timestamp: new Date().toISOString(),
                });
              };
              const originalConsoleError = console.error.bind(console);
              console.error = (...args) => {
                send("console.error", { args: args.map(normalizeErrorData) });
                originalConsoleError(...args);
              };
              window.addEventListener("error", (event) => {
                send("window.error", {
                  message: event.message,
                  filename: event.filename,
                  lineno: event.lineno,
                  colno: event.colno,
                  error: normalizeErrorData(event.error),
                });
              });
              window.addEventListener("unhandledrejection", (event) => {
                send("window.unhandledrejection", {
                  reason: normalizeErrorData(event.reason),
                });
              });
            }
          `,
        },
      ];
    },
  };
}

export async function handleViteSpaRequest(params: {
  vite: ViteDevServer | undefined;
  req: IncomingMessage;
  res: ServerResponse<IncomingMessage>;
}) {
  const viteServer = params.vite;
  if (!viteServer) {
    params.res.writeHead(503, { "content-type": "application/json" });
    params.res.end(JSON.stringify({ error: "ui_not_ready" }));
    return;
  }

  await new Promise<void>((resolve) => {
    viteServer.middlewares(params.req, params.res, () => {
      if (!params.res.writableEnded) {
        params.res.writeHead(404, { "content-type": "application/json" });
        params.res.end(JSON.stringify({ error: "not_found" }));
      }
      resolve();
    });
  });
}

export function createOpenApiHandlerWithDocs(params: {
  router: unknown;
  logger: Logger;
  title: string;
  version: string;
  docsPath?: string;
  specPath?: string;
  servers?: Array<{ url: string }>;
}) {
  return new OpenAPIHandler(params.router, {
    plugins: [
      createHandlerLoggingPlugin(params.logger),
      new OpenAPIReferencePlugin({
        docsProvider: "scalar",
        docsPath: params.docsPath ?? "/docs",
        specPath: params.specPath ?? "/openapi.json",
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: {
          info: {
            title: params.title,
            version: params.version,
          },
          servers: params.servers ?? [{ url: "/api" }],
        },
      }),
    ],
    interceptors: [createOrpcErrorInterceptor(params.logger)],
  });
}

export function createRpcHttpHandler(params: { router: unknown; logger: Logger }) {
  return new RPCHandler(params.router, {
    plugins: [createHandlerLoggingPlugin(params.logger)],
    interceptors: [createOrpcErrorInterceptor(params.logger)],
  });
}

export function createRpcWebSocketBridge(params: {
  router: unknown;
  upgradePath?: string;
  logger: Logger;
}) {
  const wsHandler = new WebSocketRPCHandler(params.router);
  const wss = new WebSocketServer({ noServer: true });
  const upgradePath = params.upgradePath ?? "/orpc/ws";

  wss.on("connection", (ws) => {
    void wsHandler.upgrade(ws);
  });

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname !== upgradePath && pathname !== `${upgradePath}/`) {
        return false;
      }

      params.logger.info({ event: "orpc.ws.upgrade", pathname }, "Accepted oRPC websocket upgrade");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return true;
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

export interface ServiceClientEnv {
  ITERATE_PROJECT_BASE_URL?: string;
}

export interface ServiceManifestLike<TContract extends AnyContractRouter = AnyContractRouter> {
  slug: string;
  port: number;
  orpcContract: TContract;
}

export type RpcWebSocket = LinkWebsocketClientOptions["websocket"];

export interface CreateOrpcRpcServiceClientOptions<TContract extends AnyContractRouter> {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike<TContract>;
  headers?: RPCLinkOptions<any>["headers"];
  fetch?: RPCLinkOptions<any>["fetch"];
}

export interface CreateOrpcOpenApiServiceClientOptions<TContract extends AnyContractRouter> {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike<TContract>;
  headers?: Record<string, string>;
  fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

export interface CreateOrpcRpcWebSocketServiceClientOptions<TContract extends AnyContractRouter> {
  websocket: RpcWebSocket;
  manifest: ServiceManifestLike<TContract>;
}

export function resolveServiceBaseUrl(params: {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike;
}) {
  const candidate = params.env.ITERATE_PROJECT_BASE_URL?.trim();

  if (!candidate) {
    return `http://127.0.0.1:${params.manifest.port}/`;
  }

  const parsed = new URL(candidate);
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function resolveServiceOrpcUrl(params: {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike;
}) {
  return new URL("/orpc", resolveServiceBaseUrl(params)).toString();
}

export function resolveServiceOpenApiBaseUrl(params: {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike;
}) {
  return new URL("/api", resolveServiceBaseUrl(params)).toString();
}

export function resolveServiceOrpcWebSocketUrl(params: {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike;
}) {
  const url = new URL(resolveServiceBaseUrl(params));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/orpc/ws/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function createOrpcRpcServiceClient<TContract extends AnyContractRouter>(
  options: CreateOrpcRpcServiceClientOptions<TContract>,
): ContractRouterClient<TContract> {
  const link = new RPCLink({
    url: resolveServiceOrpcUrl(options),
    method: inferRPCMethodFromContractRouter(options.manifest.orpcContract),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
}

export function createOrpcOpenApiServiceClient<TContract extends AnyContractRouter>(
  options: CreateOrpcOpenApiServiceClientOptions<TContract>,
): ContractRouterClient<TContract> {
  const link = new OpenAPILink(options.manifest.orpcContract, {
    url: resolveServiceOpenApiBaseUrl(options),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
}

export function createOrpcRpcWebSocketServiceClient<TContract extends AnyContractRouter>(
  options: CreateOrpcRpcWebSocketServiceClientOptions<TContract>,
): ContractRouterClient<TContract> {
  const link = new WebSocketRPCLink({ websocket: options.websocket });
  return createORPCClient(link);
}
