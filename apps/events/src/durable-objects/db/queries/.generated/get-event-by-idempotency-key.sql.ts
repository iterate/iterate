import type { SyncClient } from "sqlfu";

const sql = `
select offset, type, payload, metadata, idempotency_key, created_at
from events
where idempotency_key = ?
limit 1;
`.trim();
const query = (params: getEventByIdempotencyKey.Params) => ({
  sql,
  args: [params.idempotencyKey],
  name: "getEventByIdempotencyKey",
});

export const getEventByIdempotencyKey = Object.assign(
  function getEventByIdempotencyKey(
    client: SyncClient,
    params: getEventByIdempotencyKey.Params,
  ): getEventByIdempotencyKey.Result | null {
    const rows = client.all<getEventByIdempotencyKey.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getEventByIdempotencyKey {
  export type Params = {
    idempotencyKey: string;
  };
  export type Result = {
    offset: number;
    type: string;
    payload: string;
    metadata?: string;
    idempotency_key: string;
    created_at: string;
  };
}
