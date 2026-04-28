-- Use IF NOT EXISTS in this introductory migration only: existing Durable
-- Object instances already created these tables via ResourceCoordinator's old
-- initializeSql() helper. The IF NOT EXISTS lets fresh and previously-deployed
-- DO instances both record this migration in sqlfu_migrations.
CREATE TABLE IF NOT EXISTS leases (
  slug TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  event TEXT NOT NULL,
  slug TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leases_expires_at ON leases(expires_at);
