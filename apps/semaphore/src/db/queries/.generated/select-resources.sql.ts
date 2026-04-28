import type { Client } from "sqlfu";

const sql = `
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
ORDER BY type ASC, created_at ASC, slug ASC;
`.trim();
const query = { sql, args: [], name: "selectResources" };

export const selectResources = Object.assign(
  async function selectResources(client: Client): Promise<selectResources.Result[]> {
    return client.all<selectResources.Result>(query);
  },
  { sql, query },
);

export namespace selectResources {
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
