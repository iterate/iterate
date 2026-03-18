import { os } from "@orpc/server";
import { initLogger, type DrainContext } from "evlog";
import { sendBatchToOTLP } from "evlog/otlp";
import { createWorkersLogger, initWorkersLogger } from "evlog/workers";
import { createRequestLogger, getRequestIdHeader } from "../../request-logging.ts";
import type { HasRequestMeta, RequestLoggerContext } from "./types.ts";

let didInitializeNodeEvlog = false;
let didInitializeWorkersEvlog = false;

function joinProcedurePath(path: readonly string[] | string | undefined): string | undefined {
  if (Array.isArray(path)) return path.join(".");
  return typeof path === "string" ? path : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function isRequest(value: unknown): value is Request {
  return value instanceof Request;
}

function isWorkersRuntime() {
  return "WebSocketPair" in globalThis;
}

function normalizeBaseEndpoint(url: string) {
  return url.replace(/\/+$/, "");
}

function resolveDrainEndpoint(): string | undefined {
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

function createSilentOTLPDrain(endpoint: string): (ctx: DrainContext) => Promise<void> {
  let logged = false;

  return async (ctx: DrainContext) => {
    try {
      await sendBatchToOTLP([ctx.event], { endpoint });
    } catch {
      if (logged) return;

      logged = true;
      console.warn(
        `[evlog/otlp] OTLP endpoint ${endpoint} unreachable, suppressing further errors`,
      );
    }
  };
}

function ensureEvlogInitialized() {
  const drainEndpoint = resolveDrainEndpoint();
  const commonOptions = {
    env: {
      version: process.env.npm_package_version || "0.0.0",
    },
    ...(drainEndpoint
      ? {
          drain: createSilentOTLPDrain(drainEndpoint),
        }
      : {}),
  };

  if (isWorkersRuntime()) {
    if (didInitializeWorkersEvlog) return;
    initWorkersLogger(commonOptions);
    didInitializeWorkersEvlog = true;
    return;
  }

  if (didInitializeNodeEvlog) return;

  initLogger({
    ...commonOptions,
    pretty: true,
  });
  didInitializeNodeEvlog = true;
}

function formatDurationMs(durationMs: number): string {
  return `${durationMs}ms`;
}

function createContextRequestLogger(options: {
  request: HasRequestMeta["req"];
  requestId: string;
  procedurePath: string | undefined;
}) {
  const path = options.procedurePath ?? new URL(options.request.url).pathname;

  if (isRequest(options.request.raw)) {
    return createWorkersLogger(options.request.raw, {
      requestId: options.requestId,
    });
  }

  return createRequestLogger({
    requestId: options.requestId,
    method: "oRPC",
    path,
  });
}

function buildRequestLogMessage(options: {
  method: string | undefined;
  path: string | undefined;
  status: number;
  durationMs: number;
}) {
  const method = options.method ?? "request";
  const path = options.path ?? "unknown";
  return `${method} ${path} ${options.status} in ${formatDurationMs(options.durationMs)}`;
}

function resolveRequestId(context: HasRequestMeta): string {
  const explicitRequestId = getRequestIdHeader(context.req.headers.get("x-request-id"));
  if (explicitRequestId) return explicitRequestId;

  if (isRequest(context.req.raw)) {
    const cfRay = context.req.raw.headers.get("cf-ray")?.trim();
    if (cfRay) return cfRay;
  }

  return crypto.randomUUID();
}

export function useEvlog() {
  const base = os.$context<HasRequestMeta>();

  return base.middleware(async ({ context, next, path }) => {
    ensureEvlogInitialized();

    const procedurePath = joinProcedurePath(path);
    const requestId = resolveRequestId(context);
    const logger = createContextRequestLogger({
      request: context.req,
      requestId,
      procedurePath,
    });
    const startedAt = Date.now();

    // evlog's request-scoped "wide event" model is: attach stable context as the
    // request progresses, then emit once at the end with outcome fields such as
    // status and duration. That keeps stdout readable in development and avoids
    // scattering request metadata across many log lines while still producing a
    // request-level event that operators can correlate:
    // https://www.evlog.dev/getting-started/introduction
    logger.set({
      app: {
        slug: context.manifest.slug,
        packageName: context.manifest.packageName,
      },
      rpc: {
        url: context.req.url,
        ...(procedurePath ? { procedurePath } : {}),
      },
    });

    let status = 200;

    try {
      return await next({
        context: {
          requestId,
          logger,
        } satisfies RequestLoggerContext,
      });
    } catch (error) {
      status = errorStatus(error) ?? 500;
      logger.error(toError(error));
      throw error;
    } finally {
      const durationMs = Date.now() - startedAt;
      const loggerContext = logger.getContext();
      logger.emit({
        message: buildRequestLogMessage({
          method: typeof loggerContext.method === "string" ? loggerContext.method : undefined,
          path: typeof loggerContext.path === "string" ? loggerContext.path : undefined,
          status,
          durationMs,
        }),
        status,
        durationMs,
      });
    }
  });
}
