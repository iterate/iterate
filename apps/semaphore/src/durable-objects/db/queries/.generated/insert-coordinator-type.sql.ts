import type { SyncClient } from "sqlfu";

const sql = `
INSERT OR REPLACE INTO metadata (key, value)
VALUES ('type', ?);
`.trim();
const query = (params: insertCoordinatorType.Params) => ({
  sql,
  args: [params.type],
  name: "insertCoordinatorType",
});

export const insertCoordinatorType = Object.assign(
  function insertCoordinatorType(client: SyncClient, params: insertCoordinatorType.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertCoordinatorType {
  export type Params = {
    type: string;
  };
}
