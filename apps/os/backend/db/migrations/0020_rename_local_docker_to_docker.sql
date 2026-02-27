UPDATE "machine"
SET "type" = 'docker'
WHERE "type" = 'local-docker';
--> statement-breakpoint
UPDATE "project"
SET "sandbox_provider" = 'docker'
WHERE "sandbox_provider" = 'local-docker';
