import { os as osBase } from "@orpc/server";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";

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
 * Base request-scoped fields shared by every app defined with this helper.
 *
 * App authors can layer their own request context on top of this, but the
 * manifest and lightweight request metadata are always available to the app
 * definition helper.
 *
 * We intentionally keep only lightweight request metadata here so middleware
 * can inspect the incoming request without forcing every runtime entrypoint to
 * thread a full `Request` object through its own custom context shape.
 */
export interface AppRequestContextBase {
  manifest: AppManifest;
  req: {
    headers: Headers;
    url: string;
  };
}

/**
 * Default request context shape when an app chooses to expose all runtime deps
 * directly to request handlers.
 *
 * This keeps the old "initial context = request metadata + runtime-owned
 * values" pattern available, but the runtime entrypoint itself now speaks only
 * in terms of deps rather than oRPC context internals.
 */
export type AppInitialContext<TDeps extends object> = AppRequestContextBase & TDeps;

/**
 * Shared websocket event surface used by runtime-agnostic apps.
 *
 * Both Node and Cloudflare expose an `upgradeWebSocket` helper in Hono, but
 * Cloudflare does not support `onOpen`. We keep the shared contract inside the
 * overlapping subset so app modules can register websocket routes once without
 * leaking runtime-specific behavior into the app definition.
 */
export interface AppWebSocketEvents {
  onMessage?: (event: MessageEvent, ws: WSContext) => void | Promise<void>;
  onClose?: (event: CloseEvent, ws: WSContext) => void | Promise<void>;
  onError?: (event: Event, ws: WSContext) => void | Promise<void>;
}

/**
 * Minimal upgrade helper contract shared by Node and Cloudflare runtimes.
 *
 * Runtime entrypoints pass their concrete Hono helper through this narrowed
 * function type. Shared app code should treat it as "register a websocket route
 * using the common event subset", not as a place to rely on adapter-specific
 * lifecycle hooks such as Node-only `onOpen`.
 */
export type AppUpgradeWebSocket = (
  createEvents: (context: Context) => AppWebSocketEvents | Promise<AppWebSocketEvents>,
) => MiddlewareHandler;

/**
 * The options seen by the runtime entrypoint.
 *
 * Runtime callers provide only runtime-owned deps such as parsed env, database
 * clients, or runtime-specific adapters. The app definition can then project
 * those deps into request context however it likes.
 */
export interface MountAppOptions<TDeps extends object> {
  app: Hono;
  upgradeWebSocket: AppUpgradeWebSocket;
  getDeps: () => TDeps;
}

/**
 * Public shape of a runtime-agnostic app definition.
 */
export interface DefinedApp<TDeps extends object, TRequestContext extends AppRequestContextBase> {
  manifest: AppManifest;
  mount: (options: MountAppOptions<TDeps>) => Promise<void>;
}

/**
 * `defineApp` is intentionally small and boring.
 *
 * It does not create a Hono app.
 * It does not register routes or install middleware.
 *
 * The goal is only to make one boundary explicit:
 *
 * 1. The app definition owns static metadata and shared routing/websocket logic.
 * 2. The runtime entrypoint owns concrete runtime deps.
 *
 * This split came from wanting to stay runtime-agnostic. We do not know yet
 * whether an app should ultimately run on Node, Cloudflare Workers, or
 * something else. By keeping the app definition separate from runtime wiring,
 * we can reuse the same app logic across multiple runtimes.
 *
 * The most subtle part of this helper is the dep/context typing:
 *
 * - `TDeps` represents runtime-owned dependencies supplied by the entrypoint.
 * - `TRequestContext` represents the INITIAL context passed into oRPC.
 * - Middleware can extend that into a richer EXECUTION context later.
 * - By default, request context is just `AppInitialContext<TDeps>`, i.e. the
 *   shared request metadata plus all deps.
 * - Apps can override `createRequestContext` if they want to expose only a
 *   projection of those deps to request handlers.
 *
 * This keeps future middleware additions from "blowing up" the runtime API.
 * If middleware later adds `user`, `session`, `organization`, etc., those
 * fields should be inferred through middleware composition rather than added to
 * the runtime contract of `server.ts` and `worker.ts`.
 */
export function defineApp<
  TDeps extends object,
  TRequestContext extends AppRequestContextBase = AppInitialContext<TDeps>,
>(definition: {
  manifest: AppManifest;
  createRequestContext?: (options: {
    request: Request;
    manifest: AppManifest;
    deps: TDeps;
  }) => TRequestContext;
  register: (options: {
    app: Hono;
    upgradeWebSocket: AppUpgradeWebSocket;
    getDeps: () => TDeps;
    getRequestContext: (request: Request) => TRequestContext;
  }) => Promise<void>;
}): DefinedApp<TDeps, TRequestContext> {
  const createRequestContext =
    definition.createRequestContext ??
    ((options: { request: Request; manifest: AppManifest; deps: TDeps }) =>
      ({
        manifest: options.manifest,
        req: {
          headers: new Headers(options.request.headers),
          url: options.request.url,
        },
        ...options.deps,
      }) as unknown as TRequestContext);

  return {
    manifest: definition.manifest,
    async mount({ app, upgradeWebSocket, getDeps }) {
      const getRequestContext = (request: Request) =>
        createRequestContext({
          request,
          manifest: definition.manifest,
          deps: getDeps(),
        });

      await definition.register({
        app,
        upgradeWebSocket,
        getDeps,
        getRequestContext,
      });
    },
  };
}
