update projects
set custom_hostname = :customHostname,
    external_egress_proxy = :externalEgressProxy,
    metadata = :metadata,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
where id = :id;
