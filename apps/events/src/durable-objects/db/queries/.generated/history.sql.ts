import type { SyncClient } from "sqlfu";

const sql = `
select offset, type, payload, metadata, idempotency_key, created_at
from events
where offset > ? and offset < ?
order by offset asc;
`.trim();
const query = (params: history.Params) => ({
  sql,
  args: [params.afterOffset, params.beforeOffset],
  name: "history",
});

export const history = Object.assign(
  function history(client: SyncClient, params: history.Params): history.Result[] {
    return client.all<history.Result>(query(params));
  },
  { sql, query },
);

export namespace history {
  export type Params = {
    afterOffset: number;
    beforeOffset: number;
  };
  export type Result = {
    offset: number;
    type: string;
    payload: string;
    metadata?: string;
    idempotency_key?: string;
    created_at: string;
  };
}
