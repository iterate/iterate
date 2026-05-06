select id
from secrets
where id = :id and project_id = :projectId
limit 1;
