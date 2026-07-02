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

/** @name listAllProjectsWithOrganization */
SELECT p.id,
  p.organization_id AS organizationId,
  p.name,
  p.slug,
  p.metadata,
  p.archived_at AS archivedAt,
  p.created_at AS createdAt,
  p.updated_at AS updatedAt,
  o.name AS organizationName
FROM project p
JOIN organization o ON o.id = p.organization_id
ORDER BY p.created_at DESC,
  p.slug ASC
LIMIT :limit OFFSET :offset;

/** @name countProjects */
SELECT COUNT(*) AS total
FROM project;

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
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt;

/** @name updateProjectReturning */
UPDATE project
SET name = :name,
  slug = :slug,
  metadata = :metadata,
  updated_at = :updatedAt
WHERE id = :id
RETURNING id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt;

/** @name deleteProjectById */
DELETE FROM project
WHERE id = :id;
