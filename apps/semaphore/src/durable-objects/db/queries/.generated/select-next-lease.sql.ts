import type { SyncClient } from "sqlfu";

const sql = `
SELECT expires_at
FROM leases
ORDER BY expires_at ASC
LIMIT 1;
`.trim();
const query = { sql, args: [], name: "selectNextLease" };

export const selectNextLease = Object.assign(
  function selectNextLease(client: SyncClient): selectNextLease.Result | null {
    const rows = client.all<selectNextLease.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace selectNextLease {
  export type Result = {
    expires_at: number;
  };
}
