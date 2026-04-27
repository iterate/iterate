select id, thing, created_at, updated_at
from things
where id = :id
limit 1;
