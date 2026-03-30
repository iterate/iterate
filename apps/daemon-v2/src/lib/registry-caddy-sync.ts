interface RouteRecord {
  host: string;
  target: string;
  metadata?: Record<string, string>;
  tags?: string[];
  caddyDirectives?: string[];
}

interface RouteSpec {
  appSlug: string;
  internalHosts: string[];
  upstream: string;
  tags: string[];
  metadata: Record<string, string>;
  extraCaddyDirectives: string[];
}
type CompiledRouteSpec = RouteSpec;

function firstHostToken(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.split(".").find((part) => part.length > 0) ?? "";
}

function toSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "route";
}

function toMatcherId(value: string): string {
  return value.replaceAll(/[^a-z0-9_]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function toCaddyDirectives(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizePublicBaseHostForRouting(rawHost?: string): string | undefined {
  const trimmed = rawHost?.trim();
  if (!trimmed) return undefined;
  try {
    const asUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return asUrl.hostname;
  } catch {
    return undefined;
  }
}

function routeHostsForMatcher(params: {
  internalHosts: string[];
  publicBaseHostForRouting?: string;
  defaultIngressAppSlug?: string;
}): string[] {
  const primaryInternalHost = params.internalHosts[0] ?? "";
  const app = firstHostToken(primaryInternalHost);
  const hosts = [...params.internalHosts];
  if (params.publicBaseHostForRouting && app.length > 0) {
    // We intentionally accept both forms even when URL generation selects one mode.
    hosts.push(`${app}.${params.publicBaseHostForRouting}`);
    hosts.push(`${app}__${params.publicBaseHostForRouting}`);
    if (params.defaultIngressAppSlug?.trim().toLowerCase() === app) {
      hosts.push(params.publicBaseHostForRouting);
    }
  }
  return [...new Set(hosts)];
}

function renderRouteHandleBlock(params: {
  route: CompiledRouteSpec;
  publicBaseHostForRouting?: string;
  defaultIngressAppSlug?: string;
}): string[] {
  const matcherId = `${toMatcherId(`route_${params.route.appSlug}`)}_hosts`;
  const matchHosts = routeHostsForMatcher({
    internalHosts: params.route.internalHosts,
    publicBaseHostForRouting: params.publicBaseHostForRouting,
    defaultIngressAppSlug: params.defaultIngressAppSlug,
  });
  const lines: string[] = [];

  lines.push(`# appSlug: ${params.route.appSlug}`);
  lines.push(`# upstream: ${params.route.upstream}`);
  if (params.route.tags.length > 0) {
    lines.push(`# tags: ${params.route.tags.join(", ")}`);
  }
  lines.push(`# internalHosts: ${params.route.internalHosts.join(", ")}`);
  if (Object.keys(params.route.metadata).length > 0) {
    lines.push(`# metadata: ${JSON.stringify(params.route.metadata)}`);
  }
  if (params.route.extraCaddyDirectives.length > 0) {
    lines.push(`# extraCaddyDirectives: ${JSON.stringify(params.route.extraCaddyDirectives)}`);
  }
  lines.push(`@${matcherId} host ${matchHosts.join(" ")}`);
  lines.push(`handle @${matcherId} {`);
  lines.push(`    vars {`);
  lines.push(`        iterate_app_slug ${params.route.appSlug}`);
  lines.push(`        iterate_upstream ${params.route.upstream}`);
  lines.push(`    }`);
  lines.push(`    import iterate_cors_openapi`);
  lines.push(`    reverse_proxy ${params.route.upstream} {`);
  lines.push(`        import iterate_ingress_upstream_headers`);
  for (const directive of params.route.extraCaddyDirectives) {
    lines.push(`        ${directive}`);
  }
  lines.push(`    }`);
  lines.push(`}`);
  return lines;
}

function renderCompiledRoutesFragment(params: {
  routes: CompiledRouteSpec[];
  iterateIngressHost?: string;
  iterateIngressDefaultApp?: string;
}): string {
  const lines: string[] = [];
  const publicBaseHostForRouting = normalizePublicBaseHostForRouting(params.iterateIngressHost);
  const defaultIngressAppSlug = params.iterateIngressDefaultApp?.trim().toLowerCase();

  lines.push("# managed by registry app (seeded + dynamic routes)");
  lines.push("# Each route renders its own ingress handle block.");
  lines.push("# The root Caddyfile only keeps the built-in bootstrap cache.");
  lines.push("# Keep both subdomain and dunder-prefix host forms routable even when URL");
  lines.push("# generation selects only one form.");

  for (const route of params.routes) {
    lines.push("");
    lines.push(
      ...renderRouteHandleBlock({
        route,
        publicBaseHostForRouting,
        defaultIngressAppSlug,
      }),
    );
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

export function renderRegistryRoutesFragment(params: {
  routes: Array<{
    host: string;
    target: string;
    caddyDirectives?: string[];
    metadata?: Record<string, string>;
    tags?: string[];
  }>;
  iterateIngressHost?: string;
  iterateIngressDefaultApp?: string;
}): string {
  const compiledRoutes = buildCompiledRouteSpecs(
    params.routes.map((route) => ({
      host: route.host,
      target: route.target,
      caddyDirectives: route.caddyDirectives,
      metadata: route.metadata ?? {},
      tags: route.tags ?? [],
    })),
  );
  return renderCompiledRoutesFragment({
    routes: compiledRoutes,
    iterateIngressHost: params.iterateIngressHost,
    iterateIngressDefaultApp: params.iterateIngressDefaultApp,
  });
}

function buildCompiledRouteSpecs(routes: RouteRecord[]): CompiledRouteSpec[] {
  const bySlug = new Map<string, CompiledRouteSpec>();

  for (const route of routes) {
    const host = route.host.trim().toLowerCase();
    const token = firstHostToken(host);
    if (!host || !token) continue;
    const appSlug = toSlug(token);
    const extraCaddyDirectives = toCaddyDirectives(route.caddyDirectives);
    const existing = bySlug.get(appSlug);

    if (existing) {
      existing.internalHosts = [...new Set([...existing.internalHosts, host])];
      existing.upstream = route.target.trim();
      existing.tags = [...new Set([...(existing.tags ?? []), ...(route.tags ?? [])])];
      existing.metadata = { ...existing.metadata, ...(route.metadata ?? {}) };
      existing.extraCaddyDirectives = [
        ...new Set([...existing.extraCaddyDirectives, ...extraCaddyDirectives]),
      ];
      continue;
    }

    bySlug.set(appSlug, {
      appSlug,
      internalHosts: [host],
      upstream: route.target.trim(),
      tags: route.tags ?? [],
      metadata: route.metadata ?? {},
      extraCaddyDirectives,
    });
  }

  return [...bySlug.values()].sort((a, b) => a.appSlug.localeCompare(b.appSlug));
}
