import type { SyncClient } from "sqlfu";

const sql = `
SELECT lease_id
FROM leases
WHERE slug = ?;
`.trim();
const query = (params: selectLeaseIdBySlug.Params) => ({
  sql,
  args: [params.slug],
  name: "selectLeaseIdBySlug",
});

export const selectLeaseIdBySlug = Object.assign(
  function selectLeaseIdBySlug(
    client: SyncClient,
    params: selectLeaseIdBySlug.Params,
  ): selectLeaseIdBySlug.Result | null {
    const rows = client.all<selectLeaseIdBySlug.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace selectLeaseIdBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    lease_id: string;
  };
}
