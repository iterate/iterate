import type { Client } from "sqlfu";

const sql = `
select id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at
from projects
where id = ?
  and clerk_org_id = ?
limit 1;
`.trim();
const query = (params: getProjectById.Params) => ({
  sql,
  args: [params.id, params.clerkOrgId],
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
    clerkOrgId: string;
  };
  export type Result = {
    id: string;
    slug: string;
    clerk_org_id: string;
    created_by_clerk_user_id?: string;
    custom_hostname?: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
