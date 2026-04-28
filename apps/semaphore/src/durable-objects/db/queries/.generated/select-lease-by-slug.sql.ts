import type { SyncClient } from "sqlfu";

const sql = `
SELECT lease_id, expires_at
FROM leases
WHERE slug = ?;
`.trim();
const query = (params: selectLeaseBySlug.Params) => ({
  sql,
  args: [params.slug],
  name: "selectLeaseBySlug",
});

export const selectLeaseBySlug = Object.assign(
  function selectLeaseBySlug(
    client: SyncClient,
    params: selectLeaseBySlug.Params,
  ): selectLeaseBySlug.Result | null {
    const rows = client.all<selectLeaseBySlug.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace selectLeaseBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    lease_id: string;
    expires_at: number;
  };
}
