import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeEnv } from "~/context.ts";
import { renderRegistryRoutesFragment } from "~/lib/registry-caddy-sync.ts";
import type { RegistryStore } from "~/lib/registry-store.ts";

const LEGACY_BUILTIN_SEED_HOSTS = new Set([
  "openobserve.iterate.localhost",
  "registry.iterate.localhost",
  "otel-collector.iterate.localhost",
]);

let initializePromise: Promise<void> | null = null;

async function synchronizeRouteFragmentFromStore(params: {
  store: RegistryStore;
  env: RuntimeEnv;
}) {
  const routes = await params.store.listRoutes();
  const syncToCaddyPath = params.env.SYNC_TO_CADDY_PATH;
  if (!syncToCaddyPath) {
    return {
      routes,
      wroteFragment: false,
      changed: false,
      outputPath: null,
    };
  }
  const renderedFragment = renderRegistryRoutesFragment({
    routes,
    iterateIngressHost: params.env.ITERATE_INGRESS_HOST,
    iterateIngressDefaultApp: params.env.ITERATE_INGRESS_DEFAULT_APP,
  });
  const currentFragment = await readFile(syncToCaddyPath, "utf8").catch(() => "");
  if (currentFragment === renderedFragment) {
    return {
      routes,
      wroteFragment: true,
      changed: false,
      outputPath: syncToCaddyPath,
    };
  }

  await mkdir(dirname(syncToCaddyPath), { recursive: true });
  const tempPath = `${syncToCaddyPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, renderedFragment, "utf8");
  await rename(tempPath, syncToCaddyPath);

  return {
    routes,
    wroteFragment: true,
    changed: true,
    outputPath: syncToCaddyPath,
  };
}

export async function ensureSeededRoutes(params: { store: RegistryStore; env: RuntimeEnv }) {
  const existingRoutes = await params.store.listRoutes();
  for (const route of existingRoutes) {
    if (route.metadata.source !== "registry-seed") continue;
    if (!LEGACY_BUILTIN_SEED_HOSTS.has(route.host)) continue;
    await params.store.removeRoute(route.host);
  }

  const seededRoutes: Array<{
    host: string;
    target: string;
    metadata: Record<string, string>;
    tags: string[];
    caddyDirectives?: string[];
  }> = [];

  for (const route of seededRoutes) {
    await params.store.upsertRoute({
      host: route.host,
      target: route.target,
      metadata: route.metadata,
      tags: [...route.tags],
      caddyDirectives: [...(route.caddyDirectives ?? [])],
    });
  }

  const routes = await params.store.listRoutes();
  return {
    seededCount: seededRoutes.length,
    routeCount: routes.length,
  };
}

export async function synchronizeRegistryRoutes(params: { store: RegistryStore; env: RuntimeEnv }) {
  return await synchronizeRouteFragmentFromStore(params);
}

export async function initializeDaemonV2(params: {
  env: RuntimeEnv;
  getStore: () => Promise<RegistryStore>;
}) {
  if (initializePromise) {
    await initializePromise;
    return;
  }

  initializePromise = (async () => {
    const store = await params.getStore();

    await ensureSeededRoutes({
      store,
      env: params.env,
    });
    await synchronizeRegistryRoutes({
      store,
      env: params.env,
    });
  })();

  await initializePromise;
}
