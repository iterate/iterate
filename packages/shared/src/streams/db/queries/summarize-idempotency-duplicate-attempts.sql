select
  coalesce(sum(duplicate_attempts), 0) as duplicate_attempt_count,
  count(*) as duplicate_key_count
from idempotency_duplicate_attempts;
