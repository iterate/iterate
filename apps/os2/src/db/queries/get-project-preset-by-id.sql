select pp.id, pp.project_id, pp.name, pp.description, pp.events_json, pp.created_at, pp.updated_at
from project_presets pp
join projects p on p.id = pp.project_id
where pp.id = :id
  and pp.project_id = :projectId
  and p.clerk_org_id = :clerkOrgId
limit 1;
