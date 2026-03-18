import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
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
import { sendBatchToOTLP } from "evlog/otlp";
import type { DrainContext } from "evlog";
import type { Plugin } from "vite";
import { z } from "zod/v4";
import { createSlug } from "./create-slug.ts";
import {
  ServiceDebugOutput,
  ServiceHealthOutput,
  ServiceSqlInput,
  ServiceSqlResult,
  ServiceSqlResultHeader,
  createServiceSubRouterContract,
  type ServiceManifestLike,
  type ServiceManifestWithEntryPoint,
  type SqlResultSet,
} from "./service-contract.ts";
import { useTmpDir } from "./test-helpers/index.ts";
import type { UseTmpDirFixture } from "./test-helpers/index.ts";

type RuntimeGlobal = typeof globalThis & {
  __jonaslandOtelInitialized?: boolean;
};

const runtimeGlobal = globalThis as RuntimeGlobal;

type ServiceRequestLogFields = Record<string, unknown>;
type ServiceRequestLogger = RequestLogger<ServiceRequestLogFields>;

interface ServiceContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
}

interface ServiceInitialContext {
  requestId?: string;
  log?: ServiceRequestLogger;
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
    debug: {
      handler: (
        handler: (args: { context: ServiceContext }) => Promise<ServiceDebugOutput>,
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
    executeSql: (statement: string) => Promise<SqlResultSet>;
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
    const result = transformSqlResultSet(await options.executeSql(input.statement));

    infoFromContext(context, `${logPrefix}.sql`, {
      service: options.manifest.name,
      request_id: context.requestId,
      duration_ms: Date.now() - startedAt,
      rows: result.rows.length,
      rows_affected: result.stat.rowsAffected,
    });

    return result;
  });

  const debug = builder.service.debug.handler(async ({ context }) => {
    infoFromContext(context, `${logPrefix}.debug`, {
      service: options.manifest.name,
      request_id: context.requestId,
    });
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
  });

  return { health, sql, debug };
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
  if (runtimeGlobal.__jonaslandOtelInitialized) return;

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
  runtimeGlobal.__jonaslandOtelInitialized = true;

  const shutdown = () => {
    void sdk.shutdown();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function createSilentOTLPDrain(endpoint: string): (ctx: DrainContext) => Promise<void> {
  let logged = false;
  return async (ctx: DrainContext) => {
    try {
      await sendBatchToOTLP([ctx.event], { endpoint });
    } catch {
      if (!logged) {
        logged = true;
        console.warn(
          `[evlog/otlp] OTLP endpoint ${endpoint} unreachable, suppressing further errors`,
        );
      }
    }
  };
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
          drain: createSilentOTLPDrain(drainEndpoint),
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

export function createOrpcErrorInterceptor<
  TOptions extends {
    next(): unknown;
  },
  TRest extends unknown[] = [],
>() {
  return onError<Promise<Awaited<ReturnType<TOptions["next"]>>>, TOptions, TRest>(
    (error, params, ..._rest) => {
      const request = "request" in params ? params.request : undefined;
      const requestMethod =
        typeof request === "object" &&
        request !== null &&
        "method" in request &&
        typeof request.method === "string"
          ? request.method
          : undefined;
      const requestUrl =
        typeof request === "object" &&
        request !== null &&
        "url" in request &&
        typeof request.url === "string"
          ? request.url
          : undefined;
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
        request_method: requestMethod,
        request_url: requestUrl,
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
    },
  );
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

export function transformSqlResultSet(raw: SqlResultSet): ServiceSqlResult {
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

export const transformLibsqlResultSet = transformSqlResultSet;

export function createHealthzHandler() {
  return (c: { text: (body: string) => Response }) => c.text("ok");
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

export function extractIncomingTraceContext<TContext>(
  headers: Headers | Record<string, string | string[] | undefined>,
  extract: (carrier: Record<string, string>) => TContext,
): TContext;
export function extractIncomingTraceContext<TContext>(
  headers: Headers | Record<string, string | string[] | undefined>,
  extract: (carrier: Record<string, string>) => TContext,
): TContext {
  const carrier: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      carrier[key] = value;
    });

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

export function localHostForService(params: { slug: string }): string {
  const normalized = params.slug.trim().toLowerCase();
  const base = normalized.endsWith("-service")
    ? normalized.slice(0, -"-service".length)
    : normalized;
  return `${base}.iterate.localhost`;
}

export type RpcWebSocket = LinkWebsocketClientOptions["websocket"];

export interface CreateOrpcRpcServiceClientOptions<TContract extends AnyContractRouter> {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike<TContract>;
  preferSameOrigin?: boolean;
  url?: string;
  headers?: RPCLinkOptions<any>["headers"];
  fetch?: RPCLinkOptions<any>["fetch"];
}

export interface CreateOrpcOpenApiServiceClientOptions<TContract extends AnyContractRouter> {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike<TContract>;
  preferSameOrigin?: boolean;
  url?: string;
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
  preferSameOrigin?: boolean;
}) {
  const candidate = params.env.ITERATE_PROJECT_BASE_URL?.trim();

  if (params.preferSameOrigin && candidate) {
    const parsed = new URL(candidate);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

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
  preferSameOrigin?: boolean;
}) {
  return new URL("/orpc", resolveServiceBaseUrl(params)).toString();
}

export function resolveServiceOpenApiBaseUrl(params: {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike;
  preferSameOrigin?: boolean;
}) {
  return new URL("/api", resolveServiceBaseUrl(params)).toString();
}

export function resolveServiceOrpcWebSocketUrl(params: {
  env: ServiceClientEnv;
  manifest: ServiceManifestLike;
  preferSameOrigin?: boolean;
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
    url: options.url ?? resolveServiceOrpcUrl(options),
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
    url: options.url ?? resolveServiceOpenApiBaseUrl(options),
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

export async function registerServiceWithRegistry(params: {
  manifest: ServiceManifestLike & { slug: string };
  port: number;
  metadata?: Record<string, string | undefined>;
  tags?: string[];
}): Promise<void> {
  const registryUrl = "http://registry.iterate.localhost";
  const { createRegistryClient } = await import("@iterate-com/registry-contract");
  const registryClient = createRegistryClient({ url: registryUrl });
  const host = localHostForService({ slug: params.manifest.slug });
  const target = `127.0.0.1:${String(params.port)}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const result = await registryClient.routes.upsert({
        host,
        target,
        ...(params.metadata
          ? {
              metadata: Object.fromEntries(
                Object.entries(params.metadata).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              ),
            }
          : {}),
        ...(params.tags ? { tags: params.tags } : {}),
      });

      serviceLog.info({
        event: "service.registry.registered",
        host,
        target,
        route_count: result.routeCount,
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  serviceLog.warn({
    event: "service.registry.register_failed",
    host,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

export function createLocalServiceOrpcClient<TContract extends AnyContractRouter>(params: {
  manifest: ServiceManifestLike<TContract>;
  headers?: Record<string, string>;
}): ContractRouterClient<TContract> {
  const url = `http://${localHostForService({ slug: params.manifest.slug })}/api`;
  const link = new OpenAPILink(params.manifest.orpcContract, {
    url,
    ...(params.headers ? { headers: params.headers } : {}),
  });
  return createORPCClient(link);
}

export interface PidnapServiceConfig {
  processSlug: string;
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  tags: string[];
  restartImmediately: boolean;
  healthCheck: {
    url: string;
    intervalMs: number;
  };
}

export function serviceManifestToPidnapConfig(params: {
  manifest: ServiceManifestWithEntryPoint;
  env?: Record<string, string>;
}): PidnapServiceConfig;
export function serviceManifestToPidnapConfig(params: {
  manifests: ServiceManifestWithEntryPoint[];
  env?: Record<string, string>;
}): PidnapServiceConfig[];
export function serviceManifestToPidnapConfig(params: {
  manifest?: ServiceManifestWithEntryPoint;
  manifests?: ServiceManifestWithEntryPoint[];
  env?: Record<string, string>;
}): PidnapServiceConfig | PidnapServiceConfig[] {
  if (params.manifests) {
    return params.manifests.map((manifest) =>
      serviceManifestToPidnapConfig({ manifest, env: params.env }),
    );
  }
  const manifest = params.manifest!;
  const host = localHostForService({ slug: manifest.slug });
  return {
    processSlug: manifest.slug,
    definition: {
      command: "tsx",
      args: [manifest.serverEntryPoint],
      env: { PORT: String(manifest.port), ...params.env },
    },
    tags: ["on-demand"],
    restartImmediately: true,
    healthCheck: {
      url: `http://${host}/api/__iterate/health`,
      intervalMs: 2_000,
    },
  };
}

export { createSlug };
export { stripAnsi } from "./strip-ansi.ts";
export {
  ServiceDebugOutput,
  ServiceHealthOutput,
  ServiceSqlInput,
  ServiceSqlResult,
  ServiceSqlResultHeader,
  createServiceSubRouterContract,
};
export { useTmpDir };
export type {
  ServiceContext,
  ServiceInitialContext,
  ServiceManifestLike,
  ServiceManifestWithEntryPoint,
  ServiceRequestLogFields,
  ServiceRequestLogger,
  SqlResultSet,
  UseTmpDirFixture,
};

export {
  createServiceOpenAPIHandler,
  createSimpleServiceRouter,
  applyServiceMiddleware,
  applyOpenAPIRoute,
  type ServiceAppVariables,
  type ServiceAppEnv,
} from "./service-server.ts";
export {
  appScriptBase,
  defineApp,
  type AttachAppRuntimeOptions,
  type AttachAppRuntimeResult,
  type AppInitialContext,
  type AppManifest,
  type DefinedApp,
  type RuntimeOrpcContext,
} from "../define-app.ts";
