import type { SyncClient } from "sqlfu";

const sql = `
select max(offset) as offset
from events;
`.trim();
const query = { name: "getLatestEventOffset", sql, args: [] };

export const getLatestEventOffset = Object.assign(
  function getLatestEventOffset(client: SyncClient): getLatestEventOffset.Result | null {
    const rows = client.all<getLatestEventOffset.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getLatestEventOffset {
  export type Result = {
    offset: number;
  };
}
