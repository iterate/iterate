import type { Client } from "sqlfu";

const sql = `
select pp.id, pp.project_id, pp.name, pp.description, pp.events_json, pp.created_at, pp.updated_at
from project_presets pp
where pp.project_id = ?
order by pp.created_at desc;
`.trim();
const query = (params: listProjectPresets.Params) => ({
  name: "listProjectPresets",
  sql,
  args: [params.projectId],
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
