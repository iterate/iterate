SELECT
  rp.route_id AS routeId,
  rp.pattern AS pattern,
  rp.target AS target,
  rp.headers AS headers,
  r.metadata AS metadata
FROM route_patterns rp
INNER JOIN routes r ON r.id = rp.route_id
WHERE :host GLOB rp.pattern
ORDER BY
  CASE WHEN rp.pattern NOT LIKE '%*%' THEN 1 ELSE 0 END DESC,
  length(rp.pattern) DESC,
  rp.id ASC
LIMIT 1
