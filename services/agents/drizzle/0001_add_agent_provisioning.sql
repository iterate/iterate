CREATE TABLE `agent_provisioning` (
	`agent_path` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_path` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_routes` (
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_path` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agent_routes`("source_kind", "source_id", "provider", "session_id", "stream_path", "created_at", "updated_at") SELECT "source_kind", "source_id", "provider", "session_id", "stream_path", "created_at", "updated_at" FROM `agent_routes`;--> statement-breakpoint
DROP TABLE `agent_routes`;--> statement-breakpoint
ALTER TABLE `__new_agent_routes` RENAME TO `agent_routes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;