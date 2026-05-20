/** @name appendEvent */
insert into events (offset, type, idempotency_key, created_at, raw_json)
values (:offset, :type, :idempotencyKey, :createdAt, :rawJson)
returning offset, type, idempotency_key, created_at, raw_json;

/** @name countEvents */
select count(*) as count
from events;

/** @name findEventByIdempotencyKey */
select offset, type, idempotency_key, created_at, raw_json
from events
where idempotency_key = :idempotencyKey
limit 1;

/** @name getLatestEventOffset */
select max(offset) as offset
from events;

/** @name listSubscribers */
select key, processor_slug, last_sent_offset
from subscribers
order by key;

/** @name readEventsRange */
select offset, type, idempotency_key, created_at, raw_json
from events
where offset > :afterOffset and offset < :beforeOffset
order by offset asc;

/** @name updateSubscriberCursor */
update subscribers
set last_sent_offset = :lastSentOffset
where key = :key;

/** @name upsertSubscriber */
insert into subscribers (key, processor_slug, last_sent_offset)
values (:key, :processorSlug, coalesce(:lastSentOffset, 0))
on conflict (key) do update set
  processor_slug = excluded.processor_slug;
