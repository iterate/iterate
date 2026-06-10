/** @name selectResources */
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
ORDER BY type ASC, created_at ASC, slug ASC;

/** @name selectResourcesByType */
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = :type
ORDER BY created_at ASC, slug ASC;

/** @name insertResourceRow */
INSERT INTO resources (type, slug, data)
VALUES (:type, :slug, :data);

/** @name selectResourceByTypeAndSlug */
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = :type AND slug = :slug;

/** @name deleteResourceByTypeAndSlug */
DELETE FROM resources
WHERE type = :type AND slug = :slug;

/** @name selectResourcePresenceByType */
SELECT 1 AS present
FROM resources
WHERE type = :type
LIMIT 1;

/** @name updateResourceLeased */
UPDATE resources
SET lease_state = 'leased',
  leased_until = :leasedUntil,
  last_acquired_at = :lastAcquiredAt,
  updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
WHERE type = :type AND slug = :slug;

/** @name updateResourceAvailable */
UPDATE resources
SET lease_state = 'available',
  leased_until = NULL,
  last_released_at = COALESCE(:lastReleasedAt, last_released_at),
  updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
WHERE type = :type AND slug = :slug;
