create table projects (
  id text primary key not null,
  slug text not null unique,
  custom_hostname text unique,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index idx_projects_created_at on projects (created_at);

create table itx_contexts (
  id text primary key not null,
  project_id text not null references projects (id) on delete cascade,
  journal_path text not null,
  created_at text not null default current_timestamp
);

create index idx_itx_contexts_project_id on itx_contexts (project_id);
