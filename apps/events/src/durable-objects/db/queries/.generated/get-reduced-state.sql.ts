import type { SyncClient } from "sqlfu";

const sql = `select json from reduced_state where singleton = 1;`;
const query = { sql, args: [], name: "getReducedState" };

export const getReducedState = Object.assign(
  function getReducedState(client: SyncClient): getReducedState.Result | null {
    const rows = client.all<getReducedState.Result>(query);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql, query },
);

export namespace getReducedState {
  export type Result = {
    json: string;
  };
}
