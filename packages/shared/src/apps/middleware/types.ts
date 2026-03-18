import type { createRequestLogger } from "../../request-logging.ts";
import type { AppManifest } from "../define-app.ts";

export type AppRequestLogger = ReturnType<typeof createRequestLogger>;

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
 * Request-scoped logging context injected by `useEvlog()`.
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

export interface HasHeaders {
  req: {
    headers: Headers;
  };
}

export interface HasRequestMeta extends HasHeaders {
  manifest: AppManifest;
  req: HasHeaders["req"] & {
    url: string;
    raw?: Request;
  };
}
