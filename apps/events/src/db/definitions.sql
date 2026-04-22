create table secrets (
  id text primary key not null,
  name text not null,
  value text not null,
  description text,
  created_at text not null,
  updated_at text not null,
  project_slug text default 'public' not null
);

create unique index secrets_project_slug_name_unique on secrets (project_slug, name);
create index idx_secrets_project_slug_created_at on secrets (project_slug, created_at);
