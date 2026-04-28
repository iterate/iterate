import type { SyncClient } from "sqlfu";

const sql = `
DELETE FROM leases
WHERE slug = ?;
`.trim();
const query = (params: deleteLeaseBySlug.Params) => ({
  sql,
  args: [params.slug],
  name: "deleteLeaseBySlug",
});

export const deleteLeaseBySlug = Object.assign(
  function deleteLeaseBySlug(client: SyncClient, params: deleteLeaseBySlug.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteLeaseBySlug {
  export type Params = {
    slug: string;
  };
}
