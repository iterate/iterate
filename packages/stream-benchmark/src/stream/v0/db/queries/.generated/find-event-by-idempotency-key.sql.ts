import type { SyncClient } from "sqlfu";

const sql = `
select offset, type, payload, metadata, source, idempotency_key, created_at
from events
where idempotency_key = ?
limit 1;
`.trim();
const query = (params: findEventByIdempotencyKey.Params) => ({
  name: "findEventByIdempotencyKey",
  sql,
  args: [params.idempotencyKey],
});

export const findEventByIdempotencyKey = Object.assign(
  function findEventByIdempotencyKey(
    client: SyncClient,
    params: findEventByIdempotencyKey.Params,
  ): findEventByIdempotencyKey.Result | null {
    const rows = client.all<findEventByIdempotencyKey.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace findEventByIdempotencyKey {
  export type Params = {
    idempotencyKey: string;
  };
  export type Result = {
    offset: number;
    type: string;
    payload?: string;
    metadata?: string;
    source?: string;
    idempotency_key: string;
    created_at: string;
  };
}
