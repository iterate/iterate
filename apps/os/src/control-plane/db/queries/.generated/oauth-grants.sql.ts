import type {Client} from 'sqlfu';

const oauthGrantSql = `
select value from oauth_grants where key = ? and (expires_at is null or expires_at > ?);
`.trim();
const oauthGrantQuery = (params: oauthGrant.Params) => ({
	name: "oauthGrant",
	sql: oauthGrantSql,
	args: [params.key, params.now],
});

export const oauthGrant = Object.assign(
	async function oauthGrant(client: Client, params: oauthGrant.Params): Promise<oauthGrant.Result | null> {
		const rows = await client.all<oauthGrant.Result>(oauthGrantQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: oauthGrantSql, query: oauthGrantQuery },
);

export namespace oauthGrant {
	export type Params = {
		key: string;
		now: number;
	};
	export type Result = {
		value: string;
	};
}

const listOAuthGrantsSql = `
select key, expires_at as expiresAt
from oauth_grants
where key > max(?, ?)
  and key < ?
  and (expires_at is null or expires_at > ?)
order by key
limit ?;
`.trim();
const listOAuthGrantsQuery = (params: listOAuthGrants.Params) => ({
	name: "listOAuthGrants",
	sql: listOAuthGrantsSql,
	args: [params.cursor, params.prefix, params.end, params.now, params.limit],
});

export const listOAuthGrants = Object.assign(
	async function listOAuthGrants(client: Client, params: listOAuthGrants.Params): Promise<listOAuthGrants.Result[]> {
		return client.all<listOAuthGrants.Result>(listOAuthGrantsQuery(params));
	},
	{ sql: listOAuthGrantsSql, query: listOAuthGrantsQuery },
);

export namespace listOAuthGrants {
	export type Params = {
		cursor: string;
		prefix: string;
		end: string;
		now: number;
		limit: number;
	};
	export type Result = {
		key: string;
		expiresAt?: number;
	};
}

const purgeExpiredOAuthGrantsSql = `
delete from oauth_grants where expires_at <= ?;
`.trim();
const purgeExpiredOAuthGrantsQuery = (params: purgeExpiredOAuthGrants.Params) => ({
	name: "purgeExpiredOAuthGrants",
	sql: purgeExpiredOAuthGrantsSql,
	args: [params.now],
});

export const purgeExpiredOAuthGrants = Object.assign(
	async function purgeExpiredOAuthGrants(client: Client, params: purgeExpiredOAuthGrants.Params) {
		return client.run(purgeExpiredOAuthGrantsQuery(params));
	},
	{ sql: purgeExpiredOAuthGrantsSql, query: purgeExpiredOAuthGrantsQuery },
);

export namespace purgeExpiredOAuthGrants {
	export type Params = {
		now: number;
	};
}

const upsertOAuthGrantSql = `
insert into oauth_grants (key, value, expires_at) values (?, ?, ?)
on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at;
`.trim();
const upsertOAuthGrantQuery = (params: upsertOAuthGrant.Params) => ({
	name: "upsertOAuthGrant",
	sql: upsertOAuthGrantSql,
	args: [params.key, params.value, params.expiresAt],
});

export const upsertOAuthGrant = Object.assign(
	async function upsertOAuthGrant(client: Client, params: upsertOAuthGrant.Params) {
		return client.run(upsertOAuthGrantQuery(params));
	},
	{ sql: upsertOAuthGrantSql, query: upsertOAuthGrantQuery },
);

export namespace upsertOAuthGrant {
	export type Params = {
		key: string;
		value: string;
		expiresAt: number | null;
	};
}

const deleteOAuthGrantSql = `delete from oauth_grants where key = ?;`;
const deleteOAuthGrantQuery = (params: deleteOAuthGrant.Params) => ({
	name: "deleteOAuthGrant",
	sql: deleteOAuthGrantSql,
	args: [params.key],
});

export const deleteOAuthGrant = Object.assign(
	async function deleteOAuthGrant(client: Client, params: deleteOAuthGrant.Params) {
		return client.run(deleteOAuthGrantQuery(params));
	},
	{ sql: deleteOAuthGrantSql, query: deleteOAuthGrantQuery },
);

export namespace deleteOAuthGrant {
	export type Params = {
		key: string;
	};
}
