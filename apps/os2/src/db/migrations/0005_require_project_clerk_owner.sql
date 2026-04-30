-- OS2 projects are Clerk-organization-owned resources. This migration makes
-- that ownership invariant explicit in D1 instead of relying on router-level
-- checks after reads.
--
-- Existing orphan projects should fail this migration rather than being
-- silently adopted into a fake organization, because every OS2 route now
-- requires an active Clerk organization before project creation.
alter table projects rename to __sqlfu_old_projects;
create table projects (
  id text primary key not null,
  slug text not null,
  clerk_org_id text not null,
  created_by_clerk_user_id text not null,
  custom_hostname text unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (clerk_org_id, slug)
);
insert into projects(
  id,
  slug,
  clerk_org_id,
  created_by_clerk_user_id,
  custom_hostname,
  metadata,
  created_at,
  updated_at
)
select
  id,
  slug,
  clerk_org_id,
  created_by_clerk_user_id,
  custom_hostname,
  metadata,
  created_at,
  updated_at
from __sqlfu_old_projects;
drop table __sqlfu_old_projects;
create index idx_projects_created_at on projects (created_at);
create index idx_projects_clerk_org_id on projects (clerk_org_id);

-- SQLite rewrites foreign-key references when the parent table is renamed
-- during a rebuild. Rebuilding project_presets afterwards points the existing
-- preset rows back at the new projects table.
alter table project_presets rename to __sqlfu_old_project_presets;
create table project_presets (
  id text primary key not null,
  project_id text not null references projects (id) on delete cascade,
  name text not null,
  description text,
  events_json text not null check (json_valid(events_json)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (project_id, name)
);
insert into project_presets(id, project_id, name, description, events_json, created_at, updated_at)
select id, project_id, name, description, events_json, created_at, updated_at
from __sqlfu_old_project_presets;
drop table __sqlfu_old_project_presets;
create index idx_project_presets_created_at on project_presets (created_at);
create index idx_project_presets_project_id on project_presets (project_id);
