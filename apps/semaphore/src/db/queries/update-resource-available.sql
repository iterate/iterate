UPDATE resources
SET lease_state = :leaseState,
  leased_until = :leasedUntil,
  last_released_at = COALESCE(:lastReleasedAt, last_released_at),
  updated_at = :updatedAt
WHERE type = :type AND slug = :slug;
