select id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at
from projects
where custom_hostname = :customHostname
limit 1;
