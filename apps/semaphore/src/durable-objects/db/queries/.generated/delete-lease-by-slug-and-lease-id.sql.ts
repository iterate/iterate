import type { SyncClient } from "sqlfu";

const sql = `
DELETE FROM leases
WHERE slug = ? AND lease_id = ?;
`.trim();
const query = (params: deleteLeaseBySlugAndLeaseId.Params) => ({
  sql,
  args: [params.slug, params.leaseId],
  name: "deleteLeaseBySlugAndLeaseId",
});

export const deleteLeaseBySlugAndLeaseId = Object.assign(
  function deleteLeaseBySlugAndLeaseId(
    client: SyncClient,
    params: deleteLeaseBySlugAndLeaseId.Params,
  ) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteLeaseBySlugAndLeaseId {
  export type Params = {
    slug: string;
    leaseId: string;
  };
}
