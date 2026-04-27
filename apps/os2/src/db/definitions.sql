create table projects (
  id text primary key not null,
  slug text not null unique,
  metadata text not null check (json_valid(metadata)),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index idx_projects_created_at on projects (created_at);

create trigger projects_updated_at_touch after update on projects when new.updated_at = old.updated_at begin
  update projects
  set updated_at = current_timestamp
  where id = new.id;
end;
