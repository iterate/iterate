SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = :type
ORDER BY created_at ASC, slug ASC;
