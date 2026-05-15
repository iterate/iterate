select id, slug, custom_hostname, external_egress_proxy_url, created_at, updated_at
from projects
where custom_hostname = :customHostname
limit 1;
