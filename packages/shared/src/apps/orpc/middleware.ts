import { randomUUID } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import type { AppManifest } from "../../define-app.ts";
import { createServiceRequestLogger, getRequestIdHeader } from "../../jonasland/index.ts";

/**
 * Shared oRPC middleware for apps built on `defineApp`.
 *
 * These helpers depend only on the stable initial-context contract that every
 * app gets from `defineApp`: app `manifest`, request `headers`, and request
 * `url`. They deliberately avoid depending on runtime-specific resources so
 * Node and Worker apps can share the same middleware surface.
 */
export type AppRequestLogger = ReturnType<typeof createServiceRequestLogger>;

/**
 * Execution-context namespace for values derived directly from request headers.
 *
 * We keep validated header aliases under `headerValues` instead of injecting
 * dynamic top-level keys so middleware provenance stays obvious and future app
 * context fields do not collide with request transport helpers.
 */
export interface HeaderValuesContext {
  headerValues: Record<string, string>;
}

/**
 * Request-scoped logging context injected by `withRequestLogger()`.
 */
export interface RequestLoggerContext {
  requestId: string;
  logger: AppRequestLogger;
}

export type MissingHeaderErrorCode = "BAD_REQUEST" | "UNAUTHORIZED";

export interface RequireHeaderOptions<TContextKey extends string> {
  header: string;
  as: TContextKey;
  missingCode?: MissingHeaderErrorCode;
}

// Minimal initial-context contract needed for header-based middleware.
// Apps may project runtime deps differently, but as long as `req.headers`
// exists these helpers stay reusable.
interface HasHeaders {
  req: {
    headers: Headers;
  };
}

// Minimal initial-context contract needed for request logging.
// `manifest` stays boundary-owned initial context because it is static app
// identity, while `requestId` / `logger` are derived execution-context fields
// added per request.
interface HasRequestMeta extends HasHeaders {
  manifest: AppManifest;
  req: HasHeaders["req"] & {
    url: string;
  };
}

function joinProcedurePath(path: readonly string[] | string | undefined): string | undefined {
  if (Array.isArray(path)) return path.join(".");
  return typeof path === "string" ? path : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Require a non-empty request header and expose it to downstream handlers.
 *
 * This helper is intentionally small:
 * - it checks transport-level presence only
 * - it trims the raw header string
 * - it stores the result under `context.headerValues[...]`
 *
 * Multiple `requireHeader(...)` middlewares compose by merging into the same
 * `headerValues` namespace. Domain-specific parsing or auth should happen in
 * more specific middleware built on top of this primitive.
 */
export function requireHeader<TContextKey extends string>(
  options: RequireHeaderOptions<TContextKey>,
) {
  const base = os.$context<HasHeaders & Partial<HeaderValuesContext>>();

  return base.middleware(async ({ context, next }) => {
    const headerValue = context.req.headers.get(options.header)?.trim();

    if (!headerValue) {
      throw new ORPCError(options.missingCode ?? "BAD_REQUEST", {
        message: `Missing required header: ${options.header}`,
      });
    }

    return next({
      context: {
        headerValues: {
          ...(context.headerValues ?? {}),
          [options.as]: headerValue,
        },
      } satisfies HeaderValuesContext,
    });
  });
}

/**
 * Attach a request-scoped logger for app oRPC procedures.
 *
 * Design notes:
 * - reuses `x-request-id` when present so logs correlate across proxies/services
 * - falls back to a generated id when the app is the edge of the request chain
 * - uses the shared service logger shape so app and service logs look alike
 * - reads app identity from `context.manifest` instead of copying `manifest`
 *   into execution context, because `manifest` is part of the initial app
 *   contract rather than middleware-derived request state
 * - prefers the oRPC procedure path for log readability, but falls back to the
 *   request pathname when procedure metadata is unavailable
 */
export function withRequestLogger() {
  const base = os.$context<HasRequestMeta>();

  return base.middleware(async ({ context, next, path }) => {
    const procedurePath = joinProcedurePath(path);
    const requestId = getRequestIdHeader(context.req.headers.get("x-request-id")) ?? randomUUID();
    // `method` names the logical transport we are observing, not the outer HTTP
    // verb. This keeps app RPC logs grouped as ORPC across adapters.
    const logger = createServiceRequestLogger({
      requestId,
      method: "ORPC",
      path: procedurePath ?? new URL(context.req.url).pathname,
    });
    const startedAt = Date.now();

    logger.set({
      requestId,
      appSlug: context.manifest.slug,
      appPackageName: context.manifest.packageName,
      requestUrl: context.req.url,
      ...(procedurePath ? { procedurePath } : {}),
    });
    logger.info("app.orpc.request.start", {
      event: "app.orpc.request.start",
      appSlug: context.manifest.slug,
      requestUrl: context.req.url,
      ...(procedurePath ? { procedurePath } : {}),
    });

    try {
      const result = await next({
        context: {
          requestId,
          logger,
        } satisfies RequestLoggerContext,
      });
      logger.info("app.orpc.request.success", {
        event: "app.orpc.request.success",
        appSlug: context.manifest.slug,
        requestUrl: context.req.url,
        durationMs: Date.now() - startedAt,
        ...(procedurePath ? { procedurePath } : {}),
      });
      return result;
    } catch (error) {
      logger.error(toError(error), {
        event: "app.orpc.request.error",
        appSlug: context.manifest.slug,
        requestUrl: context.req.url,
        durationMs: Date.now() - startedAt,
        ...(procedurePath ? { procedurePath } : {}),
      });
      throw error;
    }
  });
}
