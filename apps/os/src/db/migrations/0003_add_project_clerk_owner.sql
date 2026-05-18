alter table projects rename to __sqlfu_old_projects;
create table projects (
  id text primary key not null,
  slug text not null,
  clerk_org_id text,
  created_by_clerk_user_id text,
  custom_hostname text unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (clerk_org_id, slug)
);
insert into projects(id, slug, custom_hostname, metadata, created_at, updated_at)
select id, slug, custom_hostname, metadata, created_at, updated_at from __sqlfu_old_projects;
drop table __sqlfu_old_projects;
create index idx_projects_created_at on projects (created_at);
create index idx_projects_clerk_org_id on projects (clerk_org_id);
