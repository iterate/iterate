select id, slug, custom_hostname, created_at, updated_at
from projects
where slug = :slug
limit 1;
