import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const state = globalThis as typeof globalThis & {
  __iterateDaemonOtelSdk?: NodeSDK;
  __iterateDaemonOtelStarted?: boolean;
};

const DEFAULT_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces";

function resolveTraceExporterUrl(): string | undefined {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return DEFAULT_OTLP_TRACES_ENDPOINT;
  const normalized = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${normalized}/v1/traces`;
}

export function getOtelConfig() {
  const tracesEndpoint = resolveTraceExporterUrl();
  return {
    enabled: Boolean(tracesEndpoint),
    tracesEndpoint: tracesEndpoint ?? null,
  };
}

export async function initializeOtel(): Promise<void> {
  if (state.__iterateDaemonOtelStarted) return;

  const traceExporterUrl = resolveTraceExporterUrl();
  if (!traceExporterUrl) {
    state.__iterateDaemonOtelStarted = true;
    return;
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "iterate-daemon",
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
    }),
    traceExporter: new OTLPTraceExporter({ url: traceExporterUrl }),
  });

  await sdk.start();
  state.__iterateDaemonOtelSdk = sdk;
  state.__iterateDaemonOtelStarted = true;
}

export async function shutdownOtel(): Promise<void> {
  if (!state.__iterateDaemonOtelSdk) return;
  await state.__iterateDaemonOtelSdk.shutdown();
  state.__iterateDaemonOtelSdk = undefined;
}
