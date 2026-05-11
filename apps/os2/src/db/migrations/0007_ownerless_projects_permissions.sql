-- rebuilding table "projects": unique constraints changed
alter table projects rename to __sqlfu_old_projects;
create table projects (
  id text primary key not null,
  slug text not null unique,
  custom_hostname text unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
insert into projects(id, slug, custom_hostname, metadata, created_at, updated_at) select id, slug, custom_hostname, metadata, created_at, updated_at from __sqlfu_old_projects;
drop table __sqlfu_old_projects;
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
create index idx_project_permissions_principal on project_permissions (
principal_type,
principal_id
);
create index idx_project_permissions_project_id on project_permissions (project_id);
