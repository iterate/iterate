import { runWideLog, wideLogger, type WideLogSink } from "./wide-log.ts";

const opaqueId = /^[a-zA-Z0-9_-]{1,128}$/;
const w3cTraceparent = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i;

function validHeader(value: string | null, pattern: RegExp) {
  const trimmed = value?.trim();
  return trimmed && pattern.test(trimmed) ? trimmed : undefined;
}

function resolveRequestId(request: Request) {
  return (
    validHeader(request.headers.get("cf-ray"), opaqueId) ??
    validHeader(request.headers.get("x-request-id"), opaqueId) ??
    crypto.randomUUID()
  );
}

function cloudflareRequestFields(request: Request) {
  const cf = Reflect.get(request, "cf");
  if (typeof cf !== "object" || cf === null) return undefined;
  return {
    colo: typeof Reflect.get(cf, "colo") === "string" ? Reflect.get(cf, "colo") : undefined,
    country:
      typeof Reflect.get(cf, "country") === "string" ? Reflect.get(cf, "country") : undefined,
    asn: typeof Reflect.get(cf, "asn") === "number" ? Reflect.get(cf, "asn") : undefined,
  };
}

export function runHttpWideLog<TResponse extends Response>(
  options: {
    request: Request;
    service: string;
    deployment: { environment: string; workerName?: string; version: string };
    fields?: Record<string, unknown>;
    sinks?: readonly WideLogSink[];
    waitUntil?: (promise: Promise<unknown>) => void;
  },
  run: () => TResponse | Promise<TResponse>,
): Promise<TResponse> {
  const url = new URL(options.request.url);
  const path = url.pathname.slice(0, 1_000);
  const cfRay = validHeader(options.request.headers.get("cf-ray"), opaqueId);
  const traceparent = validHeader(options.request.headers.get("traceparent"), w3cTraceparent);
  return runWideLog(
    {
      kind: "http_request",
      fields: {
        service: options.service,
        deployment: options.deployment,
        http: {
          requestId: resolveRequestId(options.request),
          method: options.request.method,
          path,
          cfRay,
          traceparent,
        },
        cloudflare: cloudflareRequestFields(options.request),
        ...options.fields,
      },
      sinks: options.sinks,
      waitUntil: options.waitUntil,
    },
    async () => {
      try {
        const response = await run();
        wideLogger.set({ http: { status: response.status } });
        wideLogger.setOutcome(
          response.status >= 500 ? "server_error" : response.status >= 400 ? "client_error" : "ok",
        );
        wideLogger.setSummary(`HTTP ${options.request.method} ${path} ${response.status}`);
        return response;
      } catch (error) {
        wideLogger.setSummary(`HTTP ${options.request.method} ${path} threw`);
        throw error;
      }
    },
  );
}
