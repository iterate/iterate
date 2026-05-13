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
