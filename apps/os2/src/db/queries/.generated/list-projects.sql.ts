import type { Client } from "sqlfu";

const sql = `
select id, slug, metadata, created_at, updated_at
from projects
order by created_at desc
limit ?
offset ?;
`.trim();
const query = (params: listProjects.Params) => ({
  sql,
  args: [params.limit, params.offset],
  name: "listProjects",
});

export const listProjects = Object.assign(
  async function listProjects(
    client: Client,
    params: listProjects.Params,
  ): Promise<listProjects.Result[]> {
    return client.all<listProjects.Result>(query(params));
  },
  { sql, query },
);

export namespace listProjects {
  export type Params = {
    limit: number;
    offset: number;
  };
  export type Result = {
    id: string;
    slug: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
