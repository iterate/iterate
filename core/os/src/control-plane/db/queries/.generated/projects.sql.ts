import type {Client} from 'sqlfu';

const projectsByRefSql = `
select
  p.id,
  p.slug,
  p.org_id as orgId,
  (
    select h.hostname
    from project_primary_hostnames pp
    join project_hostnames h on h.hostname = pp.hostname and h.project_id = pp.project_id
    where pp.project_id = p.id
  ) as primaryHostname
from projects p
where p.id = ? or p.slug = ?;
`.trim();
const projectsByRefQuery = (params: projectsByRef.Params) => ({
	name: "projectsByRef",
	sql: projectsByRefSql,
	args: [params.id, params.slug],
});

export const projectsByRef = Object.assign(
	async function projectsByRef(client: Client, params: projectsByRef.Params): Promise<projectsByRef.Result[]> {
		return client.all<projectsByRef.Result>(projectsByRefQuery(params));
	},
	{ sql: projectsByRefSql, query: projectsByRefQuery },
);

export namespace projectsByRef {
	export type Params = {
		id: string;
		slug: string;
	};
	export type Result = {
		id: string;
		slug: string;
		orgId: string;
		primaryHostname?: string;
	};
}

const listProjectsSql = `
select id, slug, org_id as orgId from projects order by created_at, slug;
`.trim();
const listProjectsQuery = { name: "listProjects", sql: listProjectsSql, args: [] };

export const listProjects = Object.assign(
	async function listProjects(client: Client): Promise<listProjects.Result[]> {
		return client.all<listProjects.Result>(listProjectsQuery);
	},
	{ sql: listProjectsSql, query: listProjectsQuery },
);

export namespace listProjects {
	export type Result = {
		id: string;
		slug: string;
		orgId: string;
	};
}

const insertProjectSql = `
insert into projects (id, slug, org_id, created_at)
select ?, ?, o.id, ? from organizations o where o.id = ?
on conflict do nothing;
`.trim();
const insertProjectQuery = (params: insertProject.Params) => ({
	name: "insertProject",
	sql: insertProjectSql,
	args: [params.id, params.slug, params.createdAt, params.orgId],
});

export const insertProject = Object.assign(
	async function insertProject(client: Client, params: insertProject.Params) {
		return client.run(insertProjectQuery(params));
	},
	{ sql: insertProjectSql, query: insertProjectQuery },
);

export namespace insertProject {
	export type Params = {
		id: string;
		slug: string;
		createdAt: number;
		orgId: string;
	};
}

const insertMemberProjectSql = `
insert into projects (id, slug, org_id, created_at)
select ?, ?, m.org_id, ?
from memberships m
where m.org_id = ? and m.user_id = ?
on conflict do nothing;
`.trim();
const insertMemberProjectQuery = (params: insertMemberProject.Params) => ({
	name: "insertMemberProject",
	sql: insertMemberProjectSql,
	args: [params.id, params.slug, params.createdAt, params.orgId, params.userId],
});

export const insertMemberProject = Object.assign(
	async function insertMemberProject(client: Client, params: insertMemberProject.Params) {
		return client.run(insertMemberProjectQuery(params));
	},
	{ sql: insertMemberProjectSql, query: insertMemberProjectQuery },
);

export namespace insertMemberProject {
	export type Params = {
		id: string;
		slug: string;
		createdAt: number;
		orgId: string;
		userId: string;
	};
}

const insertAdminOrganizationSql = `
insert into organizations (id, name, created_at)
select ?, 'admin', ?
where not exists (select 1 from projects p where p.slug = ? or p.id = ?)
on conflict (id) do nothing;
`.trim();
const insertAdminOrganizationQuery = (params: insertAdminOrganization.Params) => ({
	name: "insertAdminOrganization",
	sql: insertAdminOrganizationSql,
	args: [params.orgId, params.createdAt, params.slug, params.projectId],
});

export const insertAdminOrganization = Object.assign(
	async function insertAdminOrganization(client: Client, params: insertAdminOrganization.Params) {
		return client.run(insertAdminOrganizationQuery(params));
	},
	{ sql: insertAdminOrganizationSql, query: insertAdminOrganizationQuery },
);

export namespace insertAdminOrganization {
	export type Params = {
		orgId: string;
		createdAt: number;
		slug: string;
		projectId: string;
	};
}

const insertPersonalOrganizationSql = `
insert into organizations (id, name, created_at)
select ?, ?, ?
from users u
where u.id = ?
  and not exists (select 1 from memberships m where m.user_id = u.id)
  and not exists (select 1 from projects p where p.slug = ?);
`.trim();
const insertPersonalOrganizationQuery = (params: insertPersonalOrganization.Params) => ({
	name: "insertPersonalOrganization",
	sql: insertPersonalOrganizationSql,
	args: [params.id, params.name, params.createdAt, params.userId, params.slug],
});

export const insertPersonalOrganization = Object.assign(
	async function insertPersonalOrganization(client: Client, params: insertPersonalOrganization.Params) {
		return client.run(insertPersonalOrganizationQuery(params));
	},
	{ sql: insertPersonalOrganizationSql, query: insertPersonalOrganizationQuery },
);

export namespace insertPersonalOrganization {
	export type Params = {
		id: string;
		name: string;
		createdAt: number;
		userId: string;
		slug: string;
	};
}

const insertFirstOrganizationProjectSql = `
insert into projects (id, slug, org_id, created_at)
select ?, ?, m.org_id, ?
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = ?
order by o.created_at, o.name, o.id
limit 1
on conflict do nothing;
`.trim();
const insertFirstOrganizationProjectQuery = (params: insertFirstOrganizationProject.Params) => ({
	name: "insertFirstOrganizationProject",
	sql: insertFirstOrganizationProjectSql,
	args: [params.id, params.slug, params.createdAt, params.userId],
});

export const insertFirstOrganizationProject = Object.assign(
	async function insertFirstOrganizationProject(client: Client, params: insertFirstOrganizationProject.Params) {
		return client.run(insertFirstOrganizationProjectQuery(params));
	},
	{ sql: insertFirstOrganizationProjectSql, query: insertFirstOrganizationProjectQuery },
);

export namespace insertFirstOrganizationProject {
	export type Params = {
		id: string;
		slug: string;
		createdAt: number;
		userId: string;
	};
}

const firstOrganizationOfSql = `
select o.id
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = ?
order by o.created_at, o.name, o.id
limit 1;
`.trim();
const firstOrganizationOfQuery = (params: firstOrganizationOf.Params) => ({
	name: "firstOrganizationOf",
	sql: firstOrganizationOfSql,
	args: [params.userId],
});

export const firstOrganizationOf = Object.assign(
	async function firstOrganizationOf(client: Client, params: firstOrganizationOf.Params): Promise<firstOrganizationOf.Result | null> {
		const rows = await client.all<firstOrganizationOf.Result>(firstOrganizationOfQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: firstOrganizationOfSql, query: firstOrganizationOfQuery },
);

export namespace firstOrganizationOf {
	export type Params = {
		userId: string;
	};
	export type Result = {
		id: string;
	};
}

const deleteProjectSql = `
delete from projects
where id = ?
  and (? = 1 or exists (
    select 1 from memberships a
    where a.org_id = projects.org_id and a.user_id = ? and a.role = 'owner'
  ));
`.trim();
const deleteProjectQuery = (params: deleteProject.Params) => ({
	name: "deleteProject",
	sql: deleteProjectSql,
	args: [params.id, params.asOperator, params.actorId],
});

export const deleteProject = Object.assign(
	async function deleteProject(client: Client, params: deleteProject.Params) {
		return client.run(deleteProjectQuery(params));
	},
	{ sql: deleteProjectSql, query: deleteProjectQuery },
);

export namespace deleteProject {
	export type Params = {
		id: string;
		asOperator: number;
		actorId: string;
	};
}

const insertDeletedProjectSql = `
insert into deleted_projects (id)
select d.id from (select ? as id) d
where not exists (select 1 from projects p where p.id = d.id)
on conflict (id) do nothing;
`.trim();
const insertDeletedProjectQuery = (params: insertDeletedProject.Params) => ({
	name: "insertDeletedProject",
	sql: insertDeletedProjectSql,
	args: [params.id],
});

export const insertDeletedProject = Object.assign(
	async function insertDeletedProject(client: Client, params: insertDeletedProject.Params) {
		return client.run(insertDeletedProjectQuery(params));
	},
	{ sql: insertDeletedProjectSql, query: insertDeletedProjectQuery },
);

export namespace insertDeletedProject {
	export type Params = {
		id: string;
	};
}

const deletedProjectSql = `
select d.id
from deleted_projects d
where d.id = ? and not exists (select 1 from projects p where p.id = d.id);
`.trim();
const deletedProjectQuery = (params: deletedProject.Params) => ({
	name: "deletedProject",
	sql: deletedProjectSql,
	args: [params.id],
});

export const deletedProject = Object.assign(
	async function deletedProject(client: Client, params: deletedProject.Params): Promise<deletedProject.Result | null> {
		const rows = await client.all<deletedProject.Result>(deletedProjectQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: deletedProjectSql, query: deletedProjectQuery },
);

export namespace deletedProject {
	export type Params = {
		id: string;
	};
	export type Result = {
		id: string;
	};
}
