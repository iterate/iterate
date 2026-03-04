-- First update existing slugs to remove dots and underscores (hyphens are fine)
UPDATE "organization" SET "slug" = regexp_replace("slug", '\.com$', '');--> statement-breakpoint
UPDATE "organization" SET "slug" = regexp_replace("slug", '[._]+', '-', 'g');--> statement-breakpoint
UPDATE "organization" SET "slug" = regexp_replace("slug", '^-+', '', '');--> statement-breakpoint
UPDATE "organization" SET "slug" = regexp_replace("slug", '-+$', '', '');--> statement-breakpoint
UPDATE "project" SET "slug" = regexp_replace("slug", '[._]+', '-', 'g');--> statement-breakpoint
UPDATE "project" SET "slug" = regexp_replace("slug", '^-+', '', '');--> statement-breakpoint
UPDATE "project" SET "slug" = regexp_replace("slug", '-+$', '', '');--> statement-breakpoint
-- Now add constraints
ALTER TABLE "organization" ADD CONSTRAINT "organization_slug_valid" CHECK ("slug" ~ '^[a-z0-9-]+$' AND "slug" ~ '[a-z]' AND length("slug") <= 50 AND "slug" NOT IN ('prj', 'org'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_slug_valid" CHECK ("slug" ~ '^[a-z0-9-]+$' AND "slug" ~ '[a-z]' AND length("slug") <= 50 AND "slug" NOT IN ('prj', 'org'));