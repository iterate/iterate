import { propagation, trace, context, type Context, type TextMapGetter } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const state = globalThis as typeof globalThis & {
  __iterateOsOtelInitialized?: boolean;
};

const headersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier) {
    const keys: string[] = [];
    carrier.forEach((_value, key) => keys.push(key));
    return keys;
  },
};

function resolveTraceExporterUrl(bindings?: Record<string, unknown>): string | undefined {
  const tracesEndpoint =
    (bindings?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as string | undefined) ||
    globalThis.process?.env?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;
  const endpoint =
    (bindings?.OTEL_EXPORTER_OTLP_ENDPOINT as string | undefined) ||
    globalThis.process?.env?.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  const normalized = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${normalized}/v1/traces`;
}

export function getOtelConfig(bindings?: Record<string, unknown>) {
  const tracesEndpoint = resolveTraceExporterUrl(bindings);
  return {
    enabled: Boolean(tracesEndpoint),
    tracesEndpoint: tracesEndpoint ?? null,
  };
}

export function initializeOtel(bindings?: Record<string, unknown>): void {
  if (state.__iterateOsOtelInitialized) return;

  const traceExporterUrl = resolveTraceExporterUrl(bindings);
  if (!traceExporterUrl) {
    state.__iterateOsOtelInitialized = true;
    return;
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "iterate-os-backend",
      [ATTR_SERVICE_VERSION]: globalThis.process?.env?.npm_package_version || "0.0.0",
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: traceExporterUrl }))],
  });

  trace.setGlobalTracerProvider(provider);
  state.__iterateOsOtelInitialized = true;
}

export async function withExtractedTraceContext<T>(
  headers: Headers,
  fn: () => Promise<T>,
): Promise<T> {
  const extracted = propagation.extract(context.active(), headers, headersGetter) as Context;
  return context.with(extracted, fn);
}
