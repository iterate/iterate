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
