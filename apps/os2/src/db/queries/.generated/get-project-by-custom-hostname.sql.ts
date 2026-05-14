import type { Client } from "sqlfu";

const sql = `
select id, slug, custom_hostname, external_egress_proxy, metadata, created_at, updated_at
from projects
where custom_hostname = ?
limit 1;
`.trim();
const query = (params: getProjectByCustomHostname.Params) => ({
  name: "getProjectByCustomHostname",
  sql,
  args: [params.customHostname],
});

export const getProjectByCustomHostname = Object.assign(
  async function getProjectByCustomHostname(
    client: Client,
    params: getProjectByCustomHostname.Params,
  ): Promise<getProjectByCustomHostname.Result | null> {
    const rows = await client.all<getProjectByCustomHostname.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getProjectByCustomHostname {
  export type Params = {
    customHostname: string;
  };
  export type Result = {
    id: string;
    slug: string;
    custom_hostname: string;
    external_egress_proxy?: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
