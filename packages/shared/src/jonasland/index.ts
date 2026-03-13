import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { createORPCClient } from "@orpc/client";
import { RPCLink, type RPCLinkOptions } from "@orpc/client/fetch";
import { type LinkWebsocketClientOptions } from "@orpc/client/websocket";
import {
  inferRPCMethodFromContractRouter,
  type AnyContractRouter,
  type ContractRouterClient,
} from "@orpc/contract";
import { oc } from "@orpc/contract";
import { ORPCInstrumentation } from "@orpc/otel";
import { onError } from "@orpc/server";
import { createRequestLogger, initLogger, log as rootLog, type RequestLogger } from "evlog";
import { createOTLPDrain } from "evlog/otlp";
import { z } from "zod/v4";

type RuntimeGlobal = typeof globalThis & {
  __jonaslandOtelInitialized?: boolean;
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

export interface SqlResultSet {
  columns: string[];
  columnTypes: Array<string | null>;
  rows: unknown[][];
  rowsAffected?: number;
  lastInsertRowid?: number | bigint | null;
}

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
  url?: string;
  headers?: RPCLinkOptions<any>["headers"];
  fetch?: RPCLinkOptions<any>["fetch"];
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
