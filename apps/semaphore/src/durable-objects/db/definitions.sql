CREATE TABLE leases (
  slug TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  event TEXT NOT NULL,
  slug TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_leases_expires_at ON leases(expires_at);
