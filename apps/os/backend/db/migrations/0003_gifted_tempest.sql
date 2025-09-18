ALTER TABLE "agent_durable_objects" RENAME TO "agent_instance";--> statement-breakpoint
ALTER TABLE "agent_durable_object_routes" RENAME TO "agent_instance_route";--> statement-breakpoint
ALTER TABLE "agent_instance_route" RENAME COLUMN "agent_durable_object_id" TO "agent_instance_id";--> statement-breakpoint
DROP INDEX "agent_durable_object_routes_routing_key_agent_durable_object_id_index";--> statement-breakpoint
DROP INDEX "agent_durable_objects_durable_object_name_index";--> statement-breakpoint
DROP INDEX "agent_durable_objects_durable_object_id_index";--> statement-breakpoint
DROP INDEX "agent_durable_objects_estate_id_index";--> statement-breakpoint
DROP INDEX "agent_durable_objects_class_name_index";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instance_route_routing_key_agent_instance_id_index" ON "agent_instance_route" USING btree ("routing_key","agent_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instance_durable_object_name_index" ON "agent_instance" USING btree ("durable_object_name");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instance_durable_object_id_index" ON "agent_instance" USING btree ("durable_object_id");--> statement-breakpoint
CREATE INDEX "agent_instance_estate_id_index" ON "agent_instance" USING btree ("estate_id");--> statement-breakpoint
CREATE INDEX "agent_instance_class_name_index" ON "agent_instance" USING btree ("class_name");