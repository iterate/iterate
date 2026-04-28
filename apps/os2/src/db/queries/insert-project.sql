insert into projects (id, slug, metadata)
values (:id, :slug, :metadata)
returning id, slug, custom_hostname, metadata, created_at, updated_at;
