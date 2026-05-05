import type { Client } from "sqlfu";

const sql = `
insert into ingress_routes (id, host, project_id, priority, notes, callable_json, updated_at)
values (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
on conflict(host) do update set
  project_id = excluded.project_id,
  priority = excluded.priority,
  notes = excluded.notes,
  callable_json = excluded.callable_json,
  updated_at = excluded.updated_at
returning id, host, project_id, priority, notes, callable_json, created_at, updated_at;
`.trim();
const query = (params: upsertIngressRoute.Params) => ({
  sql,
  args: [
    params.id,
    params.host,
    params.projectId,
    params.priority,
    params.notes,
    params.callableJson,
  ],
  name: "upsertIngressRoute",
});

export const upsertIngressRoute = Object.assign(
  async function upsertIngressRoute(
    client: Client,
    params: upsertIngressRoute.Params,
  ): Promise<upsertIngressRoute.Result> {
    const rows = await client.all<upsertIngressRoute.Result>(query(params));
    return rows[0];
  },
  { sql, query },
);

export namespace upsertIngressRoute {
  export type Params = {
    id: string;
    host: string;
    projectId: string | null;
    priority: number;
    notes: string | null;
    callableJson: string;
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
