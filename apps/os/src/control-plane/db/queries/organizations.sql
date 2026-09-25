/** @name organizationById */
select o.id, o.name, coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from organizations o
where o.id = :id;

/** @name listOrganizations */
select o.id, o.name, coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from organizations o
order by o.name, o.id;

/** @name organizationRole */
select
  o.id,
  (select m.role from memberships m where m.org_id = o.id and m.user_id = :userId) as role,
  coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from organizations o
where o.id = :orgId;

/** @name listMembers */
select m.user_id as userId, u.email, m.role
from memberships m
join users u on u.id = m.user_id
where m.org_id = :orgId
order by u.email;

/** @name memberOf */
select u.id, (select m.role from memberships m where m.org_id = :orgId and m.user_id = u.id) as role
from users u
where u.id = :userId or u.email = :email
limit 1;

/** @name accessibleOrganizations */
select o.id, o.name, m.role, coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = :userId
order by o.name, o.id;

/** @name accessibleProjects */
select p.id, p.slug, p.org_id as orgId, m.role
from projects p
join memberships m on m.org_id = p.org_id
where m.user_id = :userId
order by p.slug;

/** @name insertOrganization */
insert into organizations (id, name) values (:id, :name);

/** @name insertOwner */
insert into memberships (org_id, user_id, role)
select o.id, :userId, 'owner' from organizations o where o.id = :orgId;

/** @name renameOrganization */
update organizations set name = :name
where id = :id
  and (:asOperator = 1 or exists (
    select 1 from memberships a
    where a.org_id = organizations.id and a.user_id = :actorId and a.role = 'owner'
  ));

/** @name deleteOrganization */
delete from organizations
where id = :id
  and not exists (select 1 from projects p where p.org_id = organizations.id)
  and (:asOperator = 1 or exists (
    select 1 from memberships a
    where a.org_id = organizations.id and a.user_id = :actorId and a.role = 'owner'
  ));

/** @name upsertMembership */
insert into memberships (org_id, user_id, role)
select o.id, u.id, :role
from organizations o, users u
where o.id = :orgId
  and (u.id = :userId or u.email = :email)
  and (:asOperator = 1 or exists (
    select 1 from memberships a
    where a.org_id = o.id and a.user_id = :actorId and a.role = 'owner'
  ))
on conflict (org_id, user_id) do update set role = excluded.role
where memberships.role <> 'owner'
  or excluded.role = 'owner'
  or (select count(*) from memberships c where c.org_id = memberships.org_id and c.role = 'owner') > 1;

/** @name deleteMembership */
delete from memberships
where org_id = :orgId
  and exists (
    select 1 from users u
    where u.id = memberships.user_id and (u.id = :userId or u.email = :email)
  )
  and (
    role <> 'owner'
    or (select count(*) from memberships c where c.org_id = memberships.org_id and c.role = 'owner') > 1
  )
  and (:asOperator = 1 or exists (
    select 1 from memberships a
    where a.org_id = memberships.org_id and a.user_id = :actorId and a.role = 'owner'
  ));
