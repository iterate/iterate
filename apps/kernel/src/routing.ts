// ---------------------------------------------------------------------------
// The INGRESS ROUTING TABLE — "which project does this hostname belong to" — a control-plane concern
// (ADR 0005/0020/0025). Design: ../os/docs/simplification/wayfinder/DECISIONS.md (0020, 0025).
//
// Two inputs, in precedence order (ADR 0025 — "config and KV are the two inputs"):
//   1. CONFIG  — static `host -> {projectId, app}` routes declared in APP_CONFIG (read-only).
//   2. KV      — a dynamic `ROUTING_KV` namespace (`route:<host>` keys), written at runtime
//                (map a custom domain to a project). Absent => config-only, read-only.
//
// Ingress consults routing BEFORE the `<slug>.<hostBase>` convention (kernel.ts `resolveIngress`), so a
// custom domain (`example.com`) or a single-project self-host (one domain, no wildcard base) works with
// NO wildcard cert — you just need one routing entry. The convention remains the zero-config fallback.
// ---------------------------------------------------------------------------

// A hostname resolves to a project and one of its apps ("" = the default/public app; "dashboard" = the
// kernel-reserved control plane). Same shape `resolveIngress` returns, so the two are interchangeable.
export type Route = { projectId: string; app: string };

// Static routes from APP_CONFIG (the config input). `app` defaults to "" (the public app).
export type RouteConfig = Record<string, { projectId: string; app?: string }>;

// The structural slice of a KV namespace routing needs — get/put/delete — so this module stays free of
// the ambient `KVNamespace` type and unit-tests against a Map-backed mock (mirrors directory.ts KVLike).
export type RoutingKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type Routing = {
  // Resolve a hostname (config first, then KV). null => not a mapped host (fall back to the convention).
  lookup(host: string): Promise<Route | null>;
  // Point a hostname at a project (a custom domain). Needs ROUTING_KV — config routes are read-only.
  map(host: string, route: Route): Promise<void>;
  unmap(host: string): Promise<void>;
};

const routeKey = (host: string) => `route:${host.toLowerCase()}`;

export function routingFor(
  cfg: { routes?: RouteConfig },
  env: { ROUTING_KV?: RoutingKV },
): Routing {
  const staticRoutes = cfg.routes ?? {};
  const kv = env.ROUTING_KV;
  return {
    async lookup(host) {
      const h = host.toLowerCase();
      const s = staticRoutes[h];
      if (s) return { projectId: s.projectId, app: s.app ?? "" };
      if (kv) {
        const raw = await kv.get(routeKey(h));
        if (raw) return JSON.parse(raw) as Route;
      }
      return null;
    },
    async map(host, route) {
      if (!kv)
        throw new Error(
          "routing table is read-only (no ROUTING_KV binding); host routes come from config",
        );
      await kv.put(routeKey(host), JSON.stringify(route));
    },
    async unmap(host) {
      if (!kv) throw new Error("routing table is read-only (no ROUTING_KV binding)");
      await kv.delete(routeKey(host));
    },
  };
}
