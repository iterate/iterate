import type { Client } from "sqlfu";

const sql = `
select id, slug, metadata, created_at, updated_at
from projects
where id = ?
limit 1;
`.trim();
const query = (params: getProjectById.Params) => ({
  sql,
  args: [params.id],
  name: "getProjectById",
});

export const getProjectById = Object.assign(
  async function getProjectById(
    client: Client,
    params: getProjectById.Params,
  ): Promise<getProjectById.Result | null> {
    const rows = await client.all<getProjectById.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getProjectById {
  export type Params = {
    id: string;
  };
  export type Result = {
    id: string;
    slug: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
