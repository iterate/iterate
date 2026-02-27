ALTER TABLE `events` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_events_path_idempotency_unique` ON `events` (`path`,`idempotency_key`);
