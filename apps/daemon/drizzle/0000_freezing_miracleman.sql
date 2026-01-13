CREATE TABLE `sessions` (
	`slug` text PRIMARY KEY NOT NULL,
	`harness_type` text DEFAULT 'claude-code' NOT NULL,
	`working_directory` text,
	`status` text DEFAULT 'running' NOT NULL,
	`initial_prompt` text,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
