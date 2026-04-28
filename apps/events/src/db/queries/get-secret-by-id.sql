select id
from secrets
where id = :id and project_slug = :projectSlug
limit 1;
