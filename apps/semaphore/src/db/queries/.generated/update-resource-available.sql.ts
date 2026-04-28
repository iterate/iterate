import type { Client } from "sqlfu";

const sql = `
UPDATE resources
SET lease_state = ?,
  leased_until = ?,
  last_released_at = COALESCE(?, last_released_at),
  updated_at = ?
WHERE type = ? AND slug = ?;
`.trim();
const query = (data: updateResourceAvailable.Data, params: updateResourceAvailable.Params) => ({
  sql,
  args: [
    data.leaseState,
    data.leasedUntil,
    data.lastReleasedAt,
    data.updatedAt,
    params.type,
    params.slug,
  ],
  name: "updateResourceAvailable",
});

export const updateResourceAvailable = Object.assign(
  async function updateResourceAvailable(
    client: Client,
    data: updateResourceAvailable.Data,
    params: updateResourceAvailable.Params,
  ) {
    return client.run(query(data, params));
  },
  { sql, query },
);

export namespace updateResourceAvailable {
  export type Data = {
    leaseState: string;
    leasedUntil: number | null;
    lastReleasedAt: number | null;
    updatedAt: string;
  };
  export type Params = {
    type: string;
    slug: string;
  };
}
