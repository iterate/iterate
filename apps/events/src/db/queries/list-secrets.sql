select id, name, description, created_at, updated_at
from secrets
where project_slug = :projectSlug
order by created_at desc
limit :limit
offset :offset;
