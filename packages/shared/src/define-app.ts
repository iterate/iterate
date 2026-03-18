import { os as osBase } from "@orpc/server";
import type { Hono } from "hono";
import type { AdapterInstance, AdapterOptions } from "crossws";

export interface AppCliMeta {
  description?: string;
}

/**
 * Shared oRPC base for app-local CLIs.
 *
 * Apps commonly need CLI metadata on their local script procedures. We
 * export the base once here so each app does not need its own tiny `_cli.ts`
 * shim just to call `os.$meta<AppCliMeta>({})`.
 */
export const appScriptBase = osBase.$meta<AppCliMeta>({});

/**
 * Static app metadata that belongs to the app definition itself.
 *
 * These values are stable across runtimes. Node and Cloudflare may provide
 * different databases, env bindings, or websocket adapter instances, but they
 * should still be wiring up the same logical app.
 *
 * We keep this intentionally small for now:
 * - `packageName` and `version` come from `package.json`
 * - `slug` is the short runtime-agnostic name we use inside the app
 * - `description` is a human-readable sentence for docs/tooling
 */
export interface AppManifest {
  packageName: string;
  version: string;
  slug: string;
  description: string;
}

/**
 * Base initial oRPC context for every app defined with this helper.
 *
 * Important nuance:
 * - This is the INITIAL context, not the final execution context.
 * - Middleware is free to add more fields later.
 * - `req` is always present so middleware can inspect the incoming request
 *   without forcing every runtime entrypoint to thread `Request` manually
 *   through its own custom context shape.
 *
 * We intentionally keep this base type small because we do not want runtime
 * entrypoints such as `server.ts` or `worker.ts` to be forced to construct
 * fields that really belong to middleware. Parsed runtime `env` is the main
 * exception: it is runtime-owned data that is frequently needed by handlers and
 * middleware, so it belongs in the initial context contract. If auth or
 * organization middleware adds `user`, `session`, or other derived values in
 * the future, those should still stay middleware-owned rather than leaking into
 * the runtime wiring contract.
 */
export interface AppInitialContext<TEnv> {
  manifest: AppManifest;
  req: Request;
  env: TEnv;
}

/**
 * The runtime-specific part of the initial context.
 *
 * Runtime callers provide this object. It contains only the fields that truly
 * belong to the runtime, such as parsed `env`, `db`, or other runtime-owned
 * resources. The app module itself is responsible for adding `manifest` and the
 * live `Request` when it assembles the full initial oRPC context.
 */
export type RuntimeOrpcContext<TInitialOrpcContext extends AppInitialContext<unknown>> = Omit<
  TInitialOrpcContext,
  "manifest" | "req"
>;

/**
 * The options seen by the runtime entrypoint.
 *
 * Runtime callers provide only the runtime-owned portion of context.
 *
 * `defineApp` deliberately does not synthesize a higher-level
 * `createInitialOrpcContext` callback for the app definition anymore. The app
 * module is the place that actually has two of the missing pieces:
 *
 * - the app's own static `manifest`
 * - the live `Request` at the HTTP / websocket callsite
 *
 * The runtime callback contributes the third piece:
 *
 * - parsed runtime `env` and other runtime-owned resources
 *
 * Keeping `createRuntimeOrpcContext` visible inside `app.ts` makes the data
 * flow more obvious and removes one layer of indirection.
 */
export interface AttachAppRuntimeOptions<
  TInitialOrpcContext extends AppInitialContext<TEnv>,
  TEnv,
  TCrossws extends AdapterInstance,
> {
  honoApp: Hono;
  crosswsAdapter: (options: AdapterOptions) => TCrossws;
  createRuntimeOrpcContext: () => RuntimeOrpcContext<TInitialOrpcContext>;
}

export interface AttachAppRuntimeResult<TCrossws extends AdapterInstance> {
  honoApp: Hono;
  crossws: TCrossws;
}

/**
 * Public shape of a runtime-agnostic app definition.
 */
export interface DefinedApp<TInitialOrpcContext extends AppInitialContext<TEnv>, TEnv> {
  manifest: AppManifest;
  attachRuntime: <TCrossws extends AdapterInstance>(
    options: AttachAppRuntimeOptions<TInitialOrpcContext, TEnv, TCrossws>,
  ) => Promise<AttachAppRuntimeResult<TCrossws>>;
}

/**
 * `defineApp` is intentionally small and boring.
 *
 * It does not create a Hono app.
 * It does not create a CrossWS server.
 * It does not register routes or install middleware.
 *
 * The goal is only to make one boundary explicit:
 *
 * 1. The app definition owns static metadata and shared routing/websocket logic.
 * 2. The runtime entrypoint owns concrete runtime resources.
 *
 * This split came from wanting to stay runtime-agnostic. We do not know yet
 * whether an app should ultimately run on Node, Cloudflare Workers, or
 * something else. By keeping the app definition separate from runtime wiring,
 * we can reuse the same app logic across multiple runtimes.
 *
 * The most subtle part of this helper is the context typing:
 *
 * - `TInitialOrpcContext` represents only the INITIAL context passed into oRPC.
 * - Middleware can extend that into a richer EXECUTION context later.
 * - `AppInitialContext<TEnv>` makes parsed runtime env a first-class part of
 *   the initial context contract.
 * - Runtime callers provide only `RuntimeOrpcContext<T>`, i.e. the initial
 *   context minus `manifest` and `req` but including `env` and other
 *   runtime-owned values.
 * - The app module itself assembles the full initial context by combining its
 *   own `manifest`, the live `Request`, and `createRuntimeOrpcContext()`,
 *   which includes parsed `env`.
 *
 * This keeps future middleware additions from "blowing up" the runtime API.
 * If middleware later adds `user`, `session`, `organization`, etc., those
 * fields should be inferred through middleware composition rather than added to
 * the runtime contract of `server.ts` and `worker.ts`.
 */
export function defineApp<TInitialOrpcContext extends AppInitialContext<TEnv>, TEnv>(definition: {
  manifest: AppManifest;
  attachRuntime: <TCrossws extends AdapterInstance>(
    options: AttachAppRuntimeOptions<TInitialOrpcContext, TEnv, TCrossws>,
  ) => Promise<AttachAppRuntimeResult<TCrossws>>;
}): DefinedApp<TInitialOrpcContext, TEnv> {
  return definition;
}
