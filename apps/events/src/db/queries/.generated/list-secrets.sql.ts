import type { Client } from "sqlfu";

const sql = `
select id, name, description, created_at, updated_at
from secrets
where project_slug = ?
order by created_at desc
limit ?
offset ?;
`.trim();
const query = (params: listSecrets.Params) => ({
  sql,
  args: [params.projectSlug, params.limit, params.offset],
  name: "listSecrets",
});

export const listSecrets = Object.assign(
  async function listSecrets(
    client: Client,
    params: listSecrets.Params,
  ): Promise<listSecrets.Result[]> {
    return client.all<listSecrets.Result>(query(params));
  },
  { sql, query },
);

export namespace listSecrets {
  export type Params = {
    projectSlug: string;
    limit: number;
    offset: number;
  };
  export type Result = {
    id: string;
    name: string;
    description?: string;
    created_at: string;
    updated_at: string;
  };
}
