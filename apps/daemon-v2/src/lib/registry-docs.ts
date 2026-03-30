import type { RuntimeEnv } from "~/context.ts";
import type { PersistedRoute } from "~/lib/registry-store.ts";
import { resolvePublicUrl } from "~/lib/resolve-public-url.ts";

export interface SqliteRouteSource {
  id: string;
  host: string;
  title: string;
  publicURL: string;
  sqlitePath: string;
  sqliteAlias: string;
  tags: string[];
  updatedAt: string;
}

function hasTag(route: PersistedRoute, tag: string): boolean {
  return route.tags.some((entry) => entry.toLowerCase() === tag.toLowerCase());
}

function normalizeOpenApiPath(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function routeTitle(route: PersistedRoute): string {
  return route.metadata.title?.trim() || route.host;
}

function safePublicUrl(params: { env: RuntimeEnv; internalURL: string }): string {
  try {
    return resolvePublicUrl({
      ITERATE_INGRESS_HOST: params.env.ITERATE_INGRESS_HOST,
      ITERATE_INGRESS_ROUTING_TYPE: params.env.ITERATE_INGRESS_ROUTING_TYPE,
      ITERATE_INGRESS_DEFAULT_APP: params.env.ITERATE_INGRESS_DEFAULT_APP,
      internalURL: params.internalURL,
    });
  } catch {
    return params.internalURL;
  }
}

function appUrlForRoute(route: PersistedRoute, env: RuntimeEnv): string {
  return safePublicUrl({
    env,
    internalURL: `http://${route.host}/`,
  });
}

function registryInternalHost(env: RuntimeEnv): string {
  return `${env.ITERATE_INGRESS_DEFAULT_APP}.${env.ITERATE_INGRESS_HOST}`;
}

function registryPublicUrl(env: RuntimeEnv): string {
  return safePublicUrl({
    env,
    internalURL: `http://${registryInternalHost(env)}/`,
  });
}

function registryDocsUrl(env: RuntimeEnv): string {
  return safePublicUrl({
    env,
    internalURL: `http://${registryInternalHost(env)}/api/docs`,
  });
}

function registryDocsSource(env: RuntimeEnv) {
  return {
    id: "registry",
    title: "Registry",
    specUrl: "/api/openapi.json",
    appUrl: registryPublicUrl(env),
  };
}

function registrySqliteSource(env: RuntimeEnv): SqliteRouteSource {
  return {
    id: "registry",
    host: "registry",
    title: "Registry",
    publicURL: registryPublicUrl(env),
    sqlitePath: env.REGISTRY_DB_PATH,
    sqliteAlias: deriveAliasFromPath(env.REGISTRY_DB_PATH),
    tags: ["builtin", "sqlite"],
    updatedAt: new Date(0).toISOString(),
  };
}

function docsUrlForRoute(route: PersistedRoute, env: RuntimeEnv): string | undefined {
  if (!hasTag(route, "openapi")) return undefined;
  return safePublicUrl({
    env,
    internalURL: `http://${route.host}/api/docs`,
  });
}

export function listOpenApiSources(params: { routes: PersistedRoute[]; env: RuntimeEnv }): Array<{
  id: string;
  title: string;
  specUrl: string;
  appUrl: string;
}> {
  const discoveredSources = params.routes
    .filter((route) => hasTag(route, "openapi"))
    .map((route) => {
      const openApiPath = normalizeOpenApiPath(route.metadata.openapiPath);
      if (openApiPath.length === 0) return null;
      return {
        id: route.host,
        title: routeTitle(route),
        specUrl: safePublicUrl({
          env: params.env,
          internalURL: `http://${route.host}${openApiPath}`,
        }),
        appUrl: appUrlForRoute(route, params.env),
      };
    })
    .filter((source): source is NonNullable<typeof source> => source !== null);

  const sourcesById = new Map(discoveredSources.map((source) => [source.id, source] as const));
  sourcesById.set("registry", registryDocsSource(params.env));
  return Array.from(sourcesById.values()).sort((a, b) => a.title.localeCompare(b.title));
}

export function deriveAliasFromPath(filePath: string): string {
  const withoutExt = filePath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const normalized = withoutExt.replaceAll(/[^A-Za-z0-9_]/g, "_").replaceAll(/_+/g, "_");
  if (!normalized) return "db";
  if (/^[0-9]/.test(normalized)) return `db_${normalized}`;
  return normalized;
}

export function listSqliteSources(params: {
  routes: PersistedRoute[];
  env: RuntimeEnv;
}): SqliteRouteSource[] {
  const discoveredSources = params.routes
    .filter((route) => hasTag(route, "sqlite"))
    .map((route) => {
      const sqlitePath = route.metadata.sqlitePath?.trim();
      if (!sqlitePath) return null;
      const sqliteAlias = route.metadata.sqliteAlias?.trim() || deriveAliasFromPath(sqlitePath);
      return {
        id: route.host,
        host: route.host,
        title: routeTitle(route),
        publicURL: appUrlForRoute(route, params.env),
        sqlitePath,
        sqliteAlias,
        tags: [...route.tags],
        updatedAt: route.updatedAt,
      };
    })
    .filter((source): source is SqliteRouteSource => source !== null);

  const sourcesById = new Map(discoveredSources.map((source) => [source.id, source] as const));
  sourcesById.set("registry", registrySqliteSource(params.env));
  return Array.from(sourcesById.values()).sort((a, b) => a.title.localeCompare(b.title));
}

export function buildLandingData(params: { routes: PersistedRoute[]; env: RuntimeEnv }) {
  const docsSources = listOpenApiSources(params);
  const dbSources = listSqliteSources(params);
  const routesByHost = new Map(
    params.routes.map((route) => [
      route.host,
      {
        ...route,
        title: routeTitle(route),
        publicURL: appUrlForRoute(route, params.env),
        ...(docsUrlForRoute(route, params.env)
          ? { docsURL: docsUrlForRoute(route, params.env) }
          : {}),
        hasOpenAPI: hasTag(route, "openapi"),
        hasSqlite: hasTag(route, "sqlite"),
      },
    ]),
  );
  routesByHost.set(registryInternalHost(params.env), {
    host: registryInternalHost(params.env),
    target: `127.0.0.1:${params.env.REGISTRY_APP_PORT}`,
    metadata: {
      source: "registry-builtin",
      title: "Registry",
      openapiPath: "/api/openapi.json",
      sqlitePath: params.env.REGISTRY_DB_PATH,
      sqliteAlias: deriveAliasFromPath(params.env.REGISTRY_DB_PATH),
    },
    tags: ["builtin", "registry", "openapi", "sqlite"],
    caddyDirectives: [],
    updatedAt: new Date(0).toISOString(),
    title: "Registry",
    publicURL: registryPublicUrl(params.env),
    docsURL: registryDocsUrl(params.env),
    hasOpenAPI: true,
    hasSqlite: true,
  });

  return {
    ingress: {
      ITERATE_INGRESS_HOST: params.env.ITERATE_INGRESS_HOST ?? null,
      ITERATE_INGRESS_ROUTING_TYPE: params.env.ITERATE_INGRESS_ROUTING_TYPE,
      ITERATE_INGRESS_DEFAULT_APP: params.env.ITERATE_INGRESS_DEFAULT_APP,
    },
    routes: Array.from(routesByHost.values()).sort((a, b) => a.title.localeCompare(b.title)),
    docsSources,
    dbSources,
  };
}
