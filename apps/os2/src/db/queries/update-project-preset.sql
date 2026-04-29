update project_presets
set name = :name,
    description = :description,
    events_json = :eventsJson,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
where id = :id
  and project_id = :projectId
  and exists (
    select 1
    from projects p
    where p.id = project_presets.project_id
      and p.clerk_org_id = :clerkOrgId
  );
