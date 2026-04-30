import type { Client } from "sqlfu";

const sql = `
select id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at
from projects
where slug = ?
  and clerk_org_id = ?
limit 1;
`.trim();
const query = (params: getProjectBySlug.Params) => ({
  sql,
  args: [params.slug, params.clerkOrgId],
  name: "getProjectBySlug",
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
    clerkOrgId: string;
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
