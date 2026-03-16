-- @query deleteRouteById
DELETE FROM routes
WHERE id = :routeId

-- @query deleteRouteByExternalId
DELETE FROM routes
WHERE external_id = :externalId

-- @query deleteRoutePatternsByRouteId
DELETE FROM route_patterns
WHERE route_id = :routeId

-- @query insertRoutePattern
INSERT INTO route_patterns (route_id, pattern, target, headers)
VALUES (:routeId, :pattern, :target, :headers)

-- @query insertRoute
INSERT INTO routes (id, external_id, metadata)
VALUES (:routeId, :externalId, :metadata)

-- @query selectMatchingRoutePatternsByHost
SELECT
  rp.route_id AS routeId,
  rp.pattern AS pattern,
  rp.target AS target,
  rp.headers AS headers,
  r.metadata AS metadata
FROM route_patterns rp
INNER JOIN routes r ON r.id = rp.route_id
WHERE
  rp.pattern = :host
  OR (
    substr(rp.pattern, 1, 3) = '*__'
    AND length(:host) > length(substr(rp.pattern, 4)) + 2
    AND substr(:host, -length('__' || substr(rp.pattern, 4))) = '__' || substr(rp.pattern, 4)
  )
  OR (
    substr(rp.pattern, 1, 2) = '*.'
    AND length(:host) > length(substr(rp.pattern, 3)) + 1
    AND substr(:host, -length('.' || substr(rp.pattern, 3))) = '.' || substr(rp.pattern, 3)
  )
ORDER BY
  CASE
    WHEN rp.pattern = :host THEN 0
    WHEN substr(rp.pattern, 1, 3) = '*__' THEN 1
    WHEN substr(rp.pattern, 1, 2) = '*.' THEN 2
    ELSE 3
  END ASC,
  length(rp.pattern) DESC,
  rp.id ASC
LIMIT 20

-- @query selectRouteById
SELECT id, external_id, metadata, created_at, updated_at
FROM routes
WHERE id = :routeId

-- @query selectRoutePatternsByRouteId
SELECT id, route_id, pattern, target, headers, created_at, updated_at
FROM route_patterns
WHERE route_id = :routeId
ORDER BY id ASC

-- @query selectRoutePatterns
SELECT id, route_id, pattern, target, headers, created_at, updated_at
FROM route_patterns
ORDER BY route_id ASC, id ASC

-- @query selectRoutes
SELECT id, external_id, metadata, created_at, updated_at
FROM routes
ORDER BY created_at ASC, id ASC

-- @query updateRouteById
UPDATE routes
SET metadata = :metadata, external_id = :externalId, updated_at = CURRENT_TIMESTAMP
WHERE id = :routeId
