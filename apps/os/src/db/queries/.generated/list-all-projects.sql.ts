import type { Client } from "sqlfu";

const sql = `
select id, slug, custom_hostname, created_at, updated_at
from projects
order by created_at desc
limit ?
offset ?;
`.trim();
const query = (params: listAllProjects.Params) => ({
  name: "listAllProjects",
  sql,
  args: [params.limit, params.offset],
});

export const listAllProjects = Object.assign(
  async function listAllProjects(
    client: Client,
    params: listAllProjects.Params,
  ): Promise<listAllProjects.Result[]> {
    return client.all<listAllProjects.Result>(query(params));
  },
  { sql, query },
);

export namespace listAllProjects {
  export type Params = {
    limit: number;
    offset: number;
  };
  export type Result = {
    id: string;
    slug: string;
    custom_hostname?: string;
    created_at: string;
    updated_at: string;
  };
}
