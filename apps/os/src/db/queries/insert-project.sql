insert into projects (id, slug)
values (:id, :slug)
returning id, slug, custom_hostname, created_at, updated_at;
