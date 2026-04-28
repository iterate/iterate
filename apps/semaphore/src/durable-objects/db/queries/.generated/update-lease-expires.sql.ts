import type { SyncClient } from "sqlfu";

const sql = `
UPDATE leases
SET expires_at = ?
WHERE slug = ? AND lease_id = ?;
`.trim();
const query = (data: updateLeaseExpires.Data, params: updateLeaseExpires.Params) => ({
  sql,
  args: [data.expiresAt, params.slug, params.leaseId],
  name: "updateLeaseExpires",
});

export const updateLeaseExpires = Object.assign(
  function updateLeaseExpires(
    client: SyncClient,
    data: updateLeaseExpires.Data,
    params: updateLeaseExpires.Params,
  ) {
    return client.run(query(data, params));
  },
  { sql, query },
);

export namespace updateLeaseExpires {
  export type Data = {
    expiresAt: number;
  };
  export type Params = {
    slug: string;
    leaseId: string;
  };
}
