ALTER TABLE `domains` ADD `purchased_at` integer;--> statement-breakpoint
ALTER TABLE `purchases` ADD `customer_email` text NOT NULL;--> statement-breakpoint
ALTER TABLE `purchases` ADD `payment_status` text NOT NULL;