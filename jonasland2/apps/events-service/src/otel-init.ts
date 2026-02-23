import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const state = globalThis as typeof globalThis & {
  __jonasland2OtelInitialized?: boolean;
};

function resolveTraceExporterUrl() {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;

  const normalized = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${normalized}/v1/traces`;
}

function resolveTraceExporterHeaders(): Record<string, string> | undefined {
  const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!rawHeaders) return undefined;

  const headers: Record<string, string> = {};
  for (const part of rawHeaders.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function getOtelConfig() {
  const tracesEndpoint = resolveTraceExporterUrl();
  const headers = resolveTraceExporterHeaders();
  return {
    enabled: Boolean(tracesEndpoint),
    tracesEndpoint: tracesEndpoint ?? null,
    hasHeaders: Boolean(headers && Object.keys(headers).length > 0),
  };
}

export function initializeOtel(serviceName: string) {
  if (state.__jonasland2OtelInitialized) return;

  const traceExporterUrl = resolveTraceExporterUrl();
  const traceExporterHeaders = resolveTraceExporterHeaders();
  if (!traceExporterUrl) {
    state.__jonasland2OtelInitialized = true;
    return;
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
      "deployment.environment.name": process.env.NODE_ENV || "development",
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: traceExporterUrl,
          headers: traceExporterHeaders,
        }),
      ),
    ],
  });

  trace.setGlobalTracerProvider(provider);
  state.__jonasland2OtelInitialized = true;
}

export async function withSpan<T>(
  tracerName: string,
  spanName: string,
  attributes: Attributes | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(tracerName);

  return tracer.startActiveSpan(spanName, { attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
