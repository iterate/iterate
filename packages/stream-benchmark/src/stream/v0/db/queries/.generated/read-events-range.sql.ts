import type { SyncClient } from "sqlfu";

const sql = `
select offset, type, payload, metadata, source, idempotency_key, created_at
from events
where offset > ? and offset < ?
order by offset asc;
`.trim();
const query = (params: readEventsRange.Params) => ({
  name: "readEventsRange",
  sql,
  args: [params.afterOffset, params.beforeOffset],
});

export const readEventsRange = Object.assign(
  function readEventsRange(
    client: SyncClient,
    params: readEventsRange.Params,
  ): readEventsRange.Result[] {
    return client.all<readEventsRange.Result>(query(params));
  },
  { sql, query },
);

export namespace readEventsRange {
  export type Params = {
    afterOffset: number;
    beforeOffset: number;
  };
  export type Result = {
    offset: number;
    type: string;
    payload?: string;
    metadata?: string;
    source?: string;
    idempotency_key?: string;
    created_at: string;
  };
}
