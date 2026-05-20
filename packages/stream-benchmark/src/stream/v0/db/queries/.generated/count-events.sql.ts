import type { SyncClient } from "sqlfu";

const sql = `
select count(*) as c
from events;
`.trim();
const query = { name: "countEvents", sql, args: [] };

export const countEvents = Object.assign(
  function countEvents(client: SyncClient): countEvents.Result | null {
    const rows = client.all<countEvents.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace countEvents {
  export type Result = {
    c: number;
  };
}
