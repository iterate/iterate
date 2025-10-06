CREATE TABLE `auth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`domain_id` text NOT NULL,
	`code` text NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`purchased` integer DEFAULT false NOT NULL,
	`name_with_tld` text NOT NULL,
	`amount_in_minor_units` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`tier` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`domain_id` text NOT NULL,
	`stripe_checkout_session_id` text NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE no action
);
