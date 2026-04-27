select id, slug, metadata, created_at, updated_at
from projects
where id = :id
limit 1;
