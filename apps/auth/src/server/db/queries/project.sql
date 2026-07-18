/** @name getProjectBySlug */
SELECT id,
  organization_id AS organizationId,
  creator_email AS creatorEmail,
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
  creator_email AS creatorEmail,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
WHERE id = :id
LIMIT 1;

/** @name getProjectAccessForUser */
SELECT u.role AS userRole,
  CASE WHEN m.id IS NULL THEN 0 ELSE 1 END AS hasMembership
FROM project p
JOIN user u ON u.id = :userId
LEFT JOIN member m ON m.organizationId = p.organization_id
  AND m.userId = u.id
WHERE p.id = :projectId
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

/** @name listProjects */
SELECT id,
  organization_id AS organizationId,
  creator_email AS creatorEmail,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
ORDER BY created_at ASC,
  slug ASC
LIMIT :limit;

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

/** @name insertProjectIfAbsent */
INSERT INTO project (
  id,
  organization_id,
  creator_email,
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
  :creatorEmail,
  :name,
  :slug,
  :metadata,
  :archivedAt,
  :createdAt,
  :updatedAt
)
ON CONFLICT DO NOTHING;

/** @name updateProjectReturning */
UPDATE project
SET name = :name,
  slug = :slug,
  metadata = :metadata,
  updated_at = :updatedAt
WHERE id = :id
RETURNING id,
  organization_id,
  creator_email,
  name,
  slug,
  metadata,
  archived_at;

/** @name deleteProjectById */
DELETE FROM project
WHERE id = :id;
