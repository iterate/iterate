import type { RegistryEnv } from "./context.ts";
import type { PersistedRoute } from "./store.ts";
import { resolvePublicUrl } from "./resolve-public-url.ts";

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

function safePublicUrl(params: { env: RegistryEnv; internalURL: string }): string {
  try {
    return resolvePublicUrl({
      ITERATE_INGRESS_HOST: params.env.ITERATE_INGRESS_HOST,
      ITERATE_INGRESS_ROUTING_TYPE: params.env.ITERATE_INGRESS_ROUTING_TYPE,
      ITERATE_INGRESS_DEFAULT_SERVICE: params.env.ITERATE_INGRESS_DEFAULT_SERVICE,
      internalURL: params.internalURL,
    });
  } catch {
    return params.internalURL;
  }
}

function serviceUrlForRoute(route: PersistedRoute, env: RegistryEnv): string {
  return safePublicUrl({
    env,
    internalURL: `http://${route.host}/`,
  });
}

function docsUrlForRoute(route: PersistedRoute, env: RegistryEnv): string | undefined {
  if (!hasTag(route, "openapi")) return undefined;
  return safePublicUrl({
    env,
    internalURL: `http://${route.host}/api/docs`,
  });
}

export function listOpenApiSources(params: { routes: PersistedRoute[]; env: RegistryEnv }): Array<{
  id: string;
  title: string;
  specUrl: string;
  serviceUrl: string;
}> {
  return params.routes
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
        serviceUrl: serviceUrlForRoute(route, params.env),
      };
    })
    .filter((source): source is NonNullable<typeof source> => source !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
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
  env: RegistryEnv;
}): SqliteRouteSource[] {
  return params.routes
    .filter((route) => hasTag(route, "sqlite"))
    .map((route) => {
      const sqlitePath = route.metadata.sqlitePath?.trim();
      if (!sqlitePath) return null;
      const sqliteAlias = route.metadata.sqliteAlias?.trim() || deriveAliasFromPath(sqlitePath);
      return {
        id: route.host,
        host: route.host,
        title: routeTitle(route),
        publicURL: serviceUrlForRoute(route, params.env),
        sqlitePath,
        sqliteAlias,
        tags: [...route.tags],
        updatedAt: route.updatedAt,
      };
    })
    .filter((source): source is SqliteRouteSource => source !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function buildLandingData(params: { routes: PersistedRoute[]; env: RegistryEnv }) {
  const docsSources = listOpenApiSources(params);
  const dbSources = listSqliteSources(params);
  return {
    ingress: {
      ITERATE_INGRESS_HOST: params.env.ITERATE_INGRESS_HOST ?? null,
      ITERATE_INGRESS_ROUTING_TYPE: params.env.ITERATE_INGRESS_ROUTING_TYPE,
      ITERATE_INGRESS_DEFAULT_SERVICE: params.env.ITERATE_INGRESS_DEFAULT_SERVICE,
    },
    routes: params.routes
      .map((route) => ({
        ...route,
        title: routeTitle(route),
        publicURL: serviceUrlForRoute(route, params.env),
        ...(docsUrlForRoute(route, params.env)
          ? { docsURL: docsUrlForRoute(route, params.env) }
          : {}),
        hasOpenAPI: hasTag(route, "openapi"),
        hasSqlite: hasTag(route, "sqlite"),
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    docsSources,
    dbSources,
  };
}
