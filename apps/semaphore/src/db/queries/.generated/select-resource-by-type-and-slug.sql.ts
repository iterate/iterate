import type { Client } from "sqlfu";

const sql = `
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = ? AND slug = ?;
`.trim();
const query = (params: selectResourceByTypeAndSlug.Params) => ({
  sql,
  args: [params.type, params.slug],
  name: "selectResourceByTypeAndSlug",
});

export const selectResourceByTypeAndSlug = Object.assign(
  async function selectResourceByTypeAndSlug(
    client: Client,
    params: selectResourceByTypeAndSlug.Params,
  ): Promise<selectResourceByTypeAndSlug.Result | null> {
    const rows = await client.all<selectResourceByTypeAndSlug.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace selectResourceByTypeAndSlug {
  export type Params = {
    type: string;
    slug: string;
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
