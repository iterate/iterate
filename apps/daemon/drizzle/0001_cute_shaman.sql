CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`external_id` text,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch())
);
