SELECT slug, lease_id, expires_at
FROM leases
WHERE expires_at <= :now
ORDER BY expires_at ASC;
