import type { Client } from "sqlfu";

const getFreshOAuthProjectSelectionBySessionIdSql = `
SELECT session_id AS sessionId,
  client_id AS clientId,
  user_id AS userId,
  project_ids AS projectIds,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM oauthProjectSelection
WHERE session_id = ?
  AND updated_at > ?
ORDER BY updated_at DESC
LIMIT 1;
`.trim();
const getFreshOAuthProjectSelectionBySessionIdQuery = (
  params: getFreshOAuthProjectSelectionBySessionId.Params,
) => ({
  name: "getFreshOAuthProjectSelectionBySessionId",
  sql: getFreshOAuthProjectSelectionBySessionIdSql,
  args: [params.sessionId, params.minUpdatedAt],
});

export const getFreshOAuthProjectSelectionBySessionId = Object.assign(
  async function getFreshOAuthProjectSelectionBySessionId(
    client: Client,
    params: getFreshOAuthProjectSelectionBySessionId.Params,
  ): Promise<getFreshOAuthProjectSelectionBySessionId.Result | null> {
    const rows = await client.all<getFreshOAuthProjectSelectionBySessionId.Result>(
      getFreshOAuthProjectSelectionBySessionIdQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  {
    sql: getFreshOAuthProjectSelectionBySessionIdSql,
    query: getFreshOAuthProjectSelectionBySessionIdQuery,
  },
);

export namespace getFreshOAuthProjectSelectionBySessionId {
  export type Params = {
    sessionId: string;
    minUpdatedAt: number;
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

const deleteStaleOAuthProjectSelectionsSql = `
DELETE FROM oauthProjectSelection
WHERE updated_at <= ?;
`.trim();
const deleteStaleOAuthProjectSelectionsQuery = (
  params: deleteStaleOAuthProjectSelections.Params,
) => ({
  name: "deleteStaleOAuthProjectSelections",
  sql: deleteStaleOAuthProjectSelectionsSql,
  args: [params.maxUpdatedAt],
});

export const deleteStaleOAuthProjectSelections = Object.assign(
  async function deleteStaleOAuthProjectSelections(
    client: Client,
    params: deleteStaleOAuthProjectSelections.Params,
  ) {
    return client.run(deleteStaleOAuthProjectSelectionsQuery(params));
  },
  { sql: deleteStaleOAuthProjectSelectionsSql, query: deleteStaleOAuthProjectSelectionsQuery },
);

export namespace deleteStaleOAuthProjectSelections {
  export type Params = {
    maxUpdatedAt: number;
  };
}
