CREATE TABLE "agent_durable_object_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"routing_key" text NOT NULL,
	"agent_durable_object_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_durable_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"estate_id" text NOT NULL,
	"class_name" text NOT NULL,
	"durable_object_name" text NOT NULL,
	"durable_object_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_durable_object_routes_routing_key_agent_durable_object_id_index" ON "agent_durable_object_routes" USING btree ("routing_key","agent_durable_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_durable_objects_durable_object_name_index" ON "agent_durable_objects" USING btree ("durable_object_name");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_durable_objects_durable_object_id_index" ON "agent_durable_objects" USING btree ("durable_object_id");--> statement-breakpoint
CREATE INDEX "agent_durable_objects_estate_id_index" ON "agent_durable_objects" USING btree ("estate_id");--> statement-breakpoint
CREATE INDEX "agent_durable_objects_class_name_index" ON "agent_durable_objects" USING btree ("class_name");