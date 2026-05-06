import type { Client } from "sqlfu";

const sql = `
select pp.id, pp.project_id, pp.name, pp.description, pp.events_json, pp.created_at, pp.updated_at
from project_presets pp
where pp.id = ?
  and pp.project_id = ?
limit 1;
`.trim();
const query = (params: getProjectPresetById.Params) => ({
  name: "getProjectPresetById",
  sql,
  args: [params.id, params.projectId],
});

export const getProjectPresetById = Object.assign(
  async function getProjectPresetById(
    client: Client,
    params: getProjectPresetById.Params,
  ): Promise<getProjectPresetById.Result | null> {
    const rows = await client.all<getProjectPresetById.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getProjectPresetById {
  export type Params = {
    id: string;
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
