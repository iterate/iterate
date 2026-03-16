import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serviceLog, getOtelRuntimeConfig } from "@iterate-com/shared/jonasland";
import { createRegistryClient } from "../client.ts";
import { renderRegistryRoutesFragment } from "./caddy-sync.ts";
import { serviceName, type RegistryEnv } from "./context.ts";
import type { ServicesStore } from "./store.ts";

const LEGACY_BUILTIN_SEED_HOSTS = new Set([
  "registry.iterate.localhost",
  "otel-collector.iterate.localhost",
]);

async function synchronizeRouteFragmentFromStore(params: {
  store: ServicesStore;
  env: RegistryEnv;
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
    iterateIngressDefaultService: params.env.ITERATE_INGRESS_DEFAULT_SERVICE,
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

export async function ensureSeededRoutes(params: { store: ServicesStore; env: RegistryEnv }) {
  const existingRoutes = await params.store.listRoutes();
  for (const route of existingRoutes) {
    if (route.metadata.source !== "registry-seed") continue;
    if (!LEGACY_BUILTIN_SEED_HOSTS.has(route.host)) continue;
    await params.store.removeRoute(route.host);
  }

  const seededRoutes = [
    // Seed only registry-owned defaults here. Bootstrap control-plane routes that
    // live in `builtin-handlers.caddy` should not be duplicated into the dynamic
    // fragment written to `SYNC_TO_CADDY_PATH`.
    {
      host: "events.iterate.localhost",
      target: "127.0.0.1:17320",
      tags: ["seeded", "events", "openapi"],
      metadata: {
        source: "registry-seed",
        title: "Events Service",
        openapiPath: "/api/openapi.json",
      },
    },
    {
      host: "openobserve.iterate.localhost",
      target: "127.0.0.1:5080",
      caddyDirectives: [
        'header_up Authorization "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="',
      ],
      tags: ["seeded", "observability"],
      metadata: {
        source: "registry-seed",
        title: "OpenObserve",
      },
    },
  ] as const;

  for (const route of seededRoutes) {
    await params.store.upsertRoute({
      host: route.host,
      target: route.target,
      metadata: route.metadata,
      tags: [...route.tags],
      caddyDirectives: "caddyDirectives" in route ? [...route.caddyDirectives] : [],
    });
  }

  const routes = await params.store.listRoutes();
  return {
    seededCount: seededRoutes.length,
    routeCount: routes.length,
  };
}

export async function synchronizeRegistryRoutes(params: {
  store: ServicesStore;
  env: RegistryEnv;
}) {
  return await synchronizeRouteFragmentFromStore(params);
}

export async function initializeRegistryService(params: { host: string; port: number }) {
  await createRegistryClient({
    url: `http://127.0.0.1:${params.port}`,
  }).startup.initialize({});

  serviceLog.info({
    event: "service.started",
    service: serviceName,
    host: params.host,
    port: params.port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    orpc_path: "/api",
    orpc_ws_path: "/orpc/ws",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });
}
