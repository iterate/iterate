import type { Client } from "sqlfu";

const sql = `
insert into projects (id, slug, metadata, created_at, updated_at)
values (?, ?, ?, ?, ?);
`.trim();
const query = (params: insertProject.Params) => ({
  sql,
  args: [params.id, params.slug, params.metadata, params.createdAt, params.updatedAt],
  name: "insertProject",
});

export const insertProject = Object.assign(
  async function insertProject(client: Client, params: insertProject.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertProject {
  export type Params = {
    id: string;
    slug: string;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  };
}
