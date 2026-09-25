/** @name projectsByHostnames */
select h.hostname, p.id, p.slug, p.org_id as orgId
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

/** @name primaryHostnameOf */
select h.hostname
from project_primary_hostnames p
join project_hostnames h on h.hostname = p.hostname and h.project_id = p.project_id
where p.project_id = :projectId
limit 1;
