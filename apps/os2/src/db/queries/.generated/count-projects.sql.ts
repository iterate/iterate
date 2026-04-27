import type { Client } from "sqlfu";

const sql = `
select count(*) as total
from projects;
`.trim();
const query = { sql, args: [], name: "countProjects" };

export const countProjects = Object.assign(
  async function countProjects(client: Client): Promise<countProjects.Result | null> {
    const rows = await client.all<countProjects.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace countProjects {
  export type Result = {
    total: number;
  };
}
