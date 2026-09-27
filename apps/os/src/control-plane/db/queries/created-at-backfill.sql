/** @name undatedOrganizations */
select id from organizations where created_at is null order by id;

/** @name undatedMemberships */
select org_id as orgId, user_id as userId
from memberships
where created_at is null
order by org_id, user_id;

/** @name undatedProjects */
select id, org_id as orgId from projects where created_at is null order by id;

/** @name dateOrganization */
update organizations set created_at = :createdAt where id = :id and created_at is null;

/** @name dateMembership */
update memberships set created_at = :createdAt
where org_id = :orgId and user_id = :userId and created_at is null;

/** @name dateProject */
update projects set created_at = :createdAt where id = :id and created_at is null;
