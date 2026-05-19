import type { Client } from "sqlfu";

const sql = `
select id, host, project_id, priority, notes, callable_json, created_at, updated_at
from ingress_routes
where host = ?
order by priority desc, created_at asc
limit 1;
`.trim();
const query = (params: getIngressRouteByHost.Params) => ({
  name: "getIngressRouteByHost",
  sql,
  args: [params.host],
});

export const getIngressRouteByHost = Object.assign(
  async function getIngressRouteByHost(
    client: Client,
    params: getIngressRouteByHost.Params,
  ): Promise<getIngressRouteByHost.Result | null> {
    const rows = await client.all<getIngressRouteByHost.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getIngressRouteByHost {
  export type Params = {
    host: string;
  };
  export type Result = {
    id: string;
    host: string;
    project_id?: string;
    priority: number;
    notes?: string;
    callable_json: string;
    created_at: string;
    updated_at: string;
  };
}
