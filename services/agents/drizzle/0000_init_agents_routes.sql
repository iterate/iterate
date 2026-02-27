CREATE TABLE IF NOT EXISTS `agent_routes` (
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_path` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`source_kind`, `source_id`)
);
