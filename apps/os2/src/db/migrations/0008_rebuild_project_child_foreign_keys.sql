-- rebuilding table "ingress_routes": foreign keys changed
alter table ingress_routes rename to __sqlfu_old_ingress_routes;
create table ingress_routes (
  id text primary key not null,
  host text not null unique,
  project_id text references projects (id) on delete cascade,
  priority integer not null,
  notes text,
  callable_json text not null check (json_valid(callable_json)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
insert into ingress_routes(id, host, project_id, priority, notes, callable_json, created_at, updated_at) select id, host, project_id, priority, notes, callable_json, created_at, updated_at from __sqlfu_old_ingress_routes;
drop table __sqlfu_old_ingress_routes;
create index idx_ingress_routes_host on ingress_routes (host);
create index idx_ingress_routes_project_id on ingress_routes (project_id);
-- rebuilding table "project_presets": foreign keys changed
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
insert into project_presets(id, project_id, name, description, events_json, created_at, updated_at) select id, project_id, name, description, events_json, created_at, updated_at from __sqlfu_old_project_presets;
drop table __sqlfu_old_project_presets;
create index idx_project_presets_created_at on project_presets (created_at);
create index idx_project_presets_project_id on project_presets (project_id);
