insert into events (offset, type, payload, metadata, idempotency_key, created_at)
values (:offset, :type, json(:payload), :metadata, :idempotencyKey, :createdAt);
