import type { Client } from "sqlfu";

const sql = `select count(*) as total from secrets where project_id = ?;`;
const query = (params: countSecrets.Params) => ({
  sql,
  args: [params.projectId],
  name: "countSecrets",
});

export const countSecrets = Object.assign(
  async function countSecrets(
    client: Client,
    params: countSecrets.Params,
  ): Promise<countSecrets.Result | null> {
    const rows = await client.all<countSecrets.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace countSecrets {
  export type Params = {
    projectId: string;
  };
  export type Result = {
    total: number;
  };
}
