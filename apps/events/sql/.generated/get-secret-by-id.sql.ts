import type { Client } from "sqlfu";

const sql = `
select id
from secrets
where id = ? and project_slug = ?
limit 1;
`.trim();
const query = (params: getSecretById.Params) => ({
  sql,
  args: [params.id, params.projectSlug],
  name: "get-secret-by-id",
});

export const getSecretById = Object.assign(
  async function getSecretById(
    client: Client,
    params: getSecretById.Params,
  ): Promise<getSecretById.Result | null> {
    const rows = await client.all<getSecretById.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getSecretById {
  export type Params = {
    id: string;
    projectSlug: string;
  };
  export type Result = {
    id: string;
  };
}
