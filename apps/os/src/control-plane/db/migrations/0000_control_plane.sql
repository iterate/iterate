create table users (
  id text primary key,
  email text not null unique
);

create table identities (
  provider text not null,
  subject text not null,
  user_id text not null references users (id),
  primary key (provider, subject),
  unique (provider, user_id)
);

create table organizations (
  id text primary key,
  name text not null
);

create table memberships (
  org_id text not null references organizations (id) on delete cascade,
  user_id text not null references users (id),
  role text not null check (role in ('owner', 'member')),
  primary key (org_id, user_id)
);
create index memberships_user on memberships (user_id);

create table projects (
  id text primary key,
  slug text not null unique,
  org_id text not null references organizations (id)
);
create index projects_org on projects (org_id);

create table invitations (
  id text primary key,
  token_hash text not null unique,
  org_id text not null references organizations (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  email_hint text,
  created_by text not null,
  created_at integer not null,
  expires_at integer not null,
  revoked_at integer,
  accepted_by text,
  accepted_at integer,
  acceptance_id text
);
create index invitations_org on invitations (org_id);

create table project_hostnames (
  hostname text primary key,
  project_id text not null
);
create index project_hostnames_project on project_hostnames (project_id);

create table project_primary_hostnames (
  project_id text primary key,
  hostname text not null
);

create table oauth_grants (
  key text primary key,
  value text not null,
  expires_at integer
);
create index oauth_grants_expiry on oauth_grants (expires_at);
