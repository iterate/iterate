insert into ingress_routes (id, host, project_id, priority, notes, callable_json, updated_at)
values (:id, :host, :projectId, :priority, :notes, :callableJson, strftime('%Y-%m-%d %H:%M:%S', 'now'))
on conflict(host) do update set
  project_id = excluded.project_id,
  priority = excluded.priority,
  notes = excluded.notes,
  callable_json = excluded.callable_json,
  updated_at = excluded.updated_at
returning id, host, project_id, priority, notes, callable_json, created_at, updated_at;
