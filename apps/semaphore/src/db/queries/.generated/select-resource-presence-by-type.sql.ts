import type { Client } from "sqlfu";

const sql = `
SELECT 1 AS present
FROM resources
WHERE type = ?
LIMIT 1;
`.trim();
const query = (params: selectResourcePresenceByType.Params) => ({
  sql,
  args: [params.type],
  name: "selectResourcePresenceByType",
});

export const selectResourcePresenceByType = Object.assign(
  async function selectResourcePresenceByType(
    client: Client,
    params: selectResourcePresenceByType.Params,
  ): Promise<selectResourcePresenceByType.Result | null> {
    const rows = await client.all<selectResourcePresenceByType.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace selectResourcePresenceByType {
  export type Params = {
    type: string;
  };
  export type Result = {
    present: number;
  };
}
