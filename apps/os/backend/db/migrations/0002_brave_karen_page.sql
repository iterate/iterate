ALTER TABLE "event" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "project_connection" ADD COLUMN "webhook_target_machine_id" text;--> statement-breakpoint
ALTER TABLE "project_connection" ADD CONSTRAINT "project_connection_webhook_target_machine_id_machine_id_fk" FOREIGN KEY ("webhook_target_machine_id") REFERENCES "public"."machine"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_connection_webhook_target_machine" ON "project_connection" USING btree ("webhook_target_machine_id");