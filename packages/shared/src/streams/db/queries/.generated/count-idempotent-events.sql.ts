import type { SyncClient } from "sqlfu";

const sql = `
select count(*) as committed_idempotent_event_count
from events
where idempotency_key is not null;
`.trim();
const query = { name: "countIdempotentEvents", sql, args: [] };

export const countIdempotentEvents = Object.assign(
  function countIdempotentEvents(client: SyncClient): countIdempotentEvents.Result | null {
    const rows = client.all<countIdempotentEvents.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace countIdempotentEvents {
  export type Result = {
    committed_idempotent_event_count: number;
  };
}
