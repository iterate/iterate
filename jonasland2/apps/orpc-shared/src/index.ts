import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { LoggingHandlerPlugin, getLogger, type LoggerContext } from "@orpc/experimental-pino";
import { ORPCInstrumentation } from "@orpc/otel";
import pino, { type Logger } from "pino";

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
