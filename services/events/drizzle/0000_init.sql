CREATE TABLE IF NOT EXISTS `events` (
	`path` text NOT NULL,
	`offset` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`version` text DEFAULT '1' NOT NULL,
	`created_at` text NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	PRIMARY KEY(`path`, `offset`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_path_offset` ON `events` (`path`, `offset`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `event_streams` (
	`path` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`event_count` integer NOT NULL,
	`last_event_created_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_streams_last_event_created_at` ON `event_streams` (`last_event_created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `event_stream_subscriptions` (
	`event_stream_path` text NOT NULL,
	`subscription_slug` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_delivered_offset` text,
	`subscription_json` text NOT NULL,
	PRIMARY KEY(`event_stream_path`, `subscription_slug`),
	FOREIGN KEY (`event_stream_path`) REFERENCES `event_streams`(`path`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_stream_subscriptions_path` ON `event_stream_subscriptions` (`event_stream_path`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_stream_subscriptions_type` ON `event_stream_subscriptions` (`type`);
--> statement-breakpoint
UPDATE `event_streams` SET `metadata` = '{}' WHERE `metadata` IS NULL;
