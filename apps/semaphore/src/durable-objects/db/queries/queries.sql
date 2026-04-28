/** @name deleteLeaseBySlug */
DELETE FROM leases
WHERE slug = :slug;

/** @name deleteLeaseBySlugAndLeaseId */
DELETE FROM leases
WHERE slug = :slug AND lease_id = :leaseId;

/** @name insertCoordinatorType */
INSERT OR REPLACE INTO metadata (key, value)
VALUES ('type', :type);

/** @name insertEvent */
INSERT INTO events (occurred_at, event, slug, payload)
VALUES (:occurredAt, :event, :slug, :payload);

/** @name insertLease */
INSERT INTO leases (slug, lease_id, expires_at, created_at)
VALUES (:slug, :leaseId, :expiresAt, :createdAt);

/** @name selectActiveLeaseSlugs */
SELECT slug
FROM leases;

/** @name selectCoordinatorType */
SELECT value
FROM metadata
WHERE key = 'type';

/** @name selectExpiredLeases */
SELECT slug, lease_id, expires_at
FROM leases
WHERE expires_at <= :now
ORDER BY expires_at ASC;

/** @name selectLeaseCountBySlug */
SELECT COUNT(*) AS count
FROM leases
WHERE slug = :slug;

/** @name selectLeaseIdBySlug */
SELECT lease_id
FROM leases
WHERE slug = :slug;

/** @name selectLeaseBySlug */
SELECT lease_id, expires_at
FROM leases
WHERE slug = :slug;

/** @name selectNextLease */
SELECT expires_at
FROM leases
ORDER BY expires_at ASC
LIMIT 1;

/** @name updateLeaseExpires */
UPDATE leases
SET expires_at = :expiresAt
WHERE slug = :slug AND lease_id = :leaseId;
