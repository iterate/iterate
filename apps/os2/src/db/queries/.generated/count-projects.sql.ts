import type { Client } from "sqlfu";

const sql = `
select count(*) as total
from projects
where clerk_org_id = ?;
`.trim();
const query = (params: countProjects.Params) => ({
  sql,
  args: [params.clerkOrgId],
  name: "countProjects",
});

export const countProjects = Object.assign(
  async function countProjects(
    client: Client,
    params: countProjects.Params,
  ): Promise<countProjects.Result | null> {
    const rows = await client.all<countProjects.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace countProjects {
  export type Params = {
    clerkOrgId: string;
  };
  export type Result = {
    total: number;
  };
}
