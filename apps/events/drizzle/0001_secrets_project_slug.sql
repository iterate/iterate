DROP INDEX `secrets_name_unique`;--> statement-breakpoint
DROP INDEX `idx_secrets_created_at`;--> statement-breakpoint
ALTER TABLE `secrets` ADD `project_slug` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_project_slug_name_unique` ON `secrets` (`project_slug`,`name`);--> statement-breakpoint
CREATE INDEX `idx_secrets_project_slug_created_at` ON `secrets` (`project_slug`,`created_at`);