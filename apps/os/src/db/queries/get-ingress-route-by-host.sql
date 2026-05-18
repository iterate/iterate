select id, host, project_id, priority, notes, callable_json, created_at, updated_at
from ingress_routes
where host = :host
order by priority desc, created_at asc
limit 1;
