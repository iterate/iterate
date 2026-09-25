import type {Client} from 'sqlfu';

const organizationByIdSql = `
select o.id, o.name, coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from organizations o
where o.id = ?;
`.trim();
const organizationByIdQuery = (params: organizationById.Params) => ({
	name: "organizationById",
	sql: organizationByIdSql,
	args: [params.id],
});

export const organizationById = Object.assign(
	async function organizationById(client: Client, params: organizationById.Params): Promise<organizationById.Result | null> {
		const rows = await client.all<organizationById.Result>(organizationByIdQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: organizationByIdSql, query: organizationByIdQuery },
);

export namespace organizationById {
	export type Params = {
		id: string;
	};
	export type Result = {
		id: string;
		name: string;
		projects: number;
	};
}

const listOrganizationsSql = `
select o.id, o.name, coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from organizations o
order by o.name, o.id;
`.trim();
const listOrganizationsQuery = { name: "listOrganizations", sql: listOrganizationsSql, args: [] };

export const listOrganizations = Object.assign(
	async function listOrganizations(client: Client): Promise<listOrganizations.Result[]> {
		return client.all<listOrganizations.Result>(listOrganizationsQuery);
	},
	{ sql: listOrganizationsSql, query: listOrganizationsQuery },
);

export namespace listOrganizations {
	export type Result = {
		id: string;
		name: string;
		projects: number;
	};
}

const organizationRoleSql = `
select
  o.id,
  (select m.role from memberships m where m.org_id = o.id and m.user_id = ?) as role,
  coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from organizations o
where o.id = ?;
`.trim();
const organizationRoleQuery = (params: organizationRole.Params) => ({
	name: "organizationRole",
	sql: organizationRoleSql,
	args: [params.userId, params.orgId],
});

export const organizationRole = Object.assign(
	async function organizationRole(client: Client, params: organizationRole.Params): Promise<organizationRole.Result | null> {
		const rows = await client.all<organizationRole.Result>(organizationRoleQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: organizationRoleSql, query: organizationRoleQuery },
);

export namespace organizationRole {
	export type Params = {
		userId: string;
		orgId: string;
	};
	export type Result = {
		id: string;
		role?: ('owner' | 'member');
		projects: number;
	};
}

const listMembersSql = `
select m.user_id as userId, u.email, m.role
from memberships m
join users u on u.id = m.user_id
where m.org_id = ?
order by u.email;
`.trim();
const listMembersQuery = (params: listMembers.Params) => ({
	name: "listMembers",
	sql: listMembersSql,
	args: [params.orgId],
});

export const listMembers = Object.assign(
	async function listMembers(client: Client, params: listMembers.Params): Promise<listMembers.Result[]> {
		return client.all<listMembers.Result>(listMembersQuery(params));
	},
	{ sql: listMembersSql, query: listMembersQuery },
);

export namespace listMembers {
	export type Params = {
		orgId: string;
	};
	export type Result = {
		userId: string;
		email: string;
		role: ('owner' | 'member');
	};
}

const memberOfSql = `
select u.id, (select m.role from memberships m where m.org_id = ? and m.user_id = u.id) as role
from users u
where u.id = ? or u.email = ?
limit 1;
`.trim();
const memberOfQuery = (params: memberOf.Params) => ({
	name: "memberOf",
	sql: memberOfSql,
	args: [params.orgId, params.userId, params.email],
});

export const memberOf = Object.assign(
	async function memberOf(client: Client, params: memberOf.Params): Promise<memberOf.Result | null> {
		const rows = await client.all<memberOf.Result>(memberOfQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: memberOfSql, query: memberOfQuery },
);

export namespace memberOf {
	export type Params = {
		orgId: string;
		userId: string;
		email: string;
	};
	export type Result = {
		id: string;
		role?: ('owner' | 'member');
	};
}

const accessibleOrganizationsSql = `
select o.id, o.name, m.role, coalesce((select count(*) from projects p where p.org_id = o.id), 0) as projects
from memberships m
join organizations o on o.id = m.org_id
where m.user_id = ?
order by o.name, o.id;
`.trim();
const accessibleOrganizationsQuery = (params: accessibleOrganizations.Params) => ({
	name: "accessibleOrganizations",
	sql: accessibleOrganizationsSql,
	args: [params.userId],
});

export const accessibleOrganizations = Object.assign(
	async function accessibleOrganizations(client: Client, params: accessibleOrganizations.Params): Promise<accessibleOrganizations.Result[]> {
		return client.all<accessibleOrganizations.Result>(accessibleOrganizationsQuery(params));
	},
	{ sql: accessibleOrganizationsSql, query: accessibleOrganizationsQuery },
);

export namespace accessibleOrganizations {
	export type Params = {
		userId: string;
	};
	export type Result = {
		id: string;
		name: string;
		role: ('owner' | 'member');
		projects: number;
	};
}

const accessibleProjectsSql = `
select p.id, p.slug, p.org_id as orgId, m.role
from projects p
join memberships m on m.org_id = p.org_id
where m.user_id = ?
order by p.slug;
`.trim();
const accessibleProjectsQuery = (params: accessibleProjects.Params) => ({
	name: "accessibleProjects",
	sql: accessibleProjectsSql,
	args: [params.userId],
});

export const accessibleProjects = Object.assign(
	async function accessibleProjects(client: Client, params: accessibleProjects.Params): Promise<accessibleProjects.Result[]> {
		return client.all<accessibleProjects.Result>(accessibleProjectsQuery(params));
	},
	{ sql: accessibleProjectsSql, query: accessibleProjectsQuery },
);

export namespace accessibleProjects {
	export type Params = {
		userId: string;
	};
	export type Result = {
		id: string;
		slug: string;
		orgId: string;
		role: ('owner' | 'member');
	};
}

const insertOrganizationSql = `
insert into organizations (id, name) values (?, ?);
`.trim();
const insertOrganizationQuery = (params: insertOrganization.Params) => ({
	name: "insertOrganization",
	sql: insertOrganizationSql,
	args: [params.id, params.name],
});

export const insertOrganization = Object.assign(
	async function insertOrganization(client: Client, params: insertOrganization.Params) {
		return client.run(insertOrganizationQuery(params));
	},
	{ sql: insertOrganizationSql, query: insertOrganizationQuery },
);

export namespace insertOrganization {
	export type Params = {
		id: string;
		name: string;
	};
}

const insertOwnerSql = `
insert into memberships (org_id, user_id, role)
select o.id, ?, 'owner' from organizations o where o.id = ?;
`.trim();
const insertOwnerQuery = (params: insertOwner.Params) => ({
	name: "insertOwner",
	sql: insertOwnerSql,
	args: [params.userId, params.orgId],
});

export const insertOwner = Object.assign(
	async function insertOwner(client: Client, params: insertOwner.Params) {
		return client.run(insertOwnerQuery(params));
	},
	{ sql: insertOwnerSql, query: insertOwnerQuery },
);

export namespace insertOwner {
	export type Params = {
		userId: string;
		orgId: string;
	};
}

const renameOrganizationSql = `
update organizations set name = ?
where id = ?
  and (? = 1 or exists (
    select 1 from memberships a
    where a.org_id = organizations.id and a.user_id = ? and a.role = 'owner'
  ));
`.trim();
const renameOrganizationQuery = (data: renameOrganization.Data, params: renameOrganization.Params) => ({
	name: "renameOrganization",
	sql: renameOrganizationSql,
	args: [data.name, params.id, params.asOperator, params.actorId],
});

export const renameOrganization = Object.assign(
	async function renameOrganization(client: Client, data: renameOrganization.Data, params: renameOrganization.Params) {
		return client.run(renameOrganizationQuery(data, params));
	},
	{ sql: renameOrganizationSql, query: renameOrganizationQuery },
);

export namespace renameOrganization {
	export type Data = {
		name: string;
	};
	export type Params = {
		id: string;
		asOperator: number;
		actorId: string;
	};
}

const deleteOrganizationSql = `
delete from organizations
where id = ?
  and not exists (select 1 from projects p where p.org_id = organizations.id)
  and (? = 1 or exists (
    select 1 from memberships a
    where a.org_id = organizations.id and a.user_id = ? and a.role = 'owner'
  ));
`.trim();
const deleteOrganizationQuery = (params: deleteOrganization.Params) => ({
	name: "deleteOrganization",
	sql: deleteOrganizationSql,
	args: [params.id, params.asOperator, params.actorId],
});

export const deleteOrganization = Object.assign(
	async function deleteOrganization(client: Client, params: deleteOrganization.Params) {
		return client.run(deleteOrganizationQuery(params));
	},
	{ sql: deleteOrganizationSql, query: deleteOrganizationQuery },
);

export namespace deleteOrganization {
	export type Params = {
		id: string;
		asOperator: number;
		actorId: string;
	};
}

const upsertMembershipSql = `
insert into memberships (org_id, user_id, role)
select o.id, u.id, ?
from organizations o, users u
where o.id = ?
  and (u.id = ? or u.email = ?)
  and (? = 1 or exists (
    select 1 from memberships a
    where a.org_id = o.id and a.user_id = ? and a.role = 'owner'
  ))
on conflict (org_id, user_id) do update set role = excluded.role
where memberships.role <> 'owner'
  or excluded.role = 'owner'
  or (select count(*) from memberships c where c.org_id = memberships.org_id and c.role = 'owner') > 1;
`.trim();
const upsertMembershipQuery = (params: upsertMembership.Params) => ({
	name: "upsertMembership",
	sql: upsertMembershipSql,
	args: [params.role, params.orgId, params.userId, params.email, params.asOperator, params.actorId],
});

export const upsertMembership = Object.assign(
	async function upsertMembership(client: Client, params: upsertMembership.Params) {
		return client.run(upsertMembershipQuery(params));
	},
	{ sql: upsertMembershipSql, query: upsertMembershipQuery },
);

export namespace upsertMembership {
	export type Params = {
		role: ('owner' | 'member');
		orgId: string;
		userId: string;
		email: string;
		asOperator: number;
		actorId: string;
	};
}

const deleteMembershipSql = `
delete from memberships
where org_id = ?
  and exists (
    select 1 from users u
    where u.id = memberships.user_id and (u.id = ? or u.email = ?)
  )
  and (
    role <> 'owner'
    or (select count(*) from memberships c where c.org_id = memberships.org_id and c.role = 'owner') > 1
  )
  and (? = 1 or exists (
    select 1 from memberships a
    where a.org_id = memberships.org_id and a.user_id = ? and a.role = 'owner'
  ));
`.trim();
const deleteMembershipQuery = (params: deleteMembership.Params) => ({
	name: "deleteMembership",
	sql: deleteMembershipSql,
	args: [params.orgId, params.userId, params.email, params.asOperator, params.actorId],
});

export const deleteMembership = Object.assign(
	async function deleteMembership(client: Client, params: deleteMembership.Params) {
		return client.run(deleteMembershipQuery(params));
	},
	{ sql: deleteMembershipSql, query: deleteMembershipQuery },
);

export namespace deleteMembership {
	export type Params = {
		orgId: string;
		userId: string;
		email: string;
		asOperator: number;
		actorId: string;
	};
}
