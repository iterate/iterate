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

create index idx_ingress_routes_project_id on ingress_routes (project_id);
create index idx_ingress_routes_host on ingress_routes (host);
