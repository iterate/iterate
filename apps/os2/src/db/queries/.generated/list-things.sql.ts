import type { Client } from "sqlfu";

const sql = `
select id, thing, created_at, updated_at
from things
order by created_at desc
limit ?
offset ?;
`.trim();
const query = (params: listThings.Params) => ({
  sql,
  args: [params.limit, params.offset],
  name: "listThings",
});

export const listThings = Object.assign(
  async function listThings(
    client: Client,
    params: listThings.Params,
  ): Promise<listThings.Result[]> {
    return client.all<listThings.Result>(query(params));
  },
  { sql, query },
);

export namespace listThings {
  export type Params = {
    limit: number;
    offset: number;
  };
  export type Result = {
    id: string;
    thing: string;
    created_at: string;
    updated_at: string;
  };
}
