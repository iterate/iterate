-- Migrate existing 'started' machines to 'active' before changing the constraint
UPDATE "machine" SET "state" = 'active' WHERE "state" = 'started';--> statement-breakpoint
DROP INDEX "machine_project_one_active";--> statement-breakpoint
ALTER TABLE "machine" ALTER COLUMN "state" SET DEFAULT 'starting';--> statement-breakpoint
CREATE UNIQUE INDEX "machine_project_one_active" ON "machine" USING btree ("project_id") WHERE state = 'active';