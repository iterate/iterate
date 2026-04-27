-- dropping trigger "projects_updated_at_touch": table "projects" needs rebuild
drop trigger if exists projects_updated_at_touch;
-- rebuilding table "projects": column "created_at" default changed
alter table projects rename to __sqlfu_old_projects;
create table projects (
  id text primary key not null,
  slug text not null unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
insert into projects(id, slug, metadata, created_at, updated_at) select id, slug, metadata, created_at, updated_at from __sqlfu_old_projects;
drop table __sqlfu_old_projects;
create index idx_projects_created_at on projects (created_at);
-- recreating trigger "projects_updated_at_touch": table "projects" needs rebuild
create trigger projects_updated_at_touch after update on projects when new.updated_at = old.updated_at begin
update projects
set updated_at = current_timestamp
where id = new.id;
end;
