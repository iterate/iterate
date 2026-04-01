CREATE TABLE IF NOT EXISTS preview_assignments (
  preview_environment_identifier TEXT PRIMARY KEY,
  preview_environment_type TEXT NOT NULL,
  preview_environment_app_slug TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  pull_request_head_ref_name TEXT NOT NULL,
  pull_request_head_sha TEXT NOT NULL,
  workflow_run_url TEXT NOT NULL,
  active_lease_id TEXT NOT NULL,
  leased_until INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (repository_full_name, pull_request_number, preview_environment_app_slug)
);

CREATE INDEX IF NOT EXISTS idx_preview_assignments_pr
ON preview_assignments(repository_full_name, pull_request_number, preview_environment_app_slug);

CREATE INDEX IF NOT EXISTS idx_preview_assignments_lease_expiry
ON preview_assignments(leased_until);
