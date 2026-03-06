-- Migration: Make project slugs globally unique and migrate to match org slugs
-- For orgs with multiple projects, first project (by creation time) gets org slug,
-- subsequent projects get numbered suffixes (org-slug2, org-slug3, etc.)

-- Step 1: Update project slugs to match their org slugs
-- Use a CTE to assign row numbers within each org ordered by creation time
WITH ranked_projects AS (
  SELECT 
    p.id as project_id,
    o.slug as org_slug,
    ROW_NUMBER() OVER (PARTITION BY p.organization_id ORDER BY p.created_at ASC) as rn
  FROM project p
  JOIN organization o ON p.organization_id = o.id
)
UPDATE project
SET slug = CASE 
  WHEN rp.rn = 1 THEN rp.org_slug
  ELSE rp.org_slug || rp.rn
END
FROM ranked_projects rp
WHERE project.id = rp.project_id;

--> statement-breakpoint
-- Step 2: Drop the old composite unique index (organizationId, slug)
DROP INDEX IF EXISTS "project_organization_id_slug_index";

--> statement-breakpoint
-- Step 3: Add the new global unique constraint on slug
ALTER TABLE "project" ADD CONSTRAINT "project_slug_unique" UNIQUE("slug");
