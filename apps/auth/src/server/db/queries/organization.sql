/** @name getOrganizationBySlug */
SELECT id, name, slug
FROM organization
WHERE slug = :slug
LIMIT 1;

/** @name insertOrganization */
INSERT INTO organization (id, name, slug, logo, createdAt, metadata)
VALUES (:id, :name, :slug, :logo, :createdAt, :metadata);

/** @name updateOrganizationNameById */
UPDATE organization
SET name = :name
WHERE id = :id;

/** @name deleteOrganizationById */
DELETE FROM organization
WHERE id = :id;

/** @name getMembershipByOrganizationAndUserId */
SELECT id, organizationId, userId, role
FROM member
WHERE organizationId = :organizationId
  AND userId = :userId
LIMIT 1;

/** @name insertMembership */
INSERT INTO member (id, organizationId, userId, role, createdAt)
VALUES (:id, :organizationId, :userId, :role, :createdAt);

/** @name updateMembershipRoleByOrganizationAndUserId */
UPDATE member
SET role = :role
WHERE organizationId = :organizationId
  AND userId = :userId;

/** @name deleteMembershipByOrganizationAndUserId */
DELETE FROM member
WHERE organizationId = :organizationId
  AND userId = :userId;

/** @name listMembersByOrganizationId */
SELECT m.id,
  m.userId,
  m.role,
  u.name AS userName,
  u.email AS userEmail,
  u.image AS userImage,
  u.role AS userRole
FROM member m
JOIN user u ON u.id = m.userId
WHERE m.organizationId = :organizationId
ORDER BY m.createdAt ASC,
  u.email ASC;

/** @name getOrganizationMemberPresenceByEmail */
SELECT 1 AS present
FROM member m
JOIN user u ON u.id = m.userId
WHERE m.organizationId = :organizationId
  AND u.email = :email
LIMIT 1;

/** @name getInviteByOrganizationAndEmail */
SELECT id
FROM invitation
WHERE organizationId = :organizationId
  AND email = :email
LIMIT 1;

/** @name insertInvite */
INSERT INTO invitation (
  id,
  organizationId,
  email,
  role,
  status,
  expiresAt,
  createdAt,
  inviterId
)
VALUES (
  :id,
  :organizationId,
  :email,
  :role,
  :status,
  :expiresAt,
  :createdAt,
  :inviterId
);

/** @name listInvitesByOrganizationId */
SELECT i.id,
  i.email,
  i.role,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug,
  u.id AS inviterId,
  u.name AS inviterName,
  u.email AS inviterEmail
FROM invitation i
JOIN organization o ON o.id = i.organizationId
JOIN user u ON u.id = i.inviterId
WHERE i.organizationId = :organizationId
ORDER BY i.createdAt DESC,
  i.email ASC;

/** @name deleteInviteByIdAndOrganizationId */
DELETE FROM invitation
WHERE id = :id
  AND organizationId = :organizationId;

/** @name listPendingInvitesByEmail */
SELECT i.id,
  i.email,
  i.role,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug,
  u.id AS inviterId,
  u.name AS inviterName,
  u.email AS inviterEmail
FROM invitation i
JOIN organization o ON o.id = i.organizationId
JOIN user u ON u.id = i.inviterId
WHERE i.email = :email
  AND i.status = 'pending'
ORDER BY i.createdAt DESC,
  i.id ASC;

/** @name getPendingInviteByIdAndEmail */
SELECT i.id,
  i.email,
  i.role,
  i.organizationId,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug
FROM invitation i
JOIN organization o ON o.id = i.organizationId
WHERE i.id = :id
  AND i.email = :email
  AND i.status = 'pending'
LIMIT 1;

/** @name updateInviteStatusById */
UPDATE invitation
SET status = :status
WHERE id = :id;
