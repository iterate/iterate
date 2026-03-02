SELECT id, route_id, pattern, target, headers, created_at, updated_at
FROM route_patterns
WHERE route_id = :routeId
ORDER BY id ASC
