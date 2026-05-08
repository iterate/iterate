create table secrets (
  id text primary key not null,
  name text not null,
  value text not null,
  description text,
  created_at text not null,
  updated_at text not null,
  namespace text default 'public' not null
);

create unique index secrets_namespace_name_unique on secrets (namespace, name);
create index idx_secrets_namespace_created_at on secrets (namespace, created_at);
