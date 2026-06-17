import type { Client } from "sqlfu";
import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import type { AuthenticatedSession } from "@iterate-com/auth/server";
import type { AppConfig } from "~/config.ts";
import type { Principal } from "~/auth/principal.ts";

/**
 * Per-request server context, passed to TanStack Start's server handler in
 * `workers/app.ts` and from there into server routes and server functions
 * (https://tanstack.com/start/latest/docs/framework/react/guide/server-routes).
 *
 * This holds request-scoped state only. Worker bindings (durable object
 * namespaces, AI, the worker loader, ...) are not threaded through here — use
 * `import { env } from "cloudflare:workers"` wherever you need them:
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global
 */
export interface RequestContext {
  /** Runtime config with `baseUrl` defaulted to the request origin. */
  config: AppConfig;
  /** sqlfu client over the worker's D1 database (`env.DB`). */
  db: Client;
  log: SharedRequestLogger;
  rawRequest?: Request;
  /** `ExecutionContext.waitUntil`, for work that should outlive the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * `ExecutionContext.exports` — loopback bindings to this worker's own RPC
   * entrypoints. Unlike env bindings there is no importable module-level
   * equivalent, so requests carry it.
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#loopback-bindings
   */
  workerExports?: Cloudflare.Exports;
  // Set by the iterate auth request middleware (src/auth/middleware.ts).
  principal?: Principal | null;
  iterateAuthSession?: AuthenticatedSession | null;
}

// Register the request context for both public module surfaces used by Start:
// - server-entry's `handler.fetch` reads `Register` from @tanstack/react-router
// - createServerFn/createMiddleware read it through @tanstack/react-start
//
// TanStack's docs show the react-router augmentation for handler.fetch. In this
// installed package set, removing the react-start augmentation makes server
// functions and request middleware lose the base Worker context and see only
// middleware-added fields.
//
// TODO: Retest this when upgrading TanStack Start; ideally the documented
// react-router augmentation should be enough.
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
