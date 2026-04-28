import type { SyncClient } from "sqlfu";

const sql = `
SELECT slug, lease_id, expires_at
FROM leases
WHERE expires_at <= ?
ORDER BY expires_at ASC;
`.trim();
const query = (params: selectExpiredLeases.Params) => ({
  sql,
  args: [params.now],
  name: "selectExpiredLeases",
});

export const selectExpiredLeases = Object.assign(
  function selectExpiredLeases(
    client: SyncClient,
    params: selectExpiredLeases.Params,
  ): selectExpiredLeases.Result[] {
    return client.all<selectExpiredLeases.Result>(query(params));
  },
  { sql, query },
);

export namespace selectExpiredLeases {
  export type Params = {
    now: number;
  };
  export type Result = {
    slug: string;
    lease_id: string;
    expires_at: number;
  };
}
