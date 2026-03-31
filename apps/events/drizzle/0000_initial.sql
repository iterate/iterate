CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_name_unique` ON `secrets` (`name`);--> statement-breakpoint
CREATE INDEX `idx_secrets_created_at` ON `secrets` (`created_at`);