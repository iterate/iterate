/** @name integrationRoute */
select project_id as projectId, path
from integration_routes
where provider = :provider and external_id = :externalId;

/** @name routeIntegration */
insert into integration_routes (provider, external_id, project_id, path)
select :provider, :externalId, p.id, :path
from projects p
where p.id = :projectId
on conflict (provider, external_id) do nothing;

/** @name releaseOtherIntegrationRoutes */
delete from integration_routes
where exists (
  select 1
  from integration_routes held
  where held.provider = :provider
    and held.external_id = :externalId
    and held.project_id = :projectId
    and held.path = :path
    and held.project_id = integration_routes.project_id
    and held.path = integration_routes.path
    and (
      held.provider <> integration_routes.provider
      or held.external_id <> integration_routes.external_id
    )
);

/** @name releaseIntegrationRoutes */
delete from integration_routes where project_id = :projectId and path = :path;

/** @name releaseRoutesOfDeletedProject */
delete from integration_routes
where project_id = :projectId and project_id not in (select id from projects);
