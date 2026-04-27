import type { Client } from "sqlfu";

const sql = `
select count(*) as total
from things;
`.trim();
const query = { sql, args: [], name: "countThings" };

export const countThings = Object.assign(
  async function countThings(client: Client): Promise<countThings.Result | null> {
    const rows = await client.all<countThings.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace countThings {
  export type Result = {
    total: number;
  };
}
