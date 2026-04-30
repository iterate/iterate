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

create index idx_projects_created_at on projects (created_at);
create index idx_projects_clerk_org_id on projects (clerk_org_id);

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

create index idx_project_presets_project_id on project_presets (project_id);
create index idx_project_presets_created_at on project_presets (created_at);
