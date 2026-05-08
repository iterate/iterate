import type { Client } from "sqlfu";

const sql = `
update projects
set custom_hostname = ?,
    metadata = ?,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
where id = ?;
`.trim();
const query = (data: updateProjectConfig.Data, params: updateProjectConfig.Params) => ({
  name: "updateProjectConfig",
  sql,
  args: [data.customHostname, data.metadata, params.id],
});

export const updateProjectConfig = Object.assign(
  async function updateProjectConfig(
    client: Client,
    data: updateProjectConfig.Data,
    params: updateProjectConfig.Params,
  ) {
    return client.run(query(data, params));
  },
  { sql, query },
);

export namespace updateProjectConfig {
  export type Data = {
    customHostname: string | null;
    metadata: string;
  };
  export type Params = {
    id: string;
  };
}
