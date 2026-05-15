insert into projects (id, slug)
values (:id, :slug)
returning id, slug, custom_hostname, external_egress_proxy_url, created_at, updated_at;
