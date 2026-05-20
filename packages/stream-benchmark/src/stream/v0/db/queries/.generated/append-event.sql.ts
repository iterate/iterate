import type { SyncClient } from "sqlfu";

const sql = `
insert into events (type, payload, metadata, source, idempotency_key)
values (?, ?, ?, ?, ?)
returning offset, type, payload, metadata, source, idempotency_key, created_at;
`.trim();
const query = (params: appendEvent.Params) => ({
  name: "appendEvent",
  sql,
  args: [params.type, params.payload, params.metadata, params.source, params.idempotencyKey],
});

export const appendEvent = Object.assign(
  function appendEvent(client: SyncClient, params: appendEvent.Params): appendEvent.Result {
    const rows = client.all<appendEvent.Result>(query(params));
    return rows[0];
  },
  { sql, query },
);

export namespace appendEvent {
  export type Params = {
    type: string;
    payload: string | null;
    metadata: string | null;
    source: string | null;
    idempotencyKey: string | null;
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
