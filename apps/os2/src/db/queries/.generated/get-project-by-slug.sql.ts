import type { Client } from "sqlfu";

const sql = `
select id, slug, custom_hostname, metadata, created_at, updated_at
from projects
where slug = ?
limit 1;
`.trim();
const query = (params: getProjectBySlug.Params) => ({
  name: "getProjectBySlug",
  sql,
  args: [params.slug],
});

export const getProjectBySlug = Object.assign(
  async function getProjectBySlug(
    client: Client,
    params: getProjectBySlug.Params,
  ): Promise<getProjectBySlug.Result | null> {
    const rows = await client.all<getProjectBySlug.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getProjectBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    id: string;
    slug: string;
    custom_hostname?: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
