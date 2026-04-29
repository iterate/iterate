import type { Client } from "sqlfu";

const sql = `
insert into projects (id, slug, clerk_org_id, created_by_clerk_user_id, metadata)
values (?, ?, ?, ?, ?)
returning id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at;
`.trim();
const query = (params: insertProject.Params) => ({
  sql,
  args: [params.id, params.slug, params.clerkOrgId, params.createdByClerkUserId, params.metadata],
  name: "insertProject",
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
    clerkOrgId: string | null;
    createdByClerkUserId: string | null;
    metadata: string;
  };
  export type Result = {
    id: string;
    slug: string;
    clerk_org_id?: string;
    created_by_clerk_user_id?: string;
    custom_hostname?: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  };
}
