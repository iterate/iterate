create table projects (
  id text primary key not null,
  slug text not null unique,
  custom_hostname text unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index idx_projects_created_at on projects (created_at);

create table project_permissions (
  project_id text not null references projects (id) on delete cascade,
  principal_type text not null check (principal_type in ('clerk_organization')),
  principal_id text not null,
  role text not null check (role in ('owner')),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  primary key (project_id, principal_type, principal_id)
);

create index idx_project_permissions_project_id on project_permissions (project_id);
create index idx_project_permissions_principal on project_permissions (
  principal_type,
  principal_id
);

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
