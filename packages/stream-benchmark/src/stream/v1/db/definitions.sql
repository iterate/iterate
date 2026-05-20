create table events (
  offset integer primary key,
  type text not null,
  idempotency_key text unique,
  created_at text not null,
  raw_json text not null check (json_valid(raw_json))
);

-- Durable subscriber cursors. Rows appear when a `subscription-configured`
-- event is committed; `last_sent_offset` advances as the stream pushes events.
create table subscribers (
  key text primary key,
  processor_slug text not null,
  last_sent_offset integer not null default 0
);
