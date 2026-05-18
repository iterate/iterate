import type { Client } from "sqlfu";

const sql = `
delete from projects
where id = ?;
`.trim();
const query = (params: deleteProject.Params) => ({ name: "deleteProject", sql, args: [params.id] });

export const deleteProject = Object.assign(
  async function deleteProject(client: Client, params: deleteProject.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteProject {
  export type Params = {
    id: string;
  };
}
