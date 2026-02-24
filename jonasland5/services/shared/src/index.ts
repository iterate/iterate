import { randomUUID } from "node:crypto";
import type { ResultSet } from "@libsql/client";
import { oc } from "@orpc/contract";
import { onError } from "@orpc/server";
import { z } from "zod/v4";

export type ServiceRequestLogFields = Record<string, unknown>;

export interface ServiceRequestLogger {
  info(message: string, fields?: ServiceRequestLogFields): void;
  error(error: Error, fields?: ServiceRequestLogFields): void;
  emit(fields?: ServiceRequestLogFields): void;
  set(fields: ServiceRequestLogFields): void;
}

const noopLogger: ServiceRequestLogger = {
  info() {},
  error() {},
  emit() {},
  set() {},
};

export const serviceLog = {
  info(_fields: Record<string, unknown>) {},
  error(_error: Error, _fields?: Record<string, unknown>) {},
};

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

export function createServiceRequestLogger(_options: {
  method?: string;
  path?: string;
  requestId?: string;
}): ServiceRequestLogger {
  return noopLogger;
}

export function createServiceContextMiddleware(serviceName: string) {
  const middleware = async <TContext extends ServiceInitialContext>({
    context,
    next,
  }: {
    context: TContext;
    next: (options: { context: TContext & ServiceContext }) => Promise<unknown>;
  }) => {
    const requestId = context.requestId || randomUUID();
    const requestLog = context.log || createServiceRequestLogger({ requestId, method: "ORPC" });

    requestLog.set({
      requestId,
      service: serviceName,
    });

    return next({
      context: {
        ...context,
        requestId,
        serviceName,
        log: requestLog,
      } as TContext & ServiceContext,
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
  context.log?.info(message, fields);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export function createOrpcErrorInterceptor() {
  return onError((error, params) => {
    const context =
      "context" in params &&
      typeof params.context === "object" &&
      params.context !== null &&
      "log" in params.context
        ? (params.context as ServiceInitialContext)
        : undefined;

    context?.log?.error(toError(error), {
      event: "orpc.handler.error",
      status: errorStatus(error),
    });
  });
}

function convertSqliteType(rawType: string | undefined | null): 1 | 2 | 3 | 4 {
  if (!rawType) return 4;

  const type = rawType.toUpperCase();
  if (
    type.includes("CHAR") ||
    type.includes("TEXT") ||
    type.includes("CLOB") ||
    type.includes("STRING")
  ) {
    return 1;
  }
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

export function getOtelRuntimeConfig() {
  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
  const logsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
    (baseEndpoint ? `${baseEndpoint.replace(/\/+$/, "")}/v1/logs` : null);

  return {
    tracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? null,
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

export function initializeServiceOtel(_serviceName: string): void {}

export function initializeServiceEvlog(_serviceName: string): void {}
