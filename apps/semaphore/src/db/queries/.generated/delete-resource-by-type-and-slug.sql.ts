import type { Client } from "sqlfu";

const sql = `
DELETE FROM resources
WHERE type = ? AND slug = ?;
`.trim();
const query = (params: deleteResourceByTypeAndSlug.Params) => ({
  sql,
  args: [params.type, params.slug],
  name: "deleteResourceByTypeAndSlug",
});

export const deleteResourceByTypeAndSlug = Object.assign(
  async function deleteResourceByTypeAndSlug(
    client: Client,
    params: deleteResourceByTypeAndSlug.Params,
  ) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace deleteResourceByTypeAndSlug {
  export type Params = {
    type: string;
    slug: string;
  };
}
