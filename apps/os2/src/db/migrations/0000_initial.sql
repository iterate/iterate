create table things (
  id text primary key not null,
  thing text not null,
  created_at text not null,
  updated_at text not null
);

create index idx_things_created_at on things (created_at);
