import type { Client } from "sqlfu";

const sql = `
select pp.id, pp.project_id, pp.name, pp.description, pp.events_json, pp.created_at, pp.updated_at
from project_presets pp
join projects p on p.id = pp.project_id
where pp.project_id = ?
  and p.clerk_org_id = ?
order by pp.created_at desc;
`.trim();
const query = (params: listProjectPresets.Params) => ({
  sql,
  args: [params.projectId, params.clerkOrgId],
  name: "listProjectPresets",
});

export const listProjectPresets = Object.assign(
  async function listProjectPresets(
    client: Client,
    params: listProjectPresets.Params,
  ): Promise<listProjectPresets.Result[]> {
    return client.all<listProjectPresets.Result>(query(params));
  },
  { sql, query },
);

export namespace listProjectPresets {
  export type Params = {
    projectId: string;
    clerkOrgId: string;
  };
  export type Result = {
    id: string;
    project_id: string;
    name: string;
    description?: string;
    events_json: string;
    created_at: string;
    updated_at: string;
  };
}
