insert into project_presets (id, project_id, name, description, events_json)
values (:id, :projectId, :name, :description, :eventsJson)
returning id, project_id, name, description, events_json, created_at, updated_at;
