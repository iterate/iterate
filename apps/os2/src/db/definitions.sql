create table projects (
  id text primary key not null,
  slug text not null unique,
  custom_hostname text unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index idx_projects_created_at on projects (created_at);
