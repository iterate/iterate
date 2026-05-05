import type { Client } from "sqlfu";

const sql = `
select id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at
from projects
where slug = ?
order by created_at asc
limit 2;
`.trim();
const query = (params: listProjectsBySlug.Params) => ({
  sql,
  args: [params.slug],
  name: "listProjectsBySlug",
});

export const listProjectsBySlug = Object.assign(
  async function listProjectsBySlug(
    client: Client,
    params: listProjectsBySlug.Params,
  ): Promise<listProjectsBySlug.Result[]> {
    return client.all<listProjectsBySlug.Result>(query(params));
  },
  { sql, query },
);

export namespace listProjectsBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    id: string;
    slug: string;
    clerk_org_id: string;
    created_by_clerk_user_id: string;
    custom_hostname?: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
