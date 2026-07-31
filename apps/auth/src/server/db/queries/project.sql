/** @name getProjectBySlug */
SELECT id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
WHERE slug = :slug
LIMIT 1;

/** @name getProjectById */
SELECT id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
WHERE id = :id
LIMIT 1;

/** @name getProjectAccessForUser */
-- Anchored on the USER, not the project: admin-lane projects (created through
-- the deployment admin secret) have no directory row at all, and a platform
-- admin's role must still be visible for them — anchoring on project made
-- every such project invisible to project-app auth for everyone.
SELECT u.role AS userRole,
  CASE WHEN m.id IS NULL THEN 0 ELSE 1 END AS hasMembership
FROM user u
LEFT JOIN project p ON p.id = :projectId
LEFT JOIN member m ON m.organizationId = p.organization_id
  AND m.userId = u.id
WHERE u.id = :userId
LIMIT 1;

/** @name getProjectWithOrganizationBySlug */
SELECT p.id,
  p.organization_id AS organizationId,
  p.name,
  p.slug,
  p.metadata,
  p.archived_at AS archivedAt,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug
FROM project p
JOIN organization o ON o.id = p.organization_id
WHERE p.slug = :slug
LIMIT 1;

/** @name listProjectsByOrganizationId */
SELECT id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
WHERE organization_id = :organizationId
ORDER BY created_at ASC,
  slug ASC;

/** @name listProjectsForUser */
SELECT p.id,
  p.organization_id AS organizationId,
  p.name,
  p.slug,
  p.metadata,
  p.archived_at AS archivedAt
FROM project p
JOIN member m ON m.organizationId = p.organization_id
WHERE m.userId = :userId
ORDER BY p.created_at ASC,
  p.slug ASC;

/** @name insertProjectReturning */
INSERT INTO project (
  id,
  organization_id,
  name,
  slug,
  metadata,
  archived_at,
  created_at,
  updated_at
)
VALUES (
  :id,
  :organizationId,
  :name,
  :slug,
  :metadata,
  :archivedAt,
  :createdAt,
  :updatedAt
)
RETURNING id,
  organization_id,
  name,
  slug,
  metadata,
  archived_at;

/** @name updateProjectReturning */
UPDATE project
SET name = :name,
  slug = :slug,
  metadata = :metadata,
  updated_at = :updatedAt
WHERE id = :id
RETURNING id,
  organization_id,
  name,
  slug,
  metadata,
  archived_at;

/** @name deleteProjectById */
DELETE FROM project
WHERE id = :id;
