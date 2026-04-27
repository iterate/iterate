import type { Client } from "sqlfu";

const sql = `
insert into things (id, thing, created_at, updated_at)
values (?, ?, ?, ?);
`.trim();
const query = (params: insertThing.Params) => ({
  sql,
  args: [params.id, params.thing, params.createdAt, params.updatedAt],
  name: "insertThing",
});

export const insertThing = Object.assign(
  async function insertThing(client: Client, params: insertThing.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertThing {
  export type Params = {
    id: string;
    thing: string;
    createdAt: string;
    updatedAt: string;
  };
}
