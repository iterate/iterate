insert into projects (id, slug, metadata)
values (:id, :slug, :metadata)
returning id, slug, custom_hostname, external_egress_proxy, metadata, created_at, updated_at;
