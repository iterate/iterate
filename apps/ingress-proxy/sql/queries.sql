-- @query selectRouteCandidatesByRootHosts
-- Each stored root_host is the canonical deployment ingress host and maps to
-- the deployment env var ITERATE_INGRESS_HOST.
--
-- The worker derives alternate public host forms from
-- ITERATE_INGRESS_ROUTING_TYPE without storing extra rows:
--   1. exact root host:      root.example.com
--   2. dunder-prefix host:   service__root.example.com
--   3. subdomain-host form:  service.root.example.com
--
-- The resolver computes up to three candidate root hosts in TypeScript, then
-- does exact equality checks here so the lookup stays simple and deterministic.
SELECT
  id,
  root_host AS rootHost,
  target_url AS targetUrl,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM ingress_proxy_route
WHERE
  root_host = :exactRootHost
  OR (:dunderRootHost IS NOT NULL AND root_host = :dunderRootHost)
  OR (:subhostRootHost IS NOT NULL AND root_host = :subhostRootHost)
ORDER BY
  CASE
    WHEN root_host = :exactRootHost THEN 0
    WHEN :dunderRootHost IS NOT NULL AND root_host = :dunderRootHost THEN 1
    WHEN :subhostRootHost IS NOT NULL AND root_host = :subhostRootHost THEN 2
    ELSE 3
  END ASC,
  length(root_host) DESC,
  root_host ASC
LIMIT 10

-- @query selectRouteByRootHost
-- Reads the canonical row for a deployment ingress host.
SELECT
  id,
  root_host AS rootHost,
  target_url AS targetUrl,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM ingress_proxy_route
WHERE root_host = :rootHost

-- @query selectRoutesPage
SELECT
  id,
  root_host AS rootHost,
  target_url AS targetUrl,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM ingress_proxy_route
ORDER BY created_at DESC, root_host ASC
LIMIT :limit OFFSET :offset

-- @query countRoutes
SELECT count(*) AS total
FROM ingress_proxy_route

-- @query upsertRouteByRootHost
-- One row per ITERATE_INGRESS_HOST. Re-registering the same root host updates
-- the target and metadata in place while preserving the original stable id.
INSERT INTO ingress_proxy_route (id, root_host, target_url, metadata_json)
VALUES (:id, :rootHost, :targetUrl, :metadataJson)
ON CONFLICT(root_host) DO UPDATE SET
  target_url = excluded.target_url,
  metadata_json = excluded.metadata_json,
  updated_at = CURRENT_TIMESTAMP

-- @query deleteRouteByRootHost
-- Deleting the canonical root row removes all public host shapes derived from
-- ITERATE_INGRESS_HOST and ITERATE_INGRESS_ROUTING_TYPE.
DELETE FROM ingress_proxy_route
WHERE root_host = :rootHost
