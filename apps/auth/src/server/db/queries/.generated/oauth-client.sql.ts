import type { Client } from "sqlfu";

const getOAuthClientByReferenceIdSql = `
SELECT id,
  clientId,
  clientSecret,
  disabled,
  userId,
  name,
  redirectUris AS redirectUrisJson,
  referenceId
FROM oauthClient
WHERE referenceId = ?
LIMIT 1;
`.trim();
const getOAuthClientByReferenceIdQuery = (params: getOAuthClientByReferenceId.Params) => ({
  sql: getOAuthClientByReferenceIdSql,
  args: [params.referenceId],
  name: "getOAuthClientByReferenceId",
});

export const getOAuthClientByReferenceId = Object.assign(
  async function getOAuthClientByReferenceId(
    client: Client,
    params: getOAuthClientByReferenceId.Params,
  ): Promise<getOAuthClientByReferenceId.Result | null> {
    const rows = await client.all<getOAuthClientByReferenceId.Result>(
      getOAuthClientByReferenceIdQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getOAuthClientByReferenceIdSql, query: getOAuthClientByReferenceIdQuery },
);

export namespace getOAuthClientByReferenceId {
  export type Params = {
    referenceId: string;
  };
  export type Result = {
    id: string;
    clientId: string;
    clientSecret?: string;
    disabled?: number;
    userId?: string;
    name?: string;
    redirectUrisJson: string;
    referenceId: string;
  };
}

const updateOAuthClientByIdSql = `
UPDATE oauthClient
SET name = ?,
  redirectUris = ?,
  disabled = ?,
  updatedAt = ?
WHERE id = ?;
`.trim();
const updateOAuthClientByIdQuery = (
  data: updateOAuthClientById.Data,
  params: updateOAuthClientById.Params,
) => ({
  sql: updateOAuthClientByIdSql,
  args: [data.name, data.redirectUris, data.disabled, data.updatedAt, params.id],
  name: "updateOAuthClientById",
});

export const updateOAuthClientById = Object.assign(
  async function updateOAuthClientById(
    client: Client,
    data: updateOAuthClientById.Data,
    params: updateOAuthClientById.Params,
  ) {
    return client.run(updateOAuthClientByIdQuery(data, params));
  },
  { sql: updateOAuthClientByIdSql, query: updateOAuthClientByIdQuery },
);

export namespace updateOAuthClientById {
  export type Data = {
    name: string | null;
    redirectUris: string;
    disabled: number | null;
    updatedAt: number | null;
  };
  export type Params = {
    id: string;
  };
}

const disableOAuthClientByIdSql = `
UPDATE oauthClient
SET referenceId = NULL,
  disabled = 1,
  updatedAt = ?
WHERE id = ?;
`.trim();
const disableOAuthClientByIdQuery = (
  data: disableOAuthClientById.Data,
  params: disableOAuthClientById.Params,
) => ({
  sql: disableOAuthClientByIdSql,
  args: [data.updatedAt, params.id],
  name: "disableOAuthClientById",
});

export const disableOAuthClientById = Object.assign(
  async function disableOAuthClientById(
    client: Client,
    data: disableOAuthClientById.Data,
    params: disableOAuthClientById.Params,
  ) {
    return client.run(disableOAuthClientByIdQuery(data, params));
  },
  { sql: disableOAuthClientByIdSql, query: disableOAuthClientByIdQuery },
);

export namespace disableOAuthClientById {
  export type Data = {
    updatedAt: number | null;
  };
  export type Params = {
    id: string;
  };
}

const updateOAuthClientReferenceByClientIdSql = `
UPDATE oauthClient
SET referenceId = ?,
  name = ?,
  redirectUris = ?,
  disabled = 0,
  updatedAt = ?
WHERE clientId = ?;
`.trim();
const updateOAuthClientReferenceByClientIdQuery = (
  data: updateOAuthClientReferenceByClientId.Data,
  params: updateOAuthClientReferenceByClientId.Params,
) => ({
  sql: updateOAuthClientReferenceByClientIdSql,
  args: [data.referenceId, data.name, data.redirectUris, data.updatedAt, params.clientId],
  name: "updateOAuthClientReferenceByClientId",
});

export const updateOAuthClientReferenceByClientId = Object.assign(
  async function updateOAuthClientReferenceByClientId(
    client: Client,
    data: updateOAuthClientReferenceByClientId.Data,
    params: updateOAuthClientReferenceByClientId.Params,
  ) {
    return client.run(updateOAuthClientReferenceByClientIdQuery(data, params));
  },
  {
    sql: updateOAuthClientReferenceByClientIdSql,
    query: updateOAuthClientReferenceByClientIdQuery,
  },
);

export namespace updateOAuthClientReferenceByClientId {
  export type Data = {
    referenceId: string | null;
    name: string | null;
    redirectUris: string;
    updatedAt: number | null;
  };
  export type Params = {
    clientId: string;
  };
}

const listSystemOAuthClientsSql = `
SELECT clientId,
  name,
  redirectUris AS redirectUrisJson
FROM oauthClient
WHERE disabled = 0
  AND userId IS NULL
ORDER BY createdAt DESC;
`.trim();
const listSystemOAuthClientsQuery = {
  sql: listSystemOAuthClientsSql,
  args: [],
  name: "listSystemOAuthClients",
};

export const listSystemOAuthClients = Object.assign(
  async function listSystemOAuthClients(client: Client): Promise<listSystemOAuthClients.Result[]> {
    return client.all<listSystemOAuthClients.Result>(listSystemOAuthClientsQuery);
  },
  { sql: listSystemOAuthClientsSql, query: listSystemOAuthClientsQuery },
);

export namespace listSystemOAuthClients {
  export type Result = {
    clientId: string;
    name?: string;
    redirectUrisJson: string;
  };
}
