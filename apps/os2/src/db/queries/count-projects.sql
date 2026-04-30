select count(*) as total
from projects
where clerk_org_id = :clerkOrgId;
