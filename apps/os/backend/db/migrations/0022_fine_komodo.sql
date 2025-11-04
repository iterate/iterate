ALTER TABLE "agent_instance_route" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_instance_route" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD COLUMN "routing_key" text;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_routingKey_unique" UNIQUE("routing_key");