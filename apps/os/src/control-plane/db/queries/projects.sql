/** @name projectsByRef */
select id, slug, org_id as orgId from projects where id = :id or slug = :slug;

/** @name listProjects */
select id, slug, org_id as orgId from projects order by slug;

/** @name insertProject */
insert into projects (id, slug, org_id)
select :id, :slug, o.id from organizations o where o.id = :orgId
on conflict do nothing;

/** @name insertMemberProject */
insert into projects (id, slug, org_id)
select :id, :slug, m.org_id from memberships m where m.org_id = :orgId and m.user_id = :userId
on conflict do nothing;

/** @name insertAdminOrganization */
insert into organizations (id, name)
select :orgId, 'admin'
where not exists (select 1 from projects p where p.slug = :slug or p.id = :projectId)
on conflict (id) do nothing;

/** @name insertPersonalOrganization */
insert into organizations (id, name)
select :id, :name
from users u
where u.id = :userId
  and not exists (select 1 from memberships m where m.user_id = u.id)
  and not exists (select 1 from projects p where p.slug = :slug);

/** @name insertFirstOrganizationProject */
insert into projects (id, slug, org_id)
select :id, :slug, m.org_id
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = :userId
order by o.name, o.id
limit 1
on conflict do nothing;

/** @name firstOrganizationOf */
select o.id
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = :userId
order by o.name, o.id
limit 1;

/** @name deleteProject */
delete from projects
where id = :id
  and (:asOperator = 1 or exists (
    select 1 from memberships a
    where a.org_id = projects.org_id and a.user_id = :actorId and a.role = 'owner'
  ));
