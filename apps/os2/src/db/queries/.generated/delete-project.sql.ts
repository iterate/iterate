import type { Client } from "sqlfu";

const sql = `
delete from projects
where id = ?
  and clerk_org_id = ?;
`.trim();
const query = (params: deleteProject.Params) => ({
  sql,
  args: [params.id, params.clerkOrgId],
  name: "deleteProject",
});

export const deleteProject = Object.assign(
  async function deleteProject(client: Client, params: deleteProject.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteProject {
  export type Params = {
    id: string;
    clerkOrgId: string;
  };
}
