import type {Client} from 'sqlfu';

const userByRefSql = `
select id, email from users where id = ? or email = ? limit 1;
`.trim();
const userByRefQuery = (params: userByRef.Params) => ({
	name: "userByRef",
	sql: userByRefSql,
	args: [params.id, params.email],
});

export const userByRef = Object.assign(
	async function userByRef(client: Client, params: userByRef.Params): Promise<userByRef.Result | null> {
		const rows = await client.all<userByRef.Result>(userByRefQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: userByRefSql, query: userByRefQuery },
);

export namespace userByRef {
	export type Params = {
		id: string;
		email: string;
	};
	export type Result = {
		id: string;
		email: string;
	};
}

const listUsersSql = `select id, email from users order by email;`;
const listUsersQuery = { name: "listUsers", sql: listUsersSql, args: [] };

export const listUsers = Object.assign(
	async function listUsers(client: Client): Promise<listUsers.Result[]> {
		return client.all<listUsers.Result>(listUsersQuery);
	},
	{ sql: listUsersSql, query: listUsersQuery },
);

export namespace listUsers {
	export type Result = {
		id: string;
		email: string;
	};
}

const insertUserIfNewSql = `
insert into users (id, email) values (?, ?) on conflict (email) do nothing;
`.trim();
const insertUserIfNewQuery = (params: insertUserIfNew.Params) => ({
	name: "insertUserIfNew",
	sql: insertUserIfNewSql,
	args: [params.id, params.email],
});

export const insertUserIfNew = Object.assign(
	async function insertUserIfNew(client: Client, params: insertUserIfNew.Params) {
		return client.run(insertUserIfNewQuery(params));
	},
	{ sql: insertUserIfNewSql, query: insertUserIfNewQuery },
);

export namespace insertUserIfNew {
	export type Params = {
		id: string;
		email: string;
	};
}

const updateUserEmailSql = `
update users set email = ?
where id = ?
  and (select count(*) from identities i where i.user_id = users.id) = 1
  and not exists (select 1 from identities i where i.user_id = users.id and i.added_at is not null);
`.trim();
const updateUserEmailQuery = (data: updateUserEmail.Data, params: updateUserEmail.Params) => ({
	name: "updateUserEmail",
	sql: updateUserEmailSql,
	args: [data.email, params.id],
});

export const updateUserEmail = Object.assign(
	async function updateUserEmail(client: Client, data: updateUserEmail.Data, params: updateUserEmail.Params) {
		return client.run(updateUserEmailQuery(data, params));
	},
	{ sql: updateUserEmailSql, query: updateUserEmailQuery },
);

export namespace updateUserEmail {
	export type Data = {
		email: string;
	};
	export type Params = {
		id: string;
	};
}

const identityUserSql = `
select u.id, u.email
from identities i
join users u on u.id = i.user_id
where i.provider = ? and i.subject = ?
limit 1;
`.trim();
const identityUserQuery = (params: identityUser.Params) => ({
	name: "identityUser",
	sql: identityUserSql,
	args: [params.provider, params.subject],
});

export const identityUser = Object.assign(
	async function identityUser(client: Client, params: identityUser.Params): Promise<identityUser.Result | null> {
		const rows = await client.all<identityUser.Result>(identityUserQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: identityUserSql, query: identityUserQuery },
);

export namespace identityUser {
	export type Params = {
		provider: string;
		subject: string;
	};
	export type Result = {
		id: string;
		email: string;
	};
}

const insertUserUnlessLinkedSql = `
insert into users (id, email)
select ?, ?
where not exists (select 1 from identities i where i.provider = ? and i.subject = ?)
on conflict (email) do nothing;
`.trim();
const insertUserUnlessLinkedQuery = (params: insertUserUnlessLinked.Params) => ({
	name: "insertUserUnlessLinked",
	sql: insertUserUnlessLinkedSql,
	args: [params.id, params.email, params.provider, params.subject],
});

export const insertUserUnlessLinked = Object.assign(
	async function insertUserUnlessLinked(client: Client, params: insertUserUnlessLinked.Params) {
		return client.run(insertUserUnlessLinkedQuery(params));
	},
	{ sql: insertUserUnlessLinkedSql, query: insertUserUnlessLinkedQuery },
);

export namespace insertUserUnlessLinked {
	export type Params = {
		id: string;
		email: string;
		provider: string;
		subject: string;
	};
}

const insertIdentitySql = `
insert into identities (provider, subject, user_id)
select ?, ?, u.id from users u where u.email = ?
on conflict do nothing;
`.trim();
const insertIdentityQuery = (params: insertIdentity.Params) => ({
	name: "insertIdentity",
	sql: insertIdentitySql,
	args: [params.provider, params.subject, params.email],
});

export const insertIdentity = Object.assign(
	async function insertIdentity(client: Client, params: insertIdentity.Params) {
		return client.run(insertIdentityQuery(params));
	},
	{ sql: insertIdentitySql, query: insertIdentityQuery },
);

export namespace insertIdentity {
	export type Params = {
		provider: string;
		subject: string;
		email: string;
	};
}

const insertAddedIdentitySql = `
insert into identities (provider, subject, user_id, added_at)
values (?, ?, ?, ?)
on conflict do nothing;
`.trim();
const insertAddedIdentityQuery = (params: insertAddedIdentity.Params) => ({
	name: "insertAddedIdentity",
	sql: insertAddedIdentitySql,
	args: [params.provider, params.subject, params.userId, params.addedAt],
});

export const insertAddedIdentity = Object.assign(
	async function insertAddedIdentity(client: Client, params: insertAddedIdentity.Params) {
		return client.run(insertAddedIdentityQuery(params));
	},
	{ sql: insertAddedIdentitySql, query: insertAddedIdentityQuery },
);

export namespace insertAddedIdentity {
	export type Params = {
		provider: string;
		subject: string;
		userId: string;
		addedAt: number | null;
	};
}
