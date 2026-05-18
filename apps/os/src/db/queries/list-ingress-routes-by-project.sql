select id, host, project_id, priority, notes, callable_json, created_at, updated_at
from ingress_routes
where project_id = :projectId
order by priority desc, host asc;
