create table projects (
  id text primary key not null,
  slug text not null unique,
  custom_hostname text unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  external_egress_proxy_url text
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

create table project_connections (
  id text primary key not null,
  project_id text not null references projects (id) on delete cascade,
  provider text not null,
  external_id text not null,
  webhook_provider_identifier text,
  provider_data text not null check (json_valid(provider_data)),
  scopes text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index idx_project_connections_project_id on project_connections (project_id);
create index idx_project_connections_provider on project_connections (provider);
create unique index idx_project_connections_project_provider on project_connections (
  project_id,
  provider
);
create index idx_project_connections_provider_external_id on project_connections (
  provider,
  external_id
);
create unique index idx_project_connections_webhook_provider_identifier
on project_connections (provider, webhook_provider_identifier)
where webhook_provider_identifier is not null;

create table project_secrets (
  id text primary key not null,
  project_id text not null references projects (id) on delete cascade,
  key text not null,
  material text not null,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (project_id, key)
);

create index idx_project_secrets_project_id on project_secrets (project_id);
create index idx_project_secrets_key on project_secrets (key);

create table oauth_states (
  state text primary key not null,
  provider text not null,
  project_id text not null references projects (id) on delete cascade,
  user_id text not null,
  callback_url text,
  code_verifier text,
  created_at text not null default current_timestamp,
  expires_at text not null
);

create index idx_oauth_states_expires_at on oauth_states (expires_at);
