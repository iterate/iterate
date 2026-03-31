CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routes` (
	`host` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`caddy_directives_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL
);
