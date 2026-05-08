DROP INDEX `secrets_project_slug_name_unique`;--> statement-breakpoint
DROP INDEX `idx_secrets_project_slug_created_at`;--> statement-breakpoint
ALTER TABLE `secrets` RENAME COLUMN `project_slug` TO `project_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_project_id_name_unique` ON `secrets` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_secrets_project_id_created_at` ON `secrets` (`project_id`,`created_at`);
