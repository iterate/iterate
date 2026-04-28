UPDATE leases
SET expires_at = :expiresAt
WHERE slug = :slug AND lease_id = :leaseId;
