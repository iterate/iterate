import type { Client } from "sqlfu";

const sql = `
select id, host, project_id, priority, notes, callable_json, created_at, updated_at
from ingress_routes
where project_id = ?
order by priority desc, host asc;
`.trim();
const query = (params: listIngressRoutesByProject.Params) => ({
  sql,
  args: [params.projectId],
  name: "listIngressRoutesByProject",
});

export const listIngressRoutesByProject = Object.assign(
  async function listIngressRoutesByProject(
    client: Client,
    params: listIngressRoutesByProject.Params,
  ): Promise<listIngressRoutesByProject.Result[]> {
    return client.all<listIngressRoutesByProject.Result>(query(params));
  },
  { sql, query },
);

export namespace listIngressRoutesByProject {
  export type Params = {
    projectId: string;
  };
  export type Result = {
    id: string;
    host: string;
    project_id: string;
    priority: number;
    notes?: string;
    callable_json: string;
    created_at: string;
    updated_at: string;
  };
}
