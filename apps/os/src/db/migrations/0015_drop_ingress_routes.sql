-- Project platform hosts resolve dynamically from the projects table
-- (src/ingress/lookup.ts); the materialized route rows duplicated that with
-- stale copies and nothing else wrote to the table.
drop table ingress_routes;
