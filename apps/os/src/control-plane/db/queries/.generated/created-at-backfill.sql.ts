import type {Client} from 'sqlfu';

const undatedOrganizationsSql = `
select id from organizations where created_at is null order by id;
`.trim();
const undatedOrganizationsQuery = {
	name: "undatedOrganizations",
	sql: undatedOrganizationsSql,
	args: [],
};

export const undatedOrganizations = Object.assign(
	async function undatedOrganizations(client: Client): Promise<undatedOrganizations.Result[]> {
		return client.all<undatedOrganizations.Result>(undatedOrganizationsQuery);
	},
	{ sql: undatedOrganizationsSql, query: undatedOrganizationsQuery },
);

export namespace undatedOrganizations {
	export type Result = {
		id: string;
	};
}

const undatedMembershipsSql = `
select org_id as orgId, user_id as userId
from memberships
where created_at is null
order by org_id, user_id;
`.trim();
const undatedMembershipsQuery = {
	name: "undatedMemberships",
	sql: undatedMembershipsSql,
	args: [],
};

export const undatedMemberships = Object.assign(
	async function undatedMemberships(client: Client): Promise<undatedMemberships.Result[]> {
		return client.all<undatedMemberships.Result>(undatedMembershipsQuery);
	},
	{ sql: undatedMembershipsSql, query: undatedMembershipsQuery },
);

export namespace undatedMemberships {
	export type Result = {
		orgId: string;
		userId: string;
	};
}

const undatedProjectsSql = `
select id, org_id as orgId from projects where created_at is null order by id;
`.trim();
const undatedProjectsQuery = { name: "undatedProjects", sql: undatedProjectsSql, args: [] };

export const undatedProjects = Object.assign(
	async function undatedProjects(client: Client): Promise<undatedProjects.Result[]> {
		return client.all<undatedProjects.Result>(undatedProjectsQuery);
	},
	{ sql: undatedProjectsSql, query: undatedProjectsQuery },
);

export namespace undatedProjects {
	export type Result = {
		id: string;
		orgId: string;
	};
}

const dateOrganizationSql = `
update organizations set created_at = ? where id = ? and created_at is null;
`.trim();
const dateOrganizationQuery = (data: dateOrganization.Data, params: dateOrganization.Params) => ({
	name: "dateOrganization",
	sql: dateOrganizationSql,
	args: [data.createdAt, params.id],
});

export const dateOrganization = Object.assign(
	async function dateOrganization(client: Client, data: dateOrganization.Data, params: dateOrganization.Params) {
		return client.run(dateOrganizationQuery(data, params));
	},
	{ sql: dateOrganizationSql, query: dateOrganizationQuery },
);

export namespace dateOrganization {
	export type Data = {
		createdAt: number | null;
	};
	export type Params = {
		id: string;
	};
}

const dateMembershipSql = `
update memberships set created_at = ?
where org_id = ? and user_id = ? and created_at is null;
`.trim();
const dateMembershipQuery = (data: dateMembership.Data, params: dateMembership.Params) => ({
	name: "dateMembership",
	sql: dateMembershipSql,
	args: [data.createdAt, params.orgId, params.userId],
});

export const dateMembership = Object.assign(
	async function dateMembership(client: Client, data: dateMembership.Data, params: dateMembership.Params) {
		return client.run(dateMembershipQuery(data, params));
	},
	{ sql: dateMembershipSql, query: dateMembershipQuery },
);

export namespace dateMembership {
	export type Data = {
		createdAt: number | null;
	};
	export type Params = {
		orgId: string;
		userId: string;
	};
}

const dateProjectSql = `
update projects set created_at = ? where id = ? and created_at is null;
`.trim();
const dateProjectQuery = (data: dateProject.Data, params: dateProject.Params) => ({
	name: "dateProject",
	sql: dateProjectSql,
	args: [data.createdAt, params.id],
});

export const dateProject = Object.assign(
	async function dateProject(client: Client, data: dateProject.Data, params: dateProject.Params) {
		return client.run(dateProjectQuery(data, params));
	},
	{ sql: dateProjectSql, query: dateProjectQuery },
);

export namespace dateProject {
	export type Data = {
		createdAt: number | null;
	};
	export type Params = {
		id: string;
	};
}
