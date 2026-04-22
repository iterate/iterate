import type { Client } from "sqlfu";

const sql = `select count(*) as total from secrets where project_slug = ?;`;
const query = (params: countSecrets.Params) => ({
  sql,
  args: [params.projectSlug],
  name: "count-secrets",
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
    projectSlug: string;
  };
  export type Result = {
    total: number;
  };
}
