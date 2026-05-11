import type { Client } from "sqlfu";

const sql = `
insert into secrets (id, namespace, name, value, description, created_at, updated_at)
values (?, ?, ?, ?, ?, ?, ?);
`.trim();
const query = (params: insertSecret.Params) => ({
  sql,
  args: [
    params.id,
    params.namespace,
    params.name,
    params.value,
    params.description,
    params.createdAt,
    params.updatedAt,
  ],
  name: "insertSecret",
});

export const insertSecret = Object.assign(
  async function insertSecret(client: Client, params: insertSecret.Params) {
    return client.run(query(params));
  },
  { sql, query },
);

export namespace insertSecret {
  export type Params = {
    id: string;
    namespace: string;
    name: string;
    value: string;
    description: string | null;
    createdAt: string;
    updatedAt: string;
  };
}
