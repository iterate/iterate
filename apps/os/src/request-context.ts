import { getGlobalStartContext } from "@tanstack/react-start";
import type { Client } from "sqlfu";
import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import type { AuthenticatedSession } from "@iterate-com/auth/server";
import type { AppConfig } from "~/config.ts";
import type { Principal } from "~/auth/principal.ts";

/**
 * Per-request server context, passed to TanStack Start's server handler in
 * `workers/app.ts` and from there into server routes, server functions, and oRPC
 * procedures (https://tanstack.com/start/latest/docs/framework/react/guide/server-routes).
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
  // Set by project-scoped oRPC middleware (src/orpc/orpc.ts).
  projectAccess?: {
    projectId: string;
  };
  projectScope?: {
    project: {
      id: string;
      slug: string;
      custom_hostname?: string | null;
      created_at: string;
      updated_at: string;
    };
    projectSlugOrId: string;
  };
}

// Register the request context for both packages: in the installed versions,
// `handler.fetch` (server entry) types its `context` option from
// @tanstack/react-router's Register, while middleware and
// getGlobalStartContext read @tanstack/react-start's. These are distinct
// interfaces, so both need the augmentation.
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

/**
 * Typed access to the request context from server code.
 *
 * `getGlobalStartContext()`'s own return type currently collapses to
 * `undefined` because of a type-level bug in start-client-core's
 * `AssignAllServerRequestContext` when the generated routeTree.gen.ts footer
 * registers `config` on the Register interface (`AssignAllMiddleware<[]>`
 * degenerates to `never`). The runtime value is exactly the context workers/app.ts
 * passes to `handler.fetch`, merged with what the auth request middleware adds
 * — both shapes are fields of RequestContext, so this cast states the truth.
 */
export function getRequestContext(): RequestContext | undefined {
  return getGlobalStartContext() as RequestContext | undefined;
}

/** Like getRequestContext, but for paths where workers/app.ts guarantees a context. */
export function requireRequestContext(context?: RequestContext): RequestContext {
  const resolved = context ?? (getGlobalStartContext() as RequestContext | undefined);
  if (!resolved) {
    throw new Error("Request context missing — handler.fetch was called without a context.");
  }
  return resolved;
}
