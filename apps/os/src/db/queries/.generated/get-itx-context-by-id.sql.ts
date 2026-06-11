import type { Client } from "sqlfu";

const sql = `
select id, project_id, journal_path
from itx_contexts
where id = ?
limit 1;
`.trim();
const query = (params: getItxContextById.Params) => ({
  name: "getItxContextById",
  sql,
  args: [params.id],
});

export const getItxContextById = Object.assign(
  async function getItxContextById(
    client: Client,
    params: getItxContextById.Params,
  ): Promise<getItxContextById.Result | null> {
    const rows = await client.all<getItxContextById.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getItxContextById {
  export type Params = {
    id: string;
  };
  export type Result = {
    id: string;
    project_id: string;
    journal_path: string;
  };
}
