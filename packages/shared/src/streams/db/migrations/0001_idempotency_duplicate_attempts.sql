create table idempotency_duplicate_attempts (
  idempotency_key text primary key,
  event_type text not null,
  stream_path text not null,
  target_offset integer not null,
  duplicate_attempts integer not null,
  first_duplicate_at_ms integer not null,
  last_duplicate_at_ms integer not null
);
