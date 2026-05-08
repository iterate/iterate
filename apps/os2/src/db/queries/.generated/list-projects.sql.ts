import type { Client } from "sqlfu";

const sql = `
select distinct p.id, p.slug, p.custom_hostname, p.metadata, p.created_at, p.updated_at
from projects p
join project_permissions pp on pp.project_id = p.id
where pp.principal_type = ?
  and pp.principal_id = ?
order by p.created_at desc
limit ?
offset ?;
`.trim();
const query = (params: listProjects.Params) => ({
  name: "listProjects",
  sql,
  args: [params.principalType, params.principalId, params.limit, params.offset],
});

export const listProjects = Object.assign(
  async function listProjects(
    client: Client,
    params: listProjects.Params,
  ): Promise<listProjects.Result[]> {
    return client.all<listProjects.Result>(query(params));
  },
  { sql, query },
);

export namespace listProjects {
  export type Params = {
    principalType: "clerk_organization";
    principalId: string;
    limit: number;
    offset: number;
  };
  export type Result = {
    id: string;
    slug: string;
    custom_hostname?: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
