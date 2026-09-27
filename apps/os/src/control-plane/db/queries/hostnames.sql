/** @name projectsByHostnames */
select
  h.hostname,
  p.id,
  p.slug,
  p.org_id as orgId,
  (
    select ph.hostname
    from project_primary_hostnames pp
    join project_hostnames ph on ph.hostname = pp.hostname and ph.project_id = pp.project_id
    where pp.project_id = p.id
  ) as primaryHostname
from project_hostnames h
join projects p on p.id = h.project_id
where h.hostname in (:hostnames);

/** @name claimHostname */
insert into project_hostnames (hostname, project_id)
select :hostname, p.id
from projects p
where p.id = :projectId
  and not exists (
    select 1 from project_hostnames h
    where h.hostname in (:selfAndAbove) and h.project_id <> p.id
  )
on conflict (hostname) do nothing;

/** @name releaseHostname */
delete from project_hostnames where hostname = :hostname and project_id = :projectId;

/** @name setPrimaryHostname */
insert into project_primary_hostnames (project_id, hostname) values (:projectId, :hostname)
on conflict (project_id) do update set hostname = excluded.hostname;

/** @name clearPrimaryHostname */
delete from project_primary_hostnames where project_id = :projectId;
