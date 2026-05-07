import type { Client } from "sqlfu";

const sql = `
select id
from secrets
where id = ? and namespace = ?
limit 1;
`.trim();
const query = (params: getSecretById.Params) => ({
  sql,
  args: [params.id, params.namespace],
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
    namespace: string;
  };
  export type Result = {
    id: string;
  };
}
