insert into projects (id, slug, metadata)
values (:id, :slug, :metadata)
returning id, slug, metadata, created_at, updated_at;
