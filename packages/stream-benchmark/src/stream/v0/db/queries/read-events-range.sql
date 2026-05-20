select offset, type, payload, metadata, source, idempotency_key, created_at
from events
where offset > :afterOffset and offset < :beforeOffset
order by offset asc;
