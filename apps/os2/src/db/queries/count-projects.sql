select count(distinct p.id) as total
from projects p
join project_permissions pp on pp.project_id = p.id
where pp.principal_type = :principalType
  and pp.principal_id = :principalId;
