delete from project_presets
where id = :id
  and project_id = :projectId
  and exists (
    select 1
    from projects p
    where p.id = project_presets.project_id
      and p.clerk_org_id = :clerkOrgId
  );
