import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import type { AppConfig } from "~/config.ts";
import type { Env } from "~/env.ts";

/**
 * Per-request server context, passed to TanStack Start's server handler in
 * `worker.ts` and from there into server routes and oRPC procedures.
 *
 * `env` is carried here because semaphore's resource procedures address the
 * `RESOURCE_COORDINATOR` durable object and `DB` per request; everything else
 * is request-scoped state.
 */
export interface RequestContext {
  config: AppConfig;
  env: Env;
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
