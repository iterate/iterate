select id, project_id, journal_path
from itx_contexts
where id = :id
limit 1;
