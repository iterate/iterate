select id, thing, created_at, updated_at
from things
order by created_at desc
limit :limit
offset :offset;
