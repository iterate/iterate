import type { Client } from "sqlfu";

const sql = `
select project_id, principal_type, principal_id, role, created_at, updated_at
from project_permissions
where project_id = ?
  and principal_type = ?
  and principal_id = ?
limit 1;
`.trim();
const query = (params: getProjectPermission.Params) => ({
  name: "getProjectPermission",
  sql,
  args: [params.projectId, params.principalType, params.principalId],
});

export const getProjectPermission = Object.assign(
  async function getProjectPermission(
    client: Client,
    params: getProjectPermission.Params,
  ): Promise<getProjectPermission.Result | null> {
    const rows = await client.all<getProjectPermission.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getProjectPermission {
  export type Params = {
    projectId: string;
    principalType: "clerk_organization";
    principalId: string;
  };
  export type Result = {
    project_id: string;
    principal_type: "clerk_organization";
    principal_id: string;
    role: "owner";
    created_at: string;
    updated_at: string;
  };
}
