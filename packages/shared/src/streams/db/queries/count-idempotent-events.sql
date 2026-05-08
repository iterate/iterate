select count(*) as committed_idempotent_event_count
from events
where idempotency_key is not null;
