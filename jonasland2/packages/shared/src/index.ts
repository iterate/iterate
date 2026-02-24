import { randomUUID } from "node:crypto";
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
import { oc } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { ORPCInstrumentation } from "@orpc/otel";
import { onError } from "@orpc/server";
import {
  createRequestLogger,
  initLogger,
  log as rootLog,
  type Log,
  type RequestLogger,
} from "evlog";
import { createOTLPDrain } from "evlog/otlp";
import type { ResultSet } from "@libsql/client";
import { type Plugin } from "vite";
import { z } from "zod/v4";

type RuntimeGlobal = typeof globalThis & {
  __jonasland2OtelInitialized?: boolean;
};

const runtimeGlobal = globalThis as RuntimeGlobal;

export type ServiceRequestLogFields = Record<string, unknown>;
export type ServiceRequestLogger = RequestLogger<ServiceRequestLogFields>;

export interface ServiceContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
}

export interface ServiceInitialContext {
  requestId?: string;
  log?: ServiceRequestLogger;
}

export const ServiceHealthOutput = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
});

export const ServiceSqlInput = z.object({
  statement: z.string().min(1),
});

export const ServiceSqlResultHeader = z.object({
  name: z.string(),
  displayName: z.string(),
  originalType: z.string().nullable(),
  type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

export const ServiceSqlResult = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  headers: z.array(ServiceSqlResultHeader),
  stat: z.object({
    rowsAffected: z.number().int(),
    rowsRead: z.number().int().nullable(),
    rowsWritten: z.number().int().nullable(),
    queryDurationMs: z.number().int().nullable(),
  }),
  lastInsertRowid: z.number().int().optional(),
});

export type ServiceSqlInput = z.infer<typeof ServiceSqlInput>;
export type ServiceSqlResult = z.infer<typeof ServiceSqlResult>;

export function createServiceSubRouterContract(options?: {
  tag?: string;
  healthSummary?: string;
  sqlSummary?: string;
}) {
  const tag = options?.tag ?? "service";

  return {
    service: {
      health: oc
        .route({
          method: "GET",
          path: "/service/health",
          summary: options?.healthSummary ?? "Service health metadata",
          tags: [tag],
        })
        .input(z.object({}).optional().default({}))
        .output(ServiceHealthOutput),

      sql: oc
        .route({
          method: "POST",
          path: "/service/sql",
          summary: options?.sqlSummary ?? "Execute SQL against service database",
          tags: [tag],
        })
        .input(ServiceSqlInput)
        .output(ServiceSqlResult),
    },
  } as const;
}

type ServiceSubRouterBuilder = {
  service: {
    health: {
      handler: (
        handler: (args: {
          context: ServiceContext;
        }) => Promise<z.infer<typeof ServiceHealthOutput>>,
      ) => unknown;
    };
    sql: {
      handler: (
        handler: (args: {
          input: ServiceSqlInput;
          context: ServiceContext;
        }) => Promise<ServiceSqlResult>,
      ) => unknown;
    };
  };
};

export function createServiceSubRouterHandlers<TBuilder extends ServiceSubRouterBuilder>(
  builder: TBuilder,
  options: {
    manifest: {
      name: string;
      version: string;
    };
    executeSql: (statement: string) => Promise<ResultSet>;
    logPrefix?: string;
  },
) {
  const logPrefix = options.logPrefix ?? "service";

  const health = builder.service.health.handler(async ({ context }) => {
    infoFromContext(context, `${logPrefix}.health`, {
      service: options.manifest.name,
      request_id: context.requestId,
    });

    return {
      ok: true,
      service: options.manifest.name,
      version: options.manifest.version,
    };
  });

  const sql = builder.service.sql.handler(async ({ input, context }) => {
    const startedAt = Date.now();
    const result = transformLibsqlResultSet(await options.executeSql(input.statement));

    infoFromContext(context, `${logPrefix}.sql`, {
      service: options.manifest.name,
      request_id: context.requestId,
      duration_ms: Date.now() - startedAt,
      rows: result.rows.length,
      rows_affected: result.stat.rowsAffected,
    });

    return result;
  });

  return { health, sql };
}

function resolveTraceExporterUrl() {
  return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces";
}

function normalizeBaseEndpoint(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveEvlogDrainEndpoint(): string | undefined {
  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (baseEndpoint) {
    return normalizeBaseEndpoint(baseEndpoint);
  }

  const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  if (!logsEndpoint) return undefined;

  const normalizedLogsEndpoint = logsEndpoint.replace(/\/+$/, "");
  if (normalizedLogsEndpoint.endsWith("/v1/logs")) {
    return normalizedLogsEndpoint.slice(0, -"/v1/logs".length);
  }

  return normalizedLogsEndpoint;
}

function currentSpanFields() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext) return {};

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
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

export function initializeServiceEvlog(serviceName: string): void {
  const drainEndpoint = resolveEvlogDrainEndpoint();

  initLogger({
    env: {
      service: serviceName,
      environment: process.env.NODE_ENV ?? "development",
      version: process.env.npm_package_version || "0.0.0",
    },
    pretty: process.env.NODE_ENV !== "production",
    ...(drainEndpoint
      ? {
          drain: createOTLPDrain({ endpoint: drainEndpoint }),
        }
      : {}),
  });
}

export const serviceLog = rootLog;

export function createServiceRequestLogger(options: {
  method?: string;
  path?: string;
  requestId?: string;
}): ServiceRequestLogger {
  return createRequestLogger<ServiceRequestLogFields>(options);
}

export function createServiceContextMiddleware(serviceName: string) {
  const middleware = async ({
    context,
    next,
  }: {
    context: ServiceInitialContext;
    next: (options: { context: ServiceContext }) => Promise<unknown>;
  }) => {
    const requestId = context.requestId || randomUUID();
    const requestLog =
      context.log ||
      createServiceRequestLogger({
        requestId,
        method: "ORPC",
        path: "unknown",
      });

    requestLog.set({
      requestId,
      service: serviceName,
      ...currentSpanFields(),
    });

    return next({
      context: {
        ...context,
        requestId,
        serviceName,
        log: requestLog,
      },
    });
  };

  Object.defineProperty(middleware, "name", {
    value: "serviceContextMiddleware",
  });

  return middleware;
}

export function infoFromContext(
  context: ServiceInitialContext,
  message: string,
  fields: Record<string, unknown>,
) {
  const payload = {
    ...fields,
    ...currentSpanFields(),
  };

  if (context.log) {
    context.log.info(message, payload);
    return;
  }

  rootLog.info({
    message,
    ...payload,
    ...(context.requestId ? { requestId: context.requestId } : {}),
  });
}

export function createOrpcErrorInterceptor() {
  return onError((error, params) => {
    const request = "request" in params ? params.request : undefined;
    const path = "path" in params ? params.path : undefined;
    const context =
      "context" in params &&
      typeof params.context === "object" &&
      params.context !== null &&
      "log" in params.context
        ? (params.context as ServiceInitialContext)
        : undefined;

    const fields = {
      event: "orpc.handler.error",
      request_method: request?.method,
      request_url: request?.url,
      procedure_path: Array.isArray(path) ? path.join(".") : path,
      status: errorStatus(error),
      ...currentSpanFields(),
    };

    const resolvedError = toError(error);

    if (context?.log) {
      context.log.error(resolvedError, fields);
      return;
    }

    rootLog.error({
      ...fields,
      error: {
        name: resolvedError.name,
        message: resolvedError.message,
        stack: resolvedError.stack,
      },
    });
  });
}

export function getOtelRuntimeConfig() {
  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
  const logsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
    (baseEndpoint ? `${normalizeBaseEndpoint(baseEndpoint)}/v1/logs` : null);

  return {
    tracesEndpoint: resolveTraceExporterUrl(),
    logsEndpoint,
    baseEndpoint,
    propagators: process.env.OTEL_PROPAGATORS ?? null,
  };
}

function convertSqliteType(rawType: string | undefined | null): 1 | 2 | 3 | 4 {
  if (!rawType) return 4;

  const type = rawType.toUpperCase();
  if (
    type.includes("CHAR") ||
    type.includes("TEXT") ||
    type.includes("CLOB") ||
    type.includes("STRING")
  )
    return 1;
  if (type.includes("INT")) return 2;
  if (type.includes("REAL") || type.includes("DOUBLE") || type.includes("FLOAT")) return 3;
  if (type.includes("BLOB")) return 4;
  return 1;
}

export function transformLibsqlResultSet(raw: ResultSet): ServiceSqlResult {
  const usedHeaders = new Set<string>();

  const headers = raw.columns.map((displayName, index) => {
    const originalType = raw.columnTypes[index];
    let name = displayName;

    for (let i = 0; i < 20 && usedHeaders.has(name); i += 1) {
      name = `__${displayName}_${i}`;
    }

    usedHeaders.add(name);

    return {
      name,
      displayName,
      originalType: originalType ?? null,
      type: convertSqliteType(originalType),
    };
  });

  const rows = raw.rows.map((row) =>
    headers.reduce<Record<string, unknown>>((acc, header, index) => {
      const value = row[index];

      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        acc[header.name] = Array.from(new Uint8Array(value));
      } else {
        acc[header.name] = value;
      }

      return acc;
    }, {}),
  );

  return {
    rows,
    headers,
    stat: {
      rowsAffected: raw.rowsAffected ?? 0,
      rowsRead: null,
      rowsWritten: null,
      queryDurationMs: 0,
    },
    lastInsertRowid:
      raw.lastInsertRowid === undefined || raw.lastInsertRowid === null
        ? undefined
        : Number(raw.lastInsertRowid),
  };
}

export function createHealthzHandler() {
  return (c: { text: (body: string) => Response }) => c.text("ok");
}

export function createServiceObservabilityHandler(
  resolveSqliteRuntimeConfig: () => Promise<unknown>,
) {
  return async (c: { json: (body: unknown) => Response }) =>
    c.json({
      otel: getOtelRuntimeConfig(),
      sqlite: await resolveSqliteRuntimeConfig(),
    });
}

export function getRequestIdHeader(value: string | string[] | null | undefined) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value[0]) return value[0];
  return undefined;
}

export function extractIncomingTraceContext(
  headers: Headers | Record<string, string | string[] | undefined>,
  extract: (carrier: Record<string, string>) => unknown,
) {
  const carrier: Record<string, string> = {};

  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      carrier[key] = value;
    }

    return extract(carrier);
  }

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
  logger: Pick<Log, "error">;
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
