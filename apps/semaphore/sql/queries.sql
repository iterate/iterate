-- @query selectResources
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
ORDER BY type ASC, created_at ASC, slug ASC

-- @query selectResourcesByType
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = :type
ORDER BY created_at ASC, slug ASC

-- @query insertResourceRow
INSERT INTO resources (type, slug, data)
VALUES (:type, :slug, :data)

-- @query selectResourceByTypeAndSlug
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = :type AND slug = :slug

-- @query deleteResourceByTypeAndSlug
DELETE FROM resources
WHERE type = :type AND slug = :slug

-- @query selectResourcePresenceByType
SELECT 1 AS present
FROM resources
WHERE type = :type
LIMIT 1

-- @query updateResourceLeased
UPDATE resources
SET lease_state = 'leased',
  leased_until = :leasedUntil,
  last_acquired_at = :lastAcquiredAt,
  updated_at = CURRENT_TIMESTAMP
WHERE type = :type AND slug = :slug

-- @query updateResourceAvailable
UPDATE resources
SET lease_state = 'available',
  leased_until = NULL,
  last_released_at = COALESCE(:lastReleasedAt, last_released_at),
  updated_at = CURRENT_TIMESTAMP
WHERE type = :type AND slug = :slug
