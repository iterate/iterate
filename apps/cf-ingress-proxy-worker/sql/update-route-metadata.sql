UPDATE routes
SET metadata = :metadata, updated_at = CURRENT_TIMESTAMP
WHERE id = :routeId
