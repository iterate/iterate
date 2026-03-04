CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`harness_type` text NOT NULL,
	`harness_session_id` text,
	`tmux_session` text,
	`working_directory` text NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`initial_prompt` text,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`slug`);