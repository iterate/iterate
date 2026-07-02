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

/** @name overwriteOAuthClientByClientId */
UPDATE oauthClient
SET clientId = :newClientId,
  clientSecret = :clientSecret,
  name = :name,
  redirectUris = :redirectUris,
  referenceId = :referenceId,
  skipConsent = :skipConsent,
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

/** @name getOAuthAccessTokenForInternalIntrospection */
SELECT oat.id,
  oat.clientId,
  oat.sessionId,
  oat.userId,
  oat.referenceId,
  oat.expiresAt,
  oat.createdAt,
  oat.scopes,
  oc.disabled AS clientDisabled,
  s.expiresAt AS sessionExpiresAt,
  u.role AS userRole
FROM oauthAccessToken oat
JOIN oauthClient oc ON oc.clientId = oat.clientId
LEFT JOIN session s ON s.id = oat.sessionId
LEFT JOIN user u ON u.id = oat.userId
WHERE oat.token = :token
LIMIT 1;
