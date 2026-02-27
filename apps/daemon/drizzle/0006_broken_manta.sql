CREATE TABLE `github_pr_agent_path` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`agent_path` text NOT NULL,
	`source` text DEFAULT 'deterministic' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()),
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_pr_agent_path_owner_repo_pr_number_unique` ON `github_pr_agent_path` (`owner`,`repo`,`pr_number`);--> statement-breakpoint
CREATE TABLE `github_webhook_state` (
	`agent_path` text PRIMARY KEY NOT NULL,
	`instructions_sent_at` integer,
	`last_event_hash` text,
	`last_event_at` integer,
	`last_seen_at` integer DEFAULT (unixepoch())
);
