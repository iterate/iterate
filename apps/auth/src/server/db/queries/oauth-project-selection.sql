/** @name getFreshOAuthProjectSelectionBySessionId */
SELECT session_id AS sessionId,
  client_id AS clientId,
  user_id AS userId,
  project_ids AS projectIds,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM oauthProjectSelection
WHERE session_id = :sessionId
  AND updated_at > :minUpdatedAt
ORDER BY updated_at DESC
LIMIT 1;

/** @name upsertOAuthProjectSelectionReturning */
INSERT INTO oauthProjectSelection (
  session_id,
  client_id,
  user_id,
  project_ids,
  created_at,
  updated_at
)
VALUES (
  :sessionId,
  :clientId,
  :userId,
  :projectIds,
  :createdAt,
  :updatedAt
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

/** @name deleteStaleOAuthProjectSelections */
DELETE FROM oauthProjectSelection
WHERE updated_at <= :maxUpdatedAt;
