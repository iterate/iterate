import type {Client} from 'sqlfu';

const projectsByRefSql = `
select id, slug, org_id as orgId from projects where id = ? or slug = ?;
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
	};
}

const listProjectsSql = `
select id, slug, org_id as orgId from projects order by slug;
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
insert into projects (id, slug, org_id)
select ?, ?, o.id from organizations o where o.id = ?
on conflict do nothing;
`.trim();
const insertProjectQuery = (params: insertProject.Params) => ({
	name: "insertProject",
	sql: insertProjectSql,
	args: [params.id, params.slug, params.orgId],
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
		orgId: string;
	};
}

const insertMemberProjectSql = `
insert into projects (id, slug, org_id)
select ?, ?, m.org_id from memberships m where m.org_id = ? and m.user_id = ?
on conflict do nothing;
`.trim();
const insertMemberProjectQuery = (params: insertMemberProject.Params) => ({
	name: "insertMemberProject",
	sql: insertMemberProjectSql,
	args: [params.id, params.slug, params.orgId, params.userId],
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
		orgId: string;
		userId: string;
	};
}

const insertAdminOrganizationSql = `
insert into organizations (id, name)
select ?, 'admin'
where not exists (select 1 from projects p where p.slug = ? or p.id = ?)
on conflict (id) do nothing;
`.trim();
const insertAdminOrganizationQuery = (params: insertAdminOrganization.Params) => ({
	name: "insertAdminOrganization",
	sql: insertAdminOrganizationSql,
	args: [params.orgId, params.slug, params.projectId],
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
		slug: string;
		projectId: string;
	};
}

const insertPersonalOrganizationSql = `
insert into organizations (id, name)
select ?, ?
from users u
where u.id = ?
  and not exists (select 1 from memberships m where m.user_id = u.id)
  and not exists (select 1 from projects p where p.slug = ?);
`.trim();
const insertPersonalOrganizationQuery = (params: insertPersonalOrganization.Params) => ({
	name: "insertPersonalOrganization",
	sql: insertPersonalOrganizationSql,
	args: [params.id, params.name, params.userId, params.slug],
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
		userId: string;
		slug: string;
	};
}

const insertFirstOrganizationProjectSql = `
insert into projects (id, slug, org_id)
select ?, ?, m.org_id
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = ?
order by o.name, o.id
limit 1
on conflict do nothing;
`.trim();
const insertFirstOrganizationProjectQuery = (params: insertFirstOrganizationProject.Params) => ({
	name: "insertFirstOrganizationProject",
	sql: insertFirstOrganizationProjectSql,
	args: [params.id, params.slug, params.userId],
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
		userId: string;
	};
}

const firstOrganizationOfSql = `
select o.id
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = ?
order by o.name, o.id
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
