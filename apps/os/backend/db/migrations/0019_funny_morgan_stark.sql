DROP INDEX "agent_instance_durable_object_name_index";--> statement-breakpoint
ALTER TABLE "estate" ADD COLUMN "onboarding_agent_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instance_estate_id_durable_object_name_index" ON "agent_instance" USING btree ("estate_id","durable_object_name");