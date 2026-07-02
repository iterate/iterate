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
  name: "getOAuthClientByReferenceId",
  sql: getOAuthClientByReferenceIdSql,
  args: [params.referenceId],
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

const getOAuthClientByClientIdSql = `
SELECT id,
  clientId,
  clientSecret,
  disabled,
  userId,
  name,
  redirectUris AS redirectUrisJson,
  referenceId
FROM oauthClient
WHERE clientId = ?
LIMIT 1;
`.trim();
const getOAuthClientByClientIdQuery = (params: getOAuthClientByClientId.Params) => ({
  name: "getOAuthClientByClientId",
  sql: getOAuthClientByClientIdSql,
  args: [params.clientId],
});

export const getOAuthClientByClientId = Object.assign(
  async function getOAuthClientByClientId(
    client: Client,
    params: getOAuthClientByClientId.Params,
  ): Promise<getOAuthClientByClientId.Result | null> {
    const rows = await client.all<getOAuthClientByClientId.Result>(
      getOAuthClientByClientIdQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getOAuthClientByClientIdSql, query: getOAuthClientByClientIdQuery },
);

export namespace getOAuthClientByClientId {
  export type Params = {
    clientId: string;
  };
  export type Result = {
    id: string;
    clientId: string;
    clientSecret?: string;
    disabled?: number;
    userId?: string;
    name?: string;
    redirectUrisJson: string;
    referenceId?: string;
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
  name: "updateOAuthClientById",
  sql: updateOAuthClientByIdSql,
  args: [data.name, data.redirectUris, data.disabled, data.updatedAt, params.id],
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
  name: "disableOAuthClientById",
  sql: disableOAuthClientByIdSql,
  args: [data.updatedAt, params.id],
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
  name: "updateOAuthClientReferenceByClientId",
  sql: updateOAuthClientReferenceByClientIdSql,
  args: [data.referenceId, data.name, data.redirectUris, data.updatedAt, params.clientId],
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

const overwriteOAuthClientByClientIdSql = `
UPDATE oauthClient
SET clientId = ?,
  clientSecret = ?,
  name = ?,
  redirectUris = ?,
  referenceId = ?,
  skipConsent = ?,
  disabled = 0,
  updatedAt = ?
WHERE clientId = ?;
`.trim();
const overwriteOAuthClientByClientIdQuery = (
  data: overwriteOAuthClientByClientId.Data,
  params: overwriteOAuthClientByClientId.Params,
) => ({
  name: "overwriteOAuthClientByClientId",
  sql: overwriteOAuthClientByClientIdSql,
  args: [
    data.newClientId,
    data.clientSecret,
    data.name,
    data.redirectUris,
    data.referenceId,
    data.skipConsent,
    data.updatedAt,
    params.clientId,
  ],
});

export const overwriteOAuthClientByClientId = Object.assign(
  async function overwriteOAuthClientByClientId(
    client: Client,
    data: overwriteOAuthClientByClientId.Data,
    params: overwriteOAuthClientByClientId.Params,
  ) {
    return client.run(overwriteOAuthClientByClientIdQuery(data, params));
  },
  { sql: overwriteOAuthClientByClientIdSql, query: overwriteOAuthClientByClientIdQuery },
);

export namespace overwriteOAuthClientByClientId {
  export type Data = {
    newClientId: string;
    clientSecret: string | null;
    name: string | null;
    redirectUris: string;
    referenceId: string | null;
    skipConsent: number | null;
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
  name: "listSystemOAuthClients",
  sql: listSystemOAuthClientsSql,
  args: [],
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
