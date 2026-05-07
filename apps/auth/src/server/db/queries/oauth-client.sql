/** @name getOAuthClientByReferenceId */
SELECT id,
  clientId,
  clientSecret,
  disabled,
  userId,
  name,
  redirectUris AS redirectUrisJson,
  referenceId
FROM oauthClient
WHERE referenceId = :referenceId
LIMIT 1;

/** @name getOAuthClientByClientId */
SELECT id,
  clientId,
  clientSecret,
  disabled,
  userId,
  name,
  redirectUris AS redirectUrisJson,
  referenceId
FROM oauthClient
WHERE clientId = :clientId
LIMIT 1;

/** @name updateOAuthClientById */
UPDATE oauthClient
SET name = :name,
  redirectUris = :redirectUris,
  disabled = :disabled,
  updatedAt = :updatedAt
WHERE id = :id;

/** @name disableOAuthClientById */
UPDATE oauthClient
SET referenceId = NULL,
  disabled = 1,
  updatedAt = :updatedAt
WHERE id = :id;

/** @name updateOAuthClientReferenceByClientId */
UPDATE oauthClient
SET referenceId = :referenceId,
  name = :name,
  redirectUris = :redirectUris,
  disabled = 0,
  updatedAt = :updatedAt
WHERE clientId = :clientId;

/** @name listSystemOAuthClients */
SELECT clientId,
  name,
  redirectUris AS redirectUrisJson
FROM oauthClient
WHERE disabled = 0
  AND userId IS NULL
ORDER BY createdAt DESC;
