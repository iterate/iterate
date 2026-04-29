CREATE TABLE `things` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `things_created_at_idx` ON `things` (`created_at`);