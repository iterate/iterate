ALTER TABLE "agent_instance" ADD COLUMN "routing_key" text;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_routingKey_unique" UNIQUE("routing_key");

update agent_instance
set routing_key = (select routing_key from agent_instance_route where agent_instance_route.agent_instance_id = agent_instance.id limit 1)
where routing_key is null;

ALTER TABLE "agent_instance_route" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_instance_route" CASCADE;--> statement-breakpoint
