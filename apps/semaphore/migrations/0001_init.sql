CREATE TABLE IF NOT EXISTS resources (
  type TEXT NOT NULL,
  slug TEXT NOT NULL,
  data TEXT NOT NULL,
  -- Durable Objects remain authoritative for lease coordination. These columns mirror the
  -- current lease view into D1 so operators can inspect inventory and likely timeout data
  -- with a single SQL query without turning D1 into a second source of truth.
  lease_state TEXT NOT NULL DEFAULT 'available',
  leased_until INTEGER,
  last_acquired_at INTEGER,
  last_released_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (type, slug)
);

CREATE INDEX IF NOT EXISTS idx_resources_type_created_at
ON resources(type, created_at, slug);
