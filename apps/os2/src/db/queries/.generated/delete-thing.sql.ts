import type { Client } from "sqlfu";

const sql = `
delete from things
where id = ?;
`.trim();
const query = (params: deleteThing.Params) => ({ sql, args: [params.id], name: "deleteThing" });

export const deleteThing = Object.assign(
  async function deleteThing(client: Client, params: deleteThing.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteThing {
  export type Params = {
    id: string;
  };
}
