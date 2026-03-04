CREATE TABLE IF NOT EXISTS `slack_thread_subscription` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`thread_ts` text NOT NULL,
	`agent_path` text NOT NULL,
	`source` text DEFAULT 'manual-tool' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `slack_thread_subscription_channel_thread_unique` ON `slack_thread_subscription` (`channel`,`thread_ts`);
