DROP TABLE IF EXISTS `agents`;
--> statement-breakpoint
CREATE TABLE `agents` (
	`path` text PRIMARY KEY NOT NULL,
	`working_directory` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `agent_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_path` text NOT NULL,
	`destination` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`agent_path`) REFERENCES `agents`(`path`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_routes_active_unique` ON `agent_routes` (`agent_path`) WHERE "agent_routes"."active" = 1;