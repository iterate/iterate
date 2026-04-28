import type { Client } from "sqlfu";

const sql = `
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = ?
ORDER BY created_at ASC, slug ASC;
`.trim();
const query = (params: selectResourcesByType.Params) => ({
  sql,
  args: [params.type],
  name: "selectResourcesByType",
});

export const selectResourcesByType = Object.assign(
  async function selectResourcesByType(
    client: Client,
    params: selectResourcesByType.Params,
  ): Promise<selectResourcesByType.Result[]> {
    return client.all<selectResourcesByType.Result>(query(params));
  },
  { sql, query },
);

export namespace selectResourcesByType {
  export type Params = {
    type: string;
  };
  export type Result = {
    type: string;
    slug: string;
    data: string;
    lease_state: string;
    leased_until?: number;
    last_acquired_at?: number;
    last_released_at?: number;
    created_at: string;
    updated_at: string;
  };
}
