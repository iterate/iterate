import type { SyncClient } from "sqlfu";

const sql = `
insert into reduced_state (singleton, json)
values (1, json(?))
on conflict (singleton) do update set json = excluded.json;
`.trim();
const query = (params: upsertReducedState.Params) => ({
  name: "upsertReducedState",
  sql,
  args: [params.json],
});

export const upsertReducedState = Object.assign(
  function upsertReducedState(client: SyncClient, params: upsertReducedState.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace upsertReducedState {
  export type Params = {
    json: string | null;
  };
}
