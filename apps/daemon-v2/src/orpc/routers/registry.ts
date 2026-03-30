import { ORPCError } from "@orpc/server";
import { infoFromContext } from "@iterate-com/shared/jonasland";
import type { AppContext } from "~/context.ts";
import { executeDbRequest, getDbRuntimeData } from "~/lib/registry-db-browser.ts";
import { buildLandingData, listOpenApiSources, listSqliteSources } from "~/lib/registry-docs.ts";
import { ResolvePublicUrlError, resolvePublicUrl } from "~/lib/resolve-public-url.ts";
import { ensureSeededRoutes, synchronizeRegistryRoutes } from "~/lib/registry-startup.ts";
import { os } from "~/orpc/orpc.ts";

async function upsertRouteAndSynchronize(params: {
  input: {
    host: string;
    target: string;
    metadata?: Record<string, string>;
    tags?: string[];
    caddyDirectives?: string[];
  };
  context: AppContext;
}) {
  const store = await params.context.getStore();
  const route = await store.upsertRoute(params.input);
  const sync = await synchronizeRegistryRoutes({
    store,
    env: params.context.env,
  });
  return { route, routes: sync.routes, sync };
}

async function removeRouteAndSynchronize(params: { host: string; context: AppContext }) {
  const store = await params.context.getStore();
  const removed = await store.removeRoute(params.host);
  const sync = await synchronizeRegistryRoutes({
    store,
    env: params.context.env,
  });
  return { removed, routes: sync.routes, sync };
}

export const registryRouter = {
  getPublicURL: os.getPublicURL.handler(async ({ input, context }) => {
    try {
      return {
        publicURL: resolvePublicUrl({
          ITERATE_INGRESS_HOST: context.env.ITERATE_INGRESS_HOST,
          ITERATE_INGRESS_ROUTING_TYPE: context.env.ITERATE_INGRESS_ROUTING_TYPE,
          ITERATE_INGRESS_DEFAULT_APP: context.env.ITERATE_INGRESS_DEFAULT_APP,
          internalURL: input.internalURL,
        }),
      };
    } catch (error) {
      if (error instanceof ResolvePublicUrlError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message, cause: error });
      }
      throw error;
    }
  }),
  landing: {
    get: os.landing.get.handler(async ({ context }) => {
      const routes = await (await context.getStore()).listRoutes();
      return buildLandingData({ routes, env: context.env });
    }),
  },
  docs: {
    listSources: os.docs.listSources.handler(async ({ context }) => {
      const routes = await (await context.getStore()).listRoutes();
      const sources = listOpenApiSources({ routes, env: context.env });
      return { sources, total: sources.length };
    }),
  },
  db: {
    listSources: os.db.listSources.handler(async ({ context }) => {
      const routes = await (await context.getStore()).listRoutes();
      const sources = listSqliteSources({ routes, env: context.env });
      return { sources, total: sources.length };
    }),
    runtime: os.db.runtime.handler(async ({ input, context }) => {
      const routes = await (await context.getStore()).listRoutes();
      return await getDbRuntimeData({
        routes,
        env: context.env,
        mainAlias: input.mainAlias,
      });
    }),
    query: os.db.query.handler(async ({ input, context }) => {
      const routes = await (await context.getStore()).listRoutes();
      return await executeDbRequest({
        routes,
        env: context.env,
        mainAlias: input.mainAlias,
        request: input.request,
      });
    }),
  },
  routes: {
    upsert: os.routes.upsert.handler(async ({ input, context }) => {
      const { route, routes, sync } = await upsertRouteAndSynchronize({ input, context });
      infoFromContext(context, "daemon-v2.routes.upsert", {
        host: route.host,
        route_count: routes.length,
        sync_to_caddy_path: sync.outputPath,
        fragment_written: sync.wroteFragment,
        fragment_changed: sync.changed,
      });
      return { route, routeCount: routes.length };
    }),
    remove: os.routes.remove.handler(async ({ input, context }) => {
      const { removed, routes, sync } = await removeRouteAndSynchronize({
        host: input.host,
        context,
      });
      infoFromContext(context, "daemon-v2.routes.remove", {
        host: input.host,
        removed,
        route_count: routes.length,
        sync_to_caddy_path: sync.outputPath,
        fragment_written: sync.wroteFragment,
        fragment_changed: sync.changed,
      });
      return { removed, routeCount: routes.length };
    }),
    list: os.routes.list.handler(async ({ context }) => {
      const routes = await (await context.getStore()).listRoutes();
      return { routes, total: routes.length };
    }),
  },
  startup: {
    seedRoutes: os.startup.seedRoutes.handler(async ({ context }) => {
      const store = await context.getStore();
      return await ensureSeededRoutes({
        store,
        env: context.env,
      });
    }),
    initialize: os.startup.initialize.handler(async ({ context }) => {
      const store = await context.getStore();
      const seeded = await ensureSeededRoutes({
        store,
        env: context.env,
      });
      const sync = await synchronizeRegistryRoutes({
        store,
        env: context.env,
      });
      return {
        seededCount: seeded.seededCount,
        routeCount: sync.routes.length,
      };
    }),
  },
  config: {
    get: os.config.get.handler(async ({ input, context }) => {
      const entry = await (await context.getStore()).getConfig(input.key);
      return { found: entry !== null, ...(entry ? { entry } : {}) };
    }),
    set: os.config.set.handler(async ({ input, context }) => {
      const entry = await (
        await context.getStore()
      ).setConfig({
        key: input.key,
        value: input.value,
      });
      return { entry };
    }),
    list: os.config.list.handler(async ({ context }) => {
      const entries = await (await context.getStore()).listConfig();
      return { entries, total: entries.length };
    }),
  },
};
