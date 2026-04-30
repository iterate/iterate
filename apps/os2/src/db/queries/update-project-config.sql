update projects
set custom_hostname = :customHostname,
    metadata = :metadata,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
where id = :id
  and clerk_org_id = :clerkOrgId;
