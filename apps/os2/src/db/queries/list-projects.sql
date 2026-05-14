select distinct p.id, p.slug, p.custom_hostname, p.external_egress_proxy, p.metadata, p.created_at, p.updated_at
from projects p
join project_permissions pp on pp.project_id = p.id
where pp.principal_type = :principalType
  and pp.principal_id = :principalId
order by p.created_at desc
limit :limit
offset :offset;
