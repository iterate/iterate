update projects
set custom_hostname = :customHostname,
    metadata = :metadata
where id = :id;
