-- (Archive older started machines, keeping only the newest one active)
UPDATE machine m
SET state = 'archived'
WHERE m.state = 'started'
  AND m.id != (
    SELECT m2.id
    FROM machine m2
    WHERE m2.project_id = m.project_id
      AND m2.state = 'started'
    ORDER BY m2.created_at DESC
    LIMIT 1
  ); --> statement-breakpoint

ALTER TABLE "project_connection" DROP CONSTRAINT "project_connection_webhook_target_machine_id_machine_id_fk";
--> statement-breakpoint
DROP INDEX "idx_project_connection_webhook_target_machine";--> statement-breakpoint
CREATE UNIQUE INDEX "machine_project_one_active" ON "machine" USING btree ("project_id") WHERE state != 'archived';--> statement-breakpoint
ALTER TABLE "project_connection" DROP COLUMN "webhook_target_machine_id";