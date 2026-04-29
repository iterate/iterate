select id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at
from projects
where clerk_org_id = :clerkOrgId
order by created_at desc
limit :limit
offset :offset;
