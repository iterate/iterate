create table projects (
  id text primary key not null,
  slug text not null unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null,
  updated_at text not null
);

create index idx_projects_created_at on projects (created_at);
