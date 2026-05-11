select offset, type, payload, metadata, idempotency_key, created_at
from events
where idempotency_key = :idempotencyKey
limit 1;
