import type { Client } from "sqlfu";

const sql = `
select id, thing, created_at, updated_at
from things
where id = ?
limit 1;
`.trim();
const query = (params: getThingById.Params) => ({ sql, args: [params.id], name: "getThingById" });

export const getThingById = Object.assign(
  async function getThingById(
    client: Client,
    params: getThingById.Params,
  ): Promise<getThingById.Result | null> {
    const rows = await client.all<getThingById.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getThingById {
  export type Params = {
    id: string;
  };
  export type Result = {
    id: string;
    thing: string;
    created_at: string;
    updated_at: string;
  };
}
