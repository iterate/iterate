ALTER TABLE `codemode_runs` ADD `runner_kind` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `codemode_runs` ADD `logs_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `codemode_runs` ADD `error` text;