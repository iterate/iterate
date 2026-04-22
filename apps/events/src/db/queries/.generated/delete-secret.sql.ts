import type { Client } from "sqlfu";

const sql = `
delete from secrets
where id = ? and project_slug = ?;
`.trim();
const query = (params: deleteSecret.Params) => ({
  sql,
  args: [params.id, params.projectSlug],
  name: "delete-secret",
});

export const deleteSecret = Object.assign(
  async function deleteSecret(client: Client, params: deleteSecret.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteSecret {
  export type Params = {
    id: string;
    projectSlug: string;
  };
}
