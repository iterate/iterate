insert into events (type, payload, metadata, source, idempotency_key)
values (:type, :payload, :metadata, :source, :idempotencyKey)
returning offset, type, payload, metadata, source, idempotency_key, created_at;
