CREATE TABLE `agent_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_path` text NOT NULL,
	`callback_url` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`agent_path`) REFERENCES `agents`(`path`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_subscriptions_agent_path_callback_url_unique` ON `agent_subscriptions` (`agent_path`,`callback_url`);--> statement-breakpoint
ALTER TABLE `agents` ADD `short_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `is_working` integer DEFAULT false NOT NULL;