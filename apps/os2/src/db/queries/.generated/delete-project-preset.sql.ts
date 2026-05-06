import type { Client } from "sqlfu";

const sql = `
delete from project_presets
where id = ?
  and project_id = ?;
`.trim();
const query = (params: deleteProjectPreset.Params) => ({
  name: "deleteProjectPreset",
  sql,
  args: [params.id, params.projectId],
});

export const deleteProjectPreset = Object.assign(
  async function deleteProjectPreset(client: Client, params: deleteProjectPreset.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteProjectPreset {
  export type Params = {
    id: string;
    projectId: string;
  };
}
