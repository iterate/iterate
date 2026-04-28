UPDATE resources
SET lease_state = :leaseState,
  leased_until = :leasedUntil,
  last_acquired_at = :lastAcquiredAt,
  updated_at = :updatedAt
WHERE type = :type AND slug = :slug;
