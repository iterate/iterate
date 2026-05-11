DROP INDEX `secrets_project_id_name_unique`;--> statement-breakpoint
DROP INDEX `idx_secrets_project_id_created_at`;--> statement-breakpoint
ALTER TABLE `secrets` RENAME COLUMN `project_id` TO `namespace`;--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_namespace_name_unique` ON `secrets` (`namespace`,`name`);--> statement-breakpoint
CREATE INDEX `idx_secrets_namespace_created_at` ON `secrets` (`namespace`,`created_at`);
