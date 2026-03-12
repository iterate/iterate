CREATE TABLE IF NOT EXISTS resources (
  type TEXT NOT NULL,
  slug TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (type, slug)
);

CREATE INDEX IF NOT EXISTS idx_resources_type_created_at
ON resources(type, created_at, slug);
