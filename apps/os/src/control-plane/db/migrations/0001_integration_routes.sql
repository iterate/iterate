-- THE INTEGRATION ROUTES: where a webhook the platform's own app at a provider receives goes
-- (src/integrations/). An account there (a Slack team, a GitHub installation) is ONE connection's,
-- the log at `path` in `project_id`; a connection holds one account (catalog.ts `routeIntegration`).
create table integration_routes (
  provider text not null,
  external_id text not null,
  project_id text not null,
  path text not null,
  primary key (provider, external_id)
);
create index integration_routes_connection on integration_routes (project_id, path);
