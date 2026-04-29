CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  canonical_hostname TEXT,
  config_json TEXT NOT NULL DEFAULT '{"apps":["agents"]}',
  artifacts_repo TEXT,
  artifacts_remote TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Maps outbound message IDs to their thread root for reply threading
CREATE TABLE IF NOT EXISTS email_thread_map (
  outbound_message_id TEXT PRIMARY KEY,
  thread_root_message_id TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Project-scoped secrets for egress proxy substitution
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_project_name ON secrets (project_slug, name);
