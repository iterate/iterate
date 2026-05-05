import type { Client } from "sqlfu";

const sql = `
delete from ingress_routes
where project_id = ?;
`.trim();
const query = (params: deleteIngressRoutesByProject.Params) => ({
  sql,
  args: [params.projectId],
  name: "deleteIngressRoutesByProject",
});

export const deleteIngressRoutesByProject = Object.assign(
  async function deleteIngressRoutesByProject(
    client: Client,
    params: deleteIngressRoutesByProject.Params,
  ) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteIngressRoutesByProject {
  export type Params = {
    projectId: string;
  };
}
