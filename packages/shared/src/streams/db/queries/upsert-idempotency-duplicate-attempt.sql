insert into idempotency_duplicate_attempts (
  idempotency_key,
  event_type,
  stream_path,
  target_offset,
  duplicate_attempts,
  first_duplicate_at_ms,
  last_duplicate_at_ms
)
values (
  :idempotencyKey,
  :eventType,
  :streamPath,
  :targetOffset,
  1,
  :firstDuplicateAtMs,
  :lastDuplicateAtMs
)
on conflict (idempotency_key) do update set
  event_type = excluded.event_type,
  stream_path = excluded.stream_path,
  target_offset = excluded.target_offset,
  duplicate_attempts = idempotency_duplicate_attempts.duplicate_attempts + 1,
  last_duplicate_at_ms = excluded.last_duplicate_at_ms;
