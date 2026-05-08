insert into idempotency_duplicate_attempt_sources (
  idempotency_key,
  source_label,
  duplicate_attempts,
  first_duplicate_at_ms,
  last_duplicate_at_ms
)
values (
  :idempotencyKey,
  :sourceLabel,
  1,
  :firstDuplicateAtMs,
  :lastDuplicateAtMs
)
on conflict (idempotency_key, source_label) do update set
  duplicate_attempts = idempotency_duplicate_attempt_sources.duplicate_attempts + 1,
  last_duplicate_at_ms = excluded.last_duplicate_at_ms;
