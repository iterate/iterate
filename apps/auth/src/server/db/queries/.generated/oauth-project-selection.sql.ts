import type { Client } from "sqlfu";

const getOAuthProjectSelectionBySessionAndClientSql = `
SELECT session_id AS sessionId,
  client_id AS clientId,
  user_id AS userId,
  project_ids AS projectIds,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM oauthProjectSelection
WHERE session_id = ?
  AND client_id = ?
LIMIT 1;
`.trim();
const getOAuthProjectSelectionBySessionAndClientQuery = (
  params: getOAuthProjectSelectionBySessionAndClient.Params,
) => ({
  name: "getOAuthProjectSelectionBySessionAndClient",
  sql: getOAuthProjectSelectionBySessionAndClientSql,
  args: [params.sessionId, params.clientId],
});

export const getOAuthProjectSelectionBySessionAndClient = Object.assign(
  async function getOAuthProjectSelectionBySessionAndClient(
    client: Client,
    params: getOAuthProjectSelectionBySessionAndClient.Params,
  ): Promise<getOAuthProjectSelectionBySessionAndClient.Result | null> {
    const rows = await client.all<getOAuthProjectSelectionBySessionAndClient.Result>(
      getOAuthProjectSelectionBySessionAndClientQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  {
    sql: getOAuthProjectSelectionBySessionAndClientSql,
    query: getOAuthProjectSelectionBySessionAndClientQuery,
  },
);

export namespace getOAuthProjectSelectionBySessionAndClient {
  export type Params = {
    sessionId: string;
    clientId: string;
  };
  export type Result = {
    sessionId: string;
    clientId: string;
    userId: string;
    projectIds: string;
    createdAt: number;
    updatedAt: number;
  };
}

const getLatestOAuthProjectSelectionByUserIdSql = `
SELECT session_id AS sessionId,
  client_id AS clientId,
  user_id AS userId,
  project_ids AS projectIds,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM oauthProjectSelection
WHERE user_id = ?
ORDER BY updated_at DESC
LIMIT 1;
`.trim();
const getLatestOAuthProjectSelectionByUserIdQuery = (
  params: getLatestOAuthProjectSelectionByUserId.Params,
) => ({
  name: "getLatestOAuthProjectSelectionByUserId",
  sql: getLatestOAuthProjectSelectionByUserIdSql,
  args: [params.userId],
});

export const getLatestOAuthProjectSelectionByUserId = Object.assign(
  async function getLatestOAuthProjectSelectionByUserId(
    client: Client,
    params: getLatestOAuthProjectSelectionByUserId.Params,
  ): Promise<getLatestOAuthProjectSelectionByUserId.Result | null> {
    const rows = await client.all<getLatestOAuthProjectSelectionByUserId.Result>(
      getLatestOAuthProjectSelectionByUserIdQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  {
    sql: getLatestOAuthProjectSelectionByUserIdSql,
    query: getLatestOAuthProjectSelectionByUserIdQuery,
  },
);

export namespace getLatestOAuthProjectSelectionByUserId {
  export type Params = {
    userId: string;
  };
  export type Result = {
    sessionId: string;
    clientId: string;
    userId: string;
    projectIds: string;
    createdAt: number;
    updatedAt: number;
  };
}

const upsertOAuthProjectSelectionReturningSql = `
INSERT INTO oauthProjectSelection (
  session_id,
  client_id,
  user_id,
  project_ids,
  created_at,
  updated_at
)
VALUES (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)
ON CONFLICT (session_id, client_id) DO UPDATE
SET user_id = excluded.user_id,
  project_ids = excluded.project_ids,
  updated_at = excluded.updated_at
RETURNING session_id AS sessionId,
  client_id AS clientId,
  user_id AS userId,
  project_ids AS projectIds,
  created_at AS createdAt,
  updated_at AS updatedAt;
`.trim();
const upsertOAuthProjectSelectionReturningQuery = (
  params: upsertOAuthProjectSelectionReturning.Params,
) => ({
  name: "upsertOAuthProjectSelectionReturning",
  sql: upsertOAuthProjectSelectionReturningSql,
  args: [
    params.sessionId,
    params.clientId,
    params.userId,
    params.projectIds,
    params.createdAt,
    params.updatedAt,
  ],
});

export const upsertOAuthProjectSelectionReturning = Object.assign(
  async function upsertOAuthProjectSelectionReturning(
    client: Client,
    params: upsertOAuthProjectSelectionReturning.Params,
  ): Promise<upsertOAuthProjectSelectionReturning.Result> {
    const rows = await client.all<upsertOAuthProjectSelectionReturning.Result>(
      upsertOAuthProjectSelectionReturningQuery(params),
    );
    return rows[0];
  },
  {
    sql: upsertOAuthProjectSelectionReturningSql,
    query: upsertOAuthProjectSelectionReturningQuery,
  },
);

export namespace upsertOAuthProjectSelectionReturning {
  export type Params = {
    sessionId: string;
    clientId: string;
    userId: string;
    projectIds: string;
    createdAt: number;
    updatedAt: number;
  };
  export type Result = {
    session_id: string;
    client_id: string;
    user_id: string;
    project_ids: string;
    created_at: number;
    updated_at: number;
  };
}

const deleteOAuthProjectSelectionsByUserIdSql = `
DELETE FROM oauthProjectSelection
WHERE user_id = ?;
`.trim();
const deleteOAuthProjectSelectionsByUserIdQuery = (
  params: deleteOAuthProjectSelectionsByUserId.Params,
) => ({
  name: "deleteOAuthProjectSelectionsByUserId",
  sql: deleteOAuthProjectSelectionsByUserIdSql,
  args: [params.userId],
});

export const deleteOAuthProjectSelectionsByUserId = Object.assign(
  async function deleteOAuthProjectSelectionsByUserId(
    client: Client,
    params: deleteOAuthProjectSelectionsByUserId.Params,
  ) {
    return client.run(deleteOAuthProjectSelectionsByUserIdQuery(params));
  },
  {
    sql: deleteOAuthProjectSelectionsByUserIdSql,
    query: deleteOAuthProjectSelectionsByUserIdQuery,
  },
);

export namespace deleteOAuthProjectSelectionsByUserId {
  export type Params = {
    userId: string;
  };
}
