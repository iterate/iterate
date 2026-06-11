import type { Client } from "sqlfu";

const sql = `
insert into itx_contexts (id, project_id, journal_path)
values (?, ?, ?)
on conflict (id) do nothing;
`.trim();
const query = (params: insertItxContext.Params) => ({
  name: "insertItxContext",
  sql,
  args: [params.id, params.projectId, params.journalPath],
});

export const insertItxContext = Object.assign(
  async function insertItxContext(client: Client, params: insertItxContext.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertItxContext {
  export type Params = {
    id: string;
    projectId: string;
    journalPath: string;
  };
}
