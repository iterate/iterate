ALTER TABLE "agent_instance" ADD COLUMN "routing_key" text;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_routingKey_unique" UNIQUE("routing_key");

with distinct_routes as (
  select distinct on (routing_key) agent_instance_id, routing_key
  from agent_instance_route
  order by routing_key, agent_instance_id
)
update agent_instance
set routing_key = distinct_routes.routing_key
from distinct_routes
where agent_instance.id = distinct_routes.agent_instance_id
  and agent_instance.routing_key is null;

with distinct_onboarding as (
  select distinct on (durable_object_name) id, durable_object_name
  from agent_instance
  where routing_key is null
    and durable_object_name like '%-Onboarding%'
  order by durable_object_name, id
)
update agent_instance
set routing_key = distinct_onboarding.durable_object_name
from distinct_onboarding
where agent_instance.id = distinct_onboarding.id;

ALTER TABLE "agent_instance_route" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_instance_route" CASCADE;--> statement-breakpoint
