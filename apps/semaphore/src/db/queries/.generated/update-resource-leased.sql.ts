import type { Client } from "sqlfu";

const sql = `
UPDATE resources
SET lease_state = ?,
  leased_until = ?,
  last_acquired_at = ?,
  updated_at = ?
WHERE type = ? AND slug = ?;
`.trim();
const query = (data: updateResourceLeased.Data, params: updateResourceLeased.Params) => ({
  sql,
  args: [
    data.leaseState,
    data.leasedUntil,
    data.lastAcquiredAt,
    data.updatedAt,
    params.type,
    params.slug,
  ],
  name: "updateResourceLeased",
});

export const updateResourceLeased = Object.assign(
  async function updateResourceLeased(
    client: Client,
    data: updateResourceLeased.Data,
    params: updateResourceLeased.Params,
  ) {
    return client.run(query(data, params));
  },
  { sql, query },
);

export namespace updateResourceLeased {
  export type Data = {
    leaseState: string;
    leasedUntil: number | null;
    lastAcquiredAt: number | null;
    updatedAt: string;
  };
  export type Params = {
    type: string;
    slug: string;
  };
}
