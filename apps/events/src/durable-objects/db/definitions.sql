create table events (
  offset integer primary key,
  type text not null,
  payload text not null check (json_valid(payload)),
  metadata text check (metadata is null or (json_valid(metadata) and json_type(metadata) = 'object')),
  idempotency_key text unique,
  created_at text not null
);

create table reduced_state (
  singleton integer primary key check (singleton = 1),
  json text not null check (json_valid(json))
);
