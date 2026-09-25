import type {Client} from 'sqlfu';

const integrationRouteSql = `
select project_id as projectId, path
from integration_routes
where provider = ? and external_id = ?;
`.trim();
const integrationRouteQuery = (params: integrationRoute.Params) => ({
	name: "integrationRoute",
	sql: integrationRouteSql,
	args: [params.provider, params.externalId],
});

export const integrationRoute = Object.assign(
	async function integrationRoute(client: Client, params: integrationRoute.Params): Promise<integrationRoute.Result | null> {
		const rows = await client.all<integrationRoute.Result>(integrationRouteQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: integrationRouteSql, query: integrationRouteQuery },
);

export namespace integrationRoute {
	export type Params = {
		provider: string;
		externalId: string;
	};
	export type Result = {
		projectId: string;
		path: string;
	};
}

const routeIntegrationSql = `
insert into integration_routes (provider, external_id, project_id, path)
select ?, ?, p.id, ?
from projects p
where p.id = ?
on conflict (provider, external_id) do nothing;
`.trim();
const routeIntegrationQuery = (params: routeIntegration.Params) => ({
	name: "routeIntegration",
	sql: routeIntegrationSql,
	args: [params.provider, params.externalId, params.path, params.projectId],
});

export const routeIntegration = Object.assign(
	async function routeIntegration(client: Client, params: routeIntegration.Params) {
		return client.run(routeIntegrationQuery(params));
	},
	{ sql: routeIntegrationSql, query: routeIntegrationQuery },
);

export namespace routeIntegration {
	export type Params = {
		provider: string;
		externalId: string;
		path: string;
		projectId: string;
	};
}

const releaseOtherIntegrationRoutesSql = `
delete from integration_routes
where exists (
  select 1
  from integration_routes held
  where held.provider = ?
    and held.external_id = ?
    and held.project_id = ?
    and held.path = ?
    and held.project_id = integration_routes.project_id
    and held.path = integration_routes.path
    and (
      held.provider <> integration_routes.provider
      or held.external_id <> integration_routes.external_id
    )
);
`.trim();
const releaseOtherIntegrationRoutesQuery = (params: releaseOtherIntegrationRoutes.Params) => ({
	name: "releaseOtherIntegrationRoutes",
	sql: releaseOtherIntegrationRoutesSql,
	args: [params.provider, params.externalId, params.projectId, params.path],
});

export const releaseOtherIntegrationRoutes = Object.assign(
	async function releaseOtherIntegrationRoutes(client: Client, params: releaseOtherIntegrationRoutes.Params) {
		return client.run(releaseOtherIntegrationRoutesQuery(params));
	},
	{ sql: releaseOtherIntegrationRoutesSql, query: releaseOtherIntegrationRoutesQuery },
);

export namespace releaseOtherIntegrationRoutes {
	export type Params = {
		provider: string;
		externalId: string;
		projectId: string;
		path: string;
	};
}

const releaseIntegrationRoutesSql = `
delete from integration_routes where project_id = ? and path = ?;
`.trim();
const releaseIntegrationRoutesQuery = (params: releaseIntegrationRoutes.Params) => ({
	name: "releaseIntegrationRoutes",
	sql: releaseIntegrationRoutesSql,
	args: [params.projectId, params.path],
});

export const releaseIntegrationRoutes = Object.assign(
	async function releaseIntegrationRoutes(client: Client, params: releaseIntegrationRoutes.Params) {
		return client.run(releaseIntegrationRoutesQuery(params));
	},
	{ sql: releaseIntegrationRoutesSql, query: releaseIntegrationRoutesQuery },
);

export namespace releaseIntegrationRoutes {
	export type Params = {
		projectId: string;
		path: string;
	};
}

const releaseRoutesOfDeletedProjectSql = `
delete from integration_routes
where project_id = ? and project_id not in (select id from projects);
`.trim();
const releaseRoutesOfDeletedProjectQuery = (params: releaseRoutesOfDeletedProject.Params) => ({
	name: "releaseRoutesOfDeletedProject",
	sql: releaseRoutesOfDeletedProjectSql,
	args: [params.projectId],
});

export const releaseRoutesOfDeletedProject = Object.assign(
	async function releaseRoutesOfDeletedProject(client: Client, params: releaseRoutesOfDeletedProject.Params) {
		return client.run(releaseRoutesOfDeletedProjectQuery(params));
	},
	{ sql: releaseRoutesOfDeletedProjectSql, query: releaseRoutesOfDeletedProjectQuery },
);

export namespace releaseRoutesOfDeletedProject {
	export type Params = {
		projectId: string;
	};
}
