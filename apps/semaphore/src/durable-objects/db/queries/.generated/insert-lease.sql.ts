import type { SyncClient } from "sqlfu";

const sql = `
INSERT INTO leases (slug, lease_id, expires_at, created_at)
VALUES (?, ?, ?, ?);
`.trim();
const query = (params: insertLease.Params) => ({
  sql,
  args: [params.slug, params.leaseId, params.expiresAt, params.createdAt],
  name: "insertLease",
});

export const insertLease = Object.assign(
  function insertLease(client: SyncClient, params: insertLease.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertLease {
  export type Params = {
    slug: string;
    leaseId: string;
    expiresAt: number;
    createdAt: number;
  };
}
