create table idempotency_duplicate_attempt_sources (
  idempotency_key text not null,
  source_label text not null,
  duplicate_attempts integer not null,
  first_duplicate_at_ms integer not null,
  last_duplicate_at_ms integer not null,
  primary key (idempotency_key, source_label)
);
