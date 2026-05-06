select pp.id, pp.project_id, pp.name, pp.description, pp.events_json, pp.created_at, pp.updated_at
from project_presets pp
where pp.project_id = :projectId
order by pp.created_at desc;
