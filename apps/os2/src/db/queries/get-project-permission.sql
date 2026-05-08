select project_id, principal_type, principal_id, role, created_at, updated_at
from project_permissions
where project_id = :projectId
  and principal_type = :principalType
  and principal_id = :principalId
limit 1;
