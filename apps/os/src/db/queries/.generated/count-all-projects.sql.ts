import type { Client } from "sqlfu";

const sql = `
select count(*) as total
from projects;
`.trim();
const query = { name: "countAllProjects", sql, args: [] };

export const countAllProjects = Object.assign(
  async function countAllProjects(client: Client): Promise<countAllProjects.Result | null> {
    const rows = await client.all<countAllProjects.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace countAllProjects {
  export type Result = {
    total: number;
  };
}
