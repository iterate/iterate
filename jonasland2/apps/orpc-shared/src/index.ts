import { randomUUID } from "node:crypto";
import { context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { ORPCInstrumentation } from "@orpc/otel";

type RuntimeState = {
  initialized: boolean;
  sdk?: NodeSDK;
};

type RuntimeGlobal = typeof globalThis & {
  __jonasland2OtelRuntimeState?: RuntimeState;
};

const runtimeGlobal = globalThis as RuntimeGlobal;

export interface SharedRequestContext {
  requestId?: string;
  serviceName?: string;
}

export type ServiceLogFn = (event: string, fields?: Record<string, unknown>) => void;

type MiddlewareNextResult = Promise<{
  context: Record<PropertyKey, unknown>;
  output: unknown;
}>;

type SharedMiddlewareOptions = {
  context: Record<PropertyKey, unknown>;
  path: readonly string[];
  next: (options?: { context?: Record<PropertyKey, unknown> }) => MiddlewareNextResult;
};

function parseKvHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
  if (!rawHeaders) return undefined;

  const headers: Record<string, string> = {};
  for (const part of rawHeaders.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function resolveTracesEndpoint(): string | undefined {
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  }

  const exporterBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!exporterBase) return undefined;

  const normalized = exporterBase.endsWith("/") ? exporterBase.slice(0, -1) : exporterBase;
  return `${normalized}/v1/traces`;
}

function resolveActiveTraceContext() {
  const activeSpan = trace.getSpan(context.active());
  const spanContext = activeSpan?.spanContext();
  if (!spanContext) return null;

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function requestIdFromContext(contextObject: Record<PropertyKey, unknown>): string | undefined {
  const requestId = contextObject.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

export function getOtelRuntimeConfig() {
  const tracesEndpoint = resolveTracesEndpoint();
  const tracesHeaders = parseKvHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const correlatedLogsEndpoint = process.env.OTEL_CORRELATED_LOGS_ENDPOINT || "";
  const correlatedLogsHeaders = parseKvHeaders(process.env.OTEL_CORRELATED_LOGS_HEADERS);

  return {
    enabled: Boolean(tracesEndpoint),
    tracesEndpoint: tracesEndpoint ?? null,
    hasTraceHeaders: Boolean(tracesHeaders && Object.keys(tracesHeaders).length > 0),
    correlatedLogsEndpoint: correlatedLogsEndpoint || null,
    hasCorrelatedLogHeaders: Boolean(
      correlatedLogsHeaders && Object.keys(correlatedLogsHeaders).length > 0,
    ),
  };
}

export function initializeServiceOtel(serviceName: string): void {
  if (runtimeGlobal.__jonasland2OtelRuntimeState?.initialized) return;

  const tracesEndpoint = resolveTracesEndpoint();
  const tracesHeaders = parseKvHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  if (!tracesEndpoint) {
    runtimeGlobal.__jonasland2OtelRuntimeState = { initialized: true };
    return;
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
      "deployment.environment.name": process.env.NODE_ENV || "development",
    }),
    traceExporter: new OTLPTraceExporter({
      url: tracesEndpoint,
      headers: tracesHeaders,
    }),
    instrumentations: [
      new ORPCInstrumentation(),
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });

  void sdk.start();

  const shutdown = () => {
    void sdk.shutdown();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  runtimeGlobal.__jonasland2OtelRuntimeState = {
    initialized: true,
    sdk,
  };
}

export function createServiceLogger(serviceName: string): ServiceLogFn {
  const correlatedLogsEndpoint = process.env.OTEL_CORRELATED_LOGS_ENDPOINT || "";
  const correlatedLogsHeaders = parseKvHeaders(process.env.OTEL_CORRELATED_LOGS_HEADERS);

  return (event, fields = {}) => {
    const activeTraceContext = resolveActiveTraceContext();
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      service: serviceName,
      event,
      ...fields,
    };

    if (activeTraceContext) {
      record.trace_id = activeTraceContext.traceId;
      record.span_id = activeTraceContext.spanId;
    }

    process.stdout.write(`${JSON.stringify(record)}\n`);

    if (!correlatedLogsEndpoint) return;

    void fetch(correlatedLogsEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(correlatedLogsHeaders ?? {}),
      },
      body: JSON.stringify([record]),
    }).catch((error) => {
      const ingestErrorRecord = {
        timestamp: new Date().toISOString(),
        service: serviceName,
        event: "correlated_log_ingest_failed",
        message: parseErrorMessage(error),
      };

      process.stdout.write(`${JSON.stringify(ingestErrorRecord)}\n`);
    });
  };
}

export function createRequestContextMiddleware(serviceName: string, log: ServiceLogFn) {
  return async ({ context: requestContext, path, next }: SharedMiddlewareOptions) => {
    const requestId = randomUUID();
    const orpcPath = path.join(".");

    log("orpc.request.accepted", {
      request_id: requestId,
      orpc_path: orpcPath,
    });

    return next({
      context: {
        ...requestContext,
        requestId,
        serviceName,
      },
    });
  };
}

export function createRequestLifecycleMiddleware(serviceName: string, log: ServiceLogFn) {
  return async ({ context: requestContext, path, next }: SharedMiddlewareOptions) => {
    const startedAt = Date.now();
    const orpcPath = path.join(".");

    try {
      const result = await next();
      log("orpc.request.completed", {
        request_id: requestIdFromContext(requestContext),
        orpc_path: orpcPath,
        duration_ms: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      log("orpc.request.failed", {
        request_id: requestIdFromContext(requestContext),
        orpc_path: orpcPath,
        duration_ms: Date.now() - startedAt,
        error: parseErrorMessage(error),
        service: serviceName,
      });
      throw error;
    }
  };
}
