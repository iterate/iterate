CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_slug` text DEFAULT 'public' NOT NULL,
	`stream_path` text NOT NULL,
	`agent_instance` text NOT NULL,
	`public_base_url` text NOT NULL,
	`callback_url` text NOT NULL,
	`debug_url` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_project_slug_stream_path_unique` ON `agents` (`project_slug`,`stream_path`);--> statement-breakpoint
CREATE INDEX `idx_agents_created_at` ON `agents` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agents_updated_at` ON `agents` (`updated_at`);