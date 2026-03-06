DROP TABLE "project_repo" CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "config_repo_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "config_repo_full_name" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "config_repo_default_branch" text;