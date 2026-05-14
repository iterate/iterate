select id, slug, custom_hostname, external_egress_proxy, metadata, created_at, updated_at
from projects
where id = :id
limit 1;
