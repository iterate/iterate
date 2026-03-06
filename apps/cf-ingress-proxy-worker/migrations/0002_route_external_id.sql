ALTER TABLE routes
ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_external_id_unique
ON routes(external_id)
WHERE external_id IS NOT NULL;
