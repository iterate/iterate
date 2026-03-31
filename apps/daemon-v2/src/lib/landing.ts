export interface LandingDocsSource {
  id: string;
  title: string;
  specUrl: string;
  appUrl: string;
}

export interface LandingDbSource {
  id: string;
  host: string;
  title: string;
  publicURL: string;
  sqlitePath: string;
  sqliteAlias: string;
  tags: string[];
  updatedAt: string;
}

export interface LandingRoute {
  host: string;
  target: string;
  metadata: Record<string, string>;
  tags: string[];
  caddyDirectives: string[];
  updatedAt: string;
  title: string;
  publicURL: string;
  docsURL?: string;
  hasOpenAPI: boolean;
  hasSqlite: boolean;
}

export interface LandingDataResponse {
  ingress: {
    ITERATE_INGRESS_HOST: string | null;
    ITERATE_INGRESS_ROUTING_TYPE: string;
    ITERATE_INGRESS_DEFAULT_APP: string;
  };
  routes: LandingRoute[];
  docsSources: LandingDocsSource[];
  dbSources: LandingDbSource[];
}

export async function fetchLandingData(): Promise<LandingDataResponse> {
  const response = await fetch("/api/landing");
  if (!response.ok) {
    throw new Error(`Failed to load landing data (${response.status})`);
  }
  return (await response.json()) as LandingDataResponse;
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function hostLabel(value: string) {
  try {
    return new URL(value, window.location.origin).host;
  } catch {
    return value;
  }
}

export function getRouteBySlug(data: LandingDataResponse | undefined, slug: string) {
  return data?.routes.find((route) => route.host === slug);
}

export function getDocsSourceForRoute(data: LandingDataResponse | undefined, route: LandingRoute) {
  const byUrl = new Map(
    (data?.docsSources ?? []).map((source) => [normalizeUrl(source.appUrl), source] as const),
  );
  return byUrl.get(normalizeUrl(route.publicURL));
}

export function getDbSourceForRoute(data: LandingDataResponse | undefined, route: LandingRoute) {
  const byUrl = new Map(
    (data?.dbSources ?? []).map((source) => [normalizeUrl(source.publicURL), source] as const),
  );
  return byUrl.get(normalizeUrl(route.publicURL));
}
