import type { Client } from "sqlfu";

const sql = `
INSERT INTO resources (type, slug, data)
VALUES (?, ?, ?);
`.trim();
const query = (params: insertResourceRow.Params) => ({
  sql,
  args: [params.type, params.slug, params.data],
  name: "insertResourceRow",
});

export const insertResourceRow = Object.assign(
  async function insertResourceRow(client: Client, params: insertResourceRow.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertResourceRow {
  export type Params = {
    type: string;
    slug: string;
    data: string;
  };
}
