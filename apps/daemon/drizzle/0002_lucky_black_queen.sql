CREATE TABLE `agent_slack_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`channel` text NOT NULL,
	`thread_ts` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_channel_thread` ON `agent_slack_threads` (`channel`,`thread_ts`);