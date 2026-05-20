import type { SyncClient } from "sqlfu";

const appendEventSql = `
insert into events (offset, type, idempotency_key, created_at, raw_json)
values (?, ?, ?, ?, ?)
returning offset, type, idempotency_key, created_at, raw_json;
`.trim();
const appendEventQuery = (params: appendEvent.Params) => ({
  name: "appendEvent",
  sql: appendEventSql,
  args: [params.offset, params.type, params.idempotencyKey, params.createdAt, params.rawJson],
});

export const appendEvent = Object.assign(
  function appendEvent(client: SyncClient, params: appendEvent.Params): appendEvent.Result {
    const rows = client.all<appendEvent.Result>(appendEventQuery(params));
    return rows[0];
  },
  { sql: appendEventSql, query: appendEventQuery },
);

export namespace appendEvent {
  export type Params = {
    offset: number;
    type: string;
    idempotencyKey: string | null;
    createdAt: string;
    rawJson: string;
  };
  export type Result = {
    offset: number;
    type: string;
    idempotency_key?: string;
    created_at: string;
    raw_json: string;
  };
}

const countEventsSql = `
select count(*) as count
from events;
`.trim();
const countEventsQuery = { name: "countEvents", sql: countEventsSql, args: [] };

export const countEvents = Object.assign(
  function countEvents(client: SyncClient): countEvents.Result | null {
    const rows = client.all<countEvents.Result>(countEventsQuery);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: countEventsSql, query: countEventsQuery },
);

export namespace countEvents {
  export type Result = {
    count: number;
  };
}

const findEventByIdempotencyKeySql = `
select offset, type, idempotency_key, created_at, raw_json
from events
where idempotency_key = ?
limit 1;
`.trim();
const findEventByIdempotencyKeyQuery = (params: findEventByIdempotencyKey.Params) => ({
  name: "findEventByIdempotencyKey",
  sql: findEventByIdempotencyKeySql,
  args: [params.idempotencyKey],
});

export const findEventByIdempotencyKey = Object.assign(
  function findEventByIdempotencyKey(
    client: SyncClient,
    params: findEventByIdempotencyKey.Params,
  ): findEventByIdempotencyKey.Result | null {
    const rows = client.all<findEventByIdempotencyKey.Result>(
      findEventByIdempotencyKeyQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: findEventByIdempotencyKeySql, query: findEventByIdempotencyKeyQuery },
);

export namespace findEventByIdempotencyKey {
  export type Params = {
    idempotencyKey: string;
  };
  export type Result = {
    offset: number;
    type: string;
    idempotency_key: string;
    created_at: string;
    raw_json: string;
  };
}

const getLatestEventOffsetSql = `
select max(offset) as offset
from events;
`.trim();
const getLatestEventOffsetQuery = {
  name: "getLatestEventOffset",
  sql: getLatestEventOffsetSql,
  args: [],
};

export const getLatestEventOffset = Object.assign(
  function getLatestEventOffset(client: SyncClient): getLatestEventOffset.Result | null {
    const rows = client.all<getLatestEventOffset.Result>(getLatestEventOffsetQuery);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getLatestEventOffsetSql, query: getLatestEventOffsetQuery },
);

export namespace getLatestEventOffset {
  export type Result = {
    offset: number;
  };
}

const listSubscribersSql = `
select key, processor_slug, last_sent_offset
from subscribers
order by key;
`.trim();
const listSubscribersQuery = { name: "listSubscribers", sql: listSubscribersSql, args: [] };

export const listSubscribers = Object.assign(
  function listSubscribers(client: SyncClient): listSubscribers.Result[] {
    return client.all<listSubscribers.Result>(listSubscribersQuery);
  },
  { sql: listSubscribersSql, query: listSubscribersQuery },
);

export namespace listSubscribers {
  export type Result = {
    key: string;
    processor_slug: string;
    last_sent_offset: number;
  };
}

const readEventsRangeSql = `
select offset, type, idempotency_key, created_at, raw_json
from events
where offset > ? and offset < ?
order by offset asc;
`.trim();
const readEventsRangeQuery = (params: readEventsRange.Params) => ({
  name: "readEventsRange",
  sql: readEventsRangeSql,
  args: [params.afterOffset, params.beforeOffset],
});

export const readEventsRange = Object.assign(
  function readEventsRange(
    client: SyncClient,
    params: readEventsRange.Params,
  ): readEventsRange.Result[] {
    return client.all<readEventsRange.Result>(readEventsRangeQuery(params));
  },
  { sql: readEventsRangeSql, query: readEventsRangeQuery },
);

export namespace readEventsRange {
  export type Params = {
    afterOffset: number;
    beforeOffset: number;
  };
  export type Result = {
    offset: number;
    type: string;
    idempotency_key?: string;
    created_at: string;
    raw_json: string;
  };
}

const updateSubscriberCursorSql = `
update subscribers
set last_sent_offset = ?
where key = ?;
`.trim();
const updateSubscriberCursorQuery = (
  data: updateSubscriberCursor.Data,
  params: updateSubscriberCursor.Params,
) => ({
  name: "updateSubscriberCursor",
  sql: updateSubscriberCursorSql,
  args: [data.lastSentOffset, params.key],
});

export const updateSubscriberCursor = Object.assign(
  function updateSubscriberCursor(
    client: SyncClient,
    data: updateSubscriberCursor.Data,
    params: updateSubscriberCursor.Params,
  ) {
    return client.run(updateSubscriberCursorQuery(data, params));
  },
  { sql: updateSubscriberCursorSql, query: updateSubscriberCursorQuery },
);

export namespace updateSubscriberCursor {
  export type Data = {
    lastSentOffset: number;
  };
  export type Params = {
    key: string;
  };
}

const upsertSubscriberSql = `
insert into subscribers (key, processor_slug, last_sent_offset)
values (?, ?, coalesce(?, 0))
on conflict (key) do update set
  processor_slug = excluded.processor_slug;
`.trim();
const upsertSubscriberQuery = (params: upsertSubscriber.Params) => ({
  name: "upsertSubscriber",
  sql: upsertSubscriberSql,
  args: [params.key, params.processorSlug, params.lastSentOffset],
});

export const upsertSubscriber = Object.assign(
  function upsertSubscriber(client: SyncClient, params: upsertSubscriber.Params) {
    return client.run(upsertSubscriberQuery(params));
  },
  { sql: upsertSubscriberSql, query: upsertSubscriberQuery },
);

export namespace upsertSubscriber {
  export type Params = {
    key: string;
    processorSlug: string;
    lastSentOffset: number;
  };
}
