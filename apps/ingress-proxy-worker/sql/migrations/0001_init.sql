-- Ingress proxy route registry.
--
-- This database stores one canonical row per deployed project ingress host.
-- `root_host` matches the deployment env var `ITERATE_INGRESS_HOST`.
--
-- The worker does not store separate rows for alternate public hostnames.
-- Instead it derives those forms at request time from
-- `ITERATE_INGRESS_ROUTING_TYPE`:
--   - `dunder-prefix`  => service__<ITERATE_INGRESS_HOST>
--   - `subdomain-host` => service.<ITERATE_INGRESS_HOST>
--
-- Each row also has a stable application-generated `id`. The worker generates
-- this in TypeScript using the shared TypeID helper plus `TYPEID_PREFIX` from
-- env so ids stay explicit across development, staging, and production.
CREATE TABLE IF NOT EXISTS ingress_proxy_route (
  id TEXT PRIMARY KEY,
  root_host TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ingress_proxy_route_created_at
ON ingress_proxy_route(created_at, root_host);
