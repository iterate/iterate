import type { Client } from "sqlfu";

const sql = `
delete from project_presets
where id = ?
  and project_id = ?
  and exists (
    select 1
    from projects p
    where p.id = project_presets.project_id
      and p.clerk_org_id = ?
  );
`.trim();
const query = (params: deleteProjectPreset.Params) => ({
  sql,
  args: [params.id, params.projectId, params.clerkOrgId],
  name: "deleteProjectPreset",
});

export const deleteProjectPreset = Object.assign(
  async function deleteProjectPreset(client: Client, params: deleteProjectPreset.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteProjectPreset {
  export type Params = {
    id: string;
    projectId: string;
    clerkOrgId: string;
  };
}
