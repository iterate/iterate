-- Use IF NOT EXISTS in this introductory migration only: existing Durable
-- Object instances already created these tables via the old ensureSchema()
-- helper, before sqlfu took over migrations. The IF NOT EXISTS lets a fresh
-- DO and a previously-deployed DO both end up with a consistent
-- sqlfu_migrations row after the first call to migrate(client). Future
-- migrations should use plain DDL.
create table if not exists events (
  offset integer primary key,
  type text not null,
  payload text not null check (json_valid(payload)),
  metadata text check (metadata is null or (json_valid(metadata) and json_type(metadata) = 'object')),
  idempotency_key text unique,
  created_at text not null
);

create table if not exists reduced_state (
  singleton integer primary key check (singleton = 1),
  json text not null check (json_valid(json))
);
