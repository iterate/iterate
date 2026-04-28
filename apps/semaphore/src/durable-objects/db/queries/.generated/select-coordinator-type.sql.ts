import type { SyncClient } from "sqlfu";

const sql = `
SELECT value
FROM metadata
WHERE key = 'type';
`.trim();
const query = { sql, args: [], name: "selectCoordinatorType" };

export const selectCoordinatorType = Object.assign(
  function selectCoordinatorType(client: SyncClient): selectCoordinatorType.Result | null {
    const rows = client.all<selectCoordinatorType.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace selectCoordinatorType {
  export type Result = {
    value: string;
  };
}
