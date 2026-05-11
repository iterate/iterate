CREATE TABLE `things` (
	`id` text PRIMARY KEY NOT NULL,
	`thing` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_things_created_at` ON `things` (`created_at`);