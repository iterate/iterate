import type { Client } from "sqlfu";

const sql = `
select count(distinct p.id) as total
from projects p
join project_permissions pp on pp.project_id = p.id
where pp.principal_type = ?
  and pp.principal_id = ?;
`.trim();
const query = (params: countProjects.Params) => ({
  name: "countProjects",
  sql,
  args: [params.principalType, params.principalId],
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
    principalType: "clerk_organization";
    principalId: string;
  };
  export type Result = {
    total: number;
  };
}
