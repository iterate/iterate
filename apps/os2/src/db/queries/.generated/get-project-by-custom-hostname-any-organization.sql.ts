import type { Client } from "sqlfu";

const sql = `
select id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at
from projects
where custom_hostname = ?
limit 1;
`.trim();
const query = (params: getProjectByCustomHostnameAnyOrganization.Params) => ({
  sql,
  args: [params.customHostname],
  name: "getProjectByCustomHostnameAnyOrganization",
});

export const getProjectByCustomHostnameAnyOrganization = Object.assign(
  async function getProjectByCustomHostnameAnyOrganization(
    client: Client,
    params: getProjectByCustomHostnameAnyOrganization.Params,
  ): Promise<getProjectByCustomHostnameAnyOrganization.Result | null> {
    const rows = await client.all<getProjectByCustomHostnameAnyOrganization.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getProjectByCustomHostnameAnyOrganization {
  export type Params = {
    customHostname: string;
  };
  export type Result = {
    id: string;
    slug: string;
    clerk_org_id: string;
    created_by_clerk_user_id: string;
    custom_hostname: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
