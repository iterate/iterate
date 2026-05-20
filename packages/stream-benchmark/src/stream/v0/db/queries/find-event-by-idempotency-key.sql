select offset, type, payload, metadata, source, idempotency_key, created_at
from events
where idempotency_key = :idempotencyKey
limit 1;
