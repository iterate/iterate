insert into project_permissions (project_id, principal_type, principal_id, role)
values (:projectId, :principalType, :principalId, :role)
on conflict(project_id, principal_type, principal_id) do update set
  role = excluded.role,
  updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
returning project_id, principal_type, principal_id, role, created_at, updated_at;
