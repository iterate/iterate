select id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at
from projects
where id = :id
  and clerk_org_id = :clerkOrgId
limit 1;
