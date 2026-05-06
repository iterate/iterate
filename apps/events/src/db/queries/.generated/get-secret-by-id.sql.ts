import type { Client } from "sqlfu";

const sql = `
select id
from secrets
where id = ? and project_id = ?
limit 1;
`.trim();
const query = (params: getSecretById.Params) => ({
  sql,
  args: [params.id, params.projectId],
  name: "getSecretById",
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
    projectId: string;
  };
  export type Result = {
    id: string;
  };
}
