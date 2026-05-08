import type { SyncClient } from "sqlfu";

const sql = `
insert into events (offset, type, payload, metadata, idempotency_key, created_at)
values (?, ?, json(?), ?, ?, ?);
`.trim();
const query = (params: insertEvent.Params) => ({
  name: "insertEvent",
  sql,
  args: [
    params.offset,
    params.type,
    params.payload,
    params.metadata,
    params.idempotencyKey,
    params.createdAt,
  ],
});

export const insertEvent = Object.assign(
  function insertEvent(client: SyncClient, params: insertEvent.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertEvent {
  export type Params = {
    offset: number;
    type: string;
    payload: string | null;
    metadata: string | null;
    idempotencyKey: string | null;
    createdAt: string;
  };
}
