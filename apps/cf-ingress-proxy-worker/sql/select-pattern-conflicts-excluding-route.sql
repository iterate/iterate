SELECT route_id AS routeId, pattern
FROM route_patterns
WHERE pattern IN (:patterns)
  AND route_id != :excludeRouteId
ORDER BY route_id ASC, pattern ASC
