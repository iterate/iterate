DROP TABLE IF EXISTS `agent_routes`;
DROP TABLE IF EXISTS `agents`;
CREATE TABLE `agents` (
	`path` text PRIMARY KEY NOT NULL,
	`working_directory` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	`archived_at` integer
);
CREATE TABLE `agent_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_path` text NOT NULL,
	`destination` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`agent_path`) REFERENCES `agents`(`path`)
);
CREATE UNIQUE INDEX `agent_routes_active_unique` ON `agent_routes` (`agent_path`) WHERE active = 1;
