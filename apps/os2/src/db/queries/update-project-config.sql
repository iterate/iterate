update projects
set custom_hostname = :customHostname,
    external_egress_proxy_url = :externalEgressProxyUrl,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
where id = :id;
