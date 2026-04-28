import type { SyncClient } from "sqlfu";

const sql = `
SELECT COUNT(*) AS count
FROM leases
WHERE slug = ?;
`.trim();
const query = (params: selectLeaseCountBySlug.Params) => ({
  sql,
  args: [params.slug],
  name: "selectLeaseCountBySlug",
});

export const selectLeaseCountBySlug = Object.assign(
  function selectLeaseCountBySlug(
    client: SyncClient,
    params: selectLeaseCountBySlug.Params,
  ): selectLeaseCountBySlug.Result | null {
    const rows = client.all<selectLeaseCountBySlug.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace selectLeaseCountBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    count: number;
  };
}
