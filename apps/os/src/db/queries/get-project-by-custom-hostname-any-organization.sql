select id, slug, custom_hostname, created_at, updated_at
from projects
where custom_hostname = :customHostname
limit 1;
