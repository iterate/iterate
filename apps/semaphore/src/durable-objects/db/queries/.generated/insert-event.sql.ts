import type { SyncClient } from "sqlfu";

const sql = `
INSERT INTO events (occurred_at, event, slug, payload)
VALUES (?, ?, ?, ?);
`.trim();
const query = (params: insertEvent.Params) => ({
  sql,
  args: [params.occurredAt, params.event, params.slug, params.payload],
  name: "insertEvent",
});

export const insertEvent = Object.assign(
  function insertEvent(client: SyncClient, params: insertEvent.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertEvent {
  export type Params = {
    occurredAt: number;
    event: string;
    slug: string | null;
    payload: string;
  };
}
