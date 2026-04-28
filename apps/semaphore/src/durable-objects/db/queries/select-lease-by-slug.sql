SELECT lease_id, expires_at
FROM leases
WHERE slug = :slug;
