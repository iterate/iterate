insert into projects (id, slug, clerk_org_id, created_by_clerk_user_id, metadata)
values (:id, :slug, :clerkOrgId, :createdByClerkUserId, :metadata)
returning id, slug, clerk_org_id, created_by_clerk_user_id, custom_hostname, metadata, created_at, updated_at;
