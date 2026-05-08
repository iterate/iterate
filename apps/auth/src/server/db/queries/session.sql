/** @name getSessionActiveOrganizationIdById */
SELECT activeOrganizationId
FROM session
WHERE id = :id
LIMIT 1;
