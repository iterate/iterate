import type { Client } from "sqlfu";

const sql = `
insert into projects (id, slug)
values (?, ?)
returning id, slug, custom_hostname, created_at, updated_at;
`.trim();
const query = (params: insertProject.Params) => ({
  name: "insertProject",
  sql,
  args: [params.id, params.slug],
});

export const insertProject = Object.assign(
  async function insertProject(
    client: Client,
    params: insertProject.Params,
  ): Promise<insertProject.Result> {
    const rows = await client.all<insertProject.Result>(query(params));
    return rows[0];
  },
  { sql, query },
);

export namespace insertProject {
  export type Params = {
    id: string;
    slug: string;
  };
  export type Result = {
    id: string;
    slug: string;
    custom_hostname?: string;
    created_at: string;
    updated_at: string;
  };
}
