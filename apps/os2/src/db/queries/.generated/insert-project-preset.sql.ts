import type { Client } from "sqlfu";

const sql = `
insert into project_presets (id, project_id, name, description, events_json)
values (?, ?, ?, ?, ?)
returning id, project_id, name, description, events_json, created_at, updated_at;
`.trim();
const query = (params: insertProjectPreset.Params) => ({
  sql,
  args: [params.id, params.projectId, params.name, params.description, params.eventsJson],
  name: "insertProjectPreset",
});

export const insertProjectPreset = Object.assign(
  async function insertProjectPreset(
    client: Client,
    params: insertProjectPreset.Params,
  ): Promise<insertProjectPreset.Result> {
    const rows = await client.all<insertProjectPreset.Result>(query(params));
    return rows[0];
  },
  { sql, query },
);

export namespace insertProjectPreset {
  export type Params = {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    eventsJson: string;
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
