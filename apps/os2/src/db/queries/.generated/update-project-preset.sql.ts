import type { Client } from "sqlfu";

const sql = `
update project_presets
set name = ?,
    description = ?,
    events_json = ?,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
where id = ?
  and project_id = ?
  and exists (
    select 1
    from projects p
    where p.id = project_presets.project_id
      and p.clerk_org_id = ?
  );
`.trim();
const query = (data: updateProjectPreset.Data, params: updateProjectPreset.Params) => ({
  sql,
  args: [
    data.name,
    data.description,
    data.eventsJson,
    params.id,
    params.projectId,
    params.clerkOrgId,
  ],
  name: "updateProjectPreset",
});

export const updateProjectPreset = Object.assign(
  async function updateProjectPreset(
    client: Client,
    data: updateProjectPreset.Data,
    params: updateProjectPreset.Params,
  ) {
    return client.run(query(data, params));
  },
  { sql, query },
);

export namespace updateProjectPreset {
  export type Data = {
    name: string;
    description: string | null;
    eventsJson: string;
  };
  export type Params = {
    id: string;
    projectId: string;
    clerkOrgId: string;
  };
}
