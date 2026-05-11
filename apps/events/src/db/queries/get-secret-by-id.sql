select id
from secrets
where id = :id and namespace = :namespace
limit 1;
