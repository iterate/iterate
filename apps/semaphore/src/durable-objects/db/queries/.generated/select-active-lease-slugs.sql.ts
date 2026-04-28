import type { SyncClient } from "sqlfu";

const sql = `
SELECT slug
FROM leases;
`.trim();
const query = { sql, args: [], name: "selectActiveLeaseSlugs" };

export const selectActiveLeaseSlugs = Object.assign(
  function selectActiveLeaseSlugs(client: SyncClient): selectActiveLeaseSlugs.Result[] {
    return client.all<selectActiveLeaseSlugs.Result>(query);
  },
  { sql, query },
);

export namespace selectActiveLeaseSlugs {
  export type Result = {
    slug: string;
  };
}
