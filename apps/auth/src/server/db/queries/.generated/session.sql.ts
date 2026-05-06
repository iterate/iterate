import type { Client } from "sqlfu";

const sql = `
SELECT activeOrganizationId
FROM session
WHERE id = ?
LIMIT 1;
`.trim();
const query = (params: getSessionActiveOrganizationIdById.Params) => ({
  name: "getSessionActiveOrganizationIdById",
  sql,
  args: [params.id],
});

export const getSessionActiveOrganizationIdById = Object.assign(
  async function getSessionActiveOrganizationIdById(
    client: Client,
    params: getSessionActiveOrganizationIdById.Params,
  ): Promise<getSessionActiveOrganizationIdById.Result | null> {
    const rows = await client.all<getSessionActiveOrganizationIdById.Result>(query(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getSessionActiveOrganizationIdById {
  export type Params = {
    id: string;
  };
  export type Result = {
    activeOrganizationId?: string;
  };
}
