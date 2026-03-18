import { os as osBase } from "@orpc/server";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";

export interface AppCliMeta {
  description?: string;
}

/**
 * Shared oRPC base for app-local CLIs.
 */
export const appScriptBase = osBase.$meta<AppCliMeta>({});

/**
 * Static app metadata that belongs to the app definition itself.
 */
export interface AppManifest {
  packageName: string;
  version: string;
  slug: string;
  description: string;
}

/**
 * Base request-scoped fields shared by every app defined with this helper.
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
 */
export type AppInitialContext<TDeps extends object> = AppRequestContextBase & TDeps;

/**
 * Shared websocket event surface used by runtime-agnostic apps.
 */
export interface AppWebSocketEvents {
  onMessage?: (event: MessageEvent, ws: WSContext) => void | Promise<void>;
  onClose?: (event: CloseEvent, ws: WSContext) => void | Promise<void>;
  onError?: (event: Event, ws: WSContext) => void | Promise<void>;
}

/**
 * Minimal upgrade helper contract shared by Node and Cloudflare runtimes.
 */
export type AppUpgradeWebSocket = (
  createEvents: (context: Context) => AppWebSocketEvents | Promise<AppWebSocketEvents>,
) => MiddlewareHandler;

/**
 * The options seen by the runtime entrypoint.
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
 * `defineApp` keeps one boundary explicit:
 *
 * - the runtime entrypoint owns concrete deps such as env, db, and adapters
 * - the app owns route registration plus how those deps become oRPC context
 *
 * This mirrors oRPC's own initial-context model: the adapter passes a request
 * context into the handler, then middleware can grow execution context from
 * there:
 * https://orpc.dev/docs/context
 *
 * The helper stays intentionally small. It does not create a Hono app or impose
 * auth/logging policy; it only standardizes the "mount this runtime-agnostic
 * app into a concrete runtime" step.
 *
 * By default, the initial request context is:
 * `{ manifest, req, ...deps }`
 *
 * That default is meant for the common case where request handlers should see
 * the full dependency bag. Apps can still provide `createRequestContext` when
 * they need a stricter projection boundary.
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
