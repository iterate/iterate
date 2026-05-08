select id, slug, custom_hostname, metadata, created_at, updated_at
from projects
order by created_at desc
limit :limit
offset :offset;
