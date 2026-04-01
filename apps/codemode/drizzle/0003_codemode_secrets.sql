CREATE TABLE `codemode_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codemode_secrets_key_unique` ON `codemode_secrets` (`key`);--> statement-breakpoint
CREATE INDEX `idx_codemode_secrets_created_at` ON `codemode_secrets` (`created_at`);