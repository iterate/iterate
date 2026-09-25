import type {Client} from 'sqlfu';

const projectsByHostnamesSql = `
select h.hostname, p.id, p.slug, p.org_id as orgId
from project_hostnames h
join projects p on p.id = h.project_id
where h.hostname in (?);
`.trim();
const projectsByHostnamesQuery = (params: projectsByHostnames.Params) => {
	if (params.hostnames.length === 0) {
		throw new Error("Parameter \"hostnames\" must be a non-empty array");
	}
	const expandedSql = `select h.hostname, p.id, p.slug, p.org_id as orgId
from project_hostnames h
join projects p on p.id = h.project_id
where h.hostname in (${params.hostnames.map(() => '?').join(', ')});`;
	return { name: "projectsByHostnames", sql: expandedSql, args: [...params.hostnames] };
};

export const projectsByHostnames = Object.assign(
	async function projectsByHostnames(client: Client, params: projectsByHostnames.Params): Promise<projectsByHostnames.Result[]> {
		return client.all<projectsByHostnames.Result>(projectsByHostnamesQuery(params));
	},
	{ sql: projectsByHostnamesSql, query: projectsByHostnamesQuery },
);

export namespace projectsByHostnames {
	export type Params = {
		hostnames: string[];
	};
	export type Result = {
		hostname: string;
		id: string;
		slug: string;
		orgId: string;
	};
}

const claimHostnameSql = `
insert into project_hostnames (hostname, project_id)
select ?, p.id
from projects p
where p.id = ?
  and not exists (
    select 1 from project_hostnames h
    where h.hostname in (?) and h.project_id <> p.id
  )
on conflict (hostname) do nothing;
`.trim();
const claimHostnameQuery = (params: claimHostname.Params) => {
	if (params.selfAndAbove.length === 0) {
		throw new Error("Parameter \"selfAndAbove\" must be a non-empty array");
	}
	const expandedSql = `insert into project_hostnames (hostname, project_id)
select ?, p.id
from projects p
where p.id = ?
  and not exists (
    select 1 from project_hostnames h
    where h.hostname in (${params.selfAndAbove.map(() => '?').join(', ')}) and h.project_id <> p.id
  )
on conflict (hostname) do nothing;`;
	return {
		name: "claimHostname",
		sql: expandedSql,
		args: [params.hostname, params.projectId, ...params.selfAndAbove],
	};
};

export const claimHostname = Object.assign(
	async function claimHostname(client: Client, params: claimHostname.Params) {
		return client.run(claimHostnameQuery(params));
	},
	{ sql: claimHostnameSql, query: claimHostnameQuery },
);

export namespace claimHostname {
	export type Params = {
		hostname: string;
		projectId: string;
		selfAndAbove: string[];
	};
}

const releaseHostnameSql = `
delete from project_hostnames where hostname = ? and project_id = ?;
`.trim();
const releaseHostnameQuery = (params: releaseHostname.Params) => ({
	name: "releaseHostname",
	sql: releaseHostnameSql,
	args: [params.hostname, params.projectId],
});

export const releaseHostname = Object.assign(
	async function releaseHostname(client: Client, params: releaseHostname.Params) {
		return client.run(releaseHostnameQuery(params));
	},
	{ sql: releaseHostnameSql, query: releaseHostnameQuery },
);

export namespace releaseHostname {
	export type Params = {
		hostname: string;
		projectId: string;
	};
}

const setPrimaryHostnameSql = `
insert into project_primary_hostnames (project_id, hostname) values (?, ?)
on conflict (project_id) do update set hostname = excluded.hostname;
`.trim();
const setPrimaryHostnameQuery = (params: setPrimaryHostname.Params) => ({
	name: "setPrimaryHostname",
	sql: setPrimaryHostnameSql,
	args: [params.projectId, params.hostname],
});

export const setPrimaryHostname = Object.assign(
	async function setPrimaryHostname(client: Client, params: setPrimaryHostname.Params) {
		return client.run(setPrimaryHostnameQuery(params));
	},
	{ sql: setPrimaryHostnameSql, query: setPrimaryHostnameQuery },
);

export namespace setPrimaryHostname {
	export type Params = {
		projectId: string;
		hostname: string;
	};
}

const clearPrimaryHostnameSql = `
delete from project_primary_hostnames where project_id = ?;
`.trim();
const clearPrimaryHostnameQuery = (params: clearPrimaryHostname.Params) => ({
	name: "clearPrimaryHostname",
	sql: clearPrimaryHostnameSql,
	args: [params.projectId],
});

export const clearPrimaryHostname = Object.assign(
	async function clearPrimaryHostname(client: Client, params: clearPrimaryHostname.Params) {
		return client.run(clearPrimaryHostnameQuery(params));
	},
	{ sql: clearPrimaryHostnameSql, query: clearPrimaryHostnameQuery },
);

export namespace clearPrimaryHostname {
	export type Params = {
		projectId: string;
	};
}

const primaryHostnameOfSql = `
select h.hostname
from project_primary_hostnames p
join project_hostnames h on h.hostname = p.hostname and h.project_id = p.project_id
where p.project_id = ?
limit 1;
`.trim();
const primaryHostnameOfQuery = (params: primaryHostnameOf.Params) => ({
	name: "primaryHostnameOf",
	sql: primaryHostnameOfSql,
	args: [params.projectId],
});

export const primaryHostnameOf = Object.assign(
	async function primaryHostnameOf(client: Client, params: primaryHostnameOf.Params): Promise<primaryHostnameOf.Result | null> {
		const rows = await client.all<primaryHostnameOf.Result>(primaryHostnameOfQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: primaryHostnameOfSql, query: primaryHostnameOfQuery },
);

export namespace primaryHostnameOf {
	export type Params = {
		projectId: string;
	};
	export type Result = {
		hostname: string;
	};
}
