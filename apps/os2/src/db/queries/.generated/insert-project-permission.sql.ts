import type { Client } from "sqlfu";

const sql = `
insert into project_permissions (project_id, principal_type, principal_id, role)
values (?, ?, ?, ?)
on conflict(project_id, principal_type, principal_id) do update set
  role = excluded.role,
  updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
returning project_id, principal_type, principal_id, role, created_at, updated_at;
`.trim();
const query = (params: insertProjectPermission.Params) => ({
  name: "insertProjectPermission",
  sql,
  args: [params.projectId, params.principalType, params.principalId, params.role],
});

export const insertProjectPermission = Object.assign(
  async function insertProjectPermission(
    client: Client,
    params: insertProjectPermission.Params,
  ): Promise<insertProjectPermission.Result> {
    const rows = await client.all<insertProjectPermission.Result>(query(params));
    return rows[0];
  },
  { sql, query },
);

export namespace insertProjectPermission {
  export type Params = {
    projectId: string;
    principalType: "clerk_organization";
    principalId: string;
    role: "owner";
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
