update projects
set custom_hostname = :customHostname,
    metadata = :metadata,
    updated_at = :updatedAt
where id = :id;
