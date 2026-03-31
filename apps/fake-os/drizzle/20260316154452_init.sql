CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`slug` text NOT NULL,
	`opts` text DEFAULT '{}' NOT NULL,
	`deployment_locator` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployments_slug_unique` ON `deployments` (`slug`);