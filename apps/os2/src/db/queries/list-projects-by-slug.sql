select id, slug, custom_hostname, external_egress_proxy_url, metadata, created_at, updated_at
from projects
where slug = :slug
order by created_at asc
limit 2;
