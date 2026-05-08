select
  duplicate_attempts,
  first_duplicate_at_ms,
  idempotency_key,
  last_duplicate_at_ms,
  source_label
from idempotency_duplicate_attempt_sources
order by duplicate_attempts desc, last_duplicate_at_ms desc
limit :limit;
