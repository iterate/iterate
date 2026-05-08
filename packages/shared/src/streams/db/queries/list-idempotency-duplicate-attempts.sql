select
  duplicate_attempts,
  event_type,
  first_duplicate_at_ms,
  idempotency_key,
  last_duplicate_at_ms,
  stream_path,
  target_offset
from idempotency_duplicate_attempts
order by duplicate_attempts desc, last_duplicate_at_ms desc
limit :limit;
