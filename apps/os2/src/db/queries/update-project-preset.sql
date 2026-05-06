update project_presets
set name = :name,
    description = :description,
    events_json = :eventsJson,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
where id = :id
  and project_id = :projectId;
