import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import type { AppConfig } from "~/config.ts";

/**
 * Per-request server context, passed to TanStack Start's server handler in
 * `worker.ts` and from there into server routes and oRPC procedures.
 *
 * Request-scoped state only. Worker bindings (RESOURCE_COORDINATOR, DB, ...)
 * are read via `import { env } from "cloudflare:workers"` at point of use, the
 * same as apps/os. `db` stays here because SSR route loaders use it directly.
 */
export interface RequestContext {
  config: AppConfig;
  db: D1Database;
  log: SharedRequestLogger;
  rawRequest?: Request;
}

// Registered on both packages: handler.fetch reads react-router's Register
// while middleware/getGlobalStartContext read react-start's.
declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: RequestContext;
    };
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: RequestContext;
    };
  }
}
