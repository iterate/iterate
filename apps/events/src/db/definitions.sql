create table secrets (
  id text primary key not null,
  name text not null,
  value text not null,
  description text,
  created_at text not null,
  updated_at text not null,
  project_id text default 'public' not null
);

create unique index secrets_project_id_name_unique on secrets (project_id, name);
create index idx_secrets_project_id_created_at on secrets (project_id, created_at);
