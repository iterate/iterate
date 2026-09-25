import type {Client} from 'sqlfu';

const insertInvitationSql = `
insert into invitations (id, token_hash, org_id, role, email_hint, created_by, created_at, expires_at)
select ?, ?, o.id, ?, ?, ?, ?, ?
from organizations o
where o.id = ?
  and (? = 1 or exists (
    select 1 from memberships a
    where a.org_id = o.id and a.user_id = ? and a.role = 'owner'
  ));
`.trim();
const insertInvitationQuery = (params: insertInvitation.Params) => ({
	name: "insertInvitation",
	sql: insertInvitationSql,
	args: [params.id, params.tokenHash, params.role, params.emailHint, params.createdBy, params.createdAt, params.expiresAt, params.orgId, params.asOperator, params.actorId],
});

export const insertInvitation = Object.assign(
	async function insertInvitation(client: Client, params: insertInvitation.Params) {
		return client.run(insertInvitationQuery(params));
	},
	{ sql: insertInvitationSql, query: insertInvitationQuery },
);

export namespace insertInvitation {
	export type Params = {
		id: string;
		tokenHash: string;
		role: ('owner' | 'member');
		emailHint: string | null;
		createdBy: string;
		createdAt: number;
		expiresAt: number;
		orgId: string;
		asOperator: number;
		actorId: string;
	};
}

const invitationByIdSql = `
select
  id,
  org_id as orgId,
  role,
  email_hint as emailHint,
  expires_at as expiresAt,
  revoked_at as revokedAt,
  accepted_by as acceptedBy
from invitations
where id = ?
limit 1;
`.trim();
const invitationByIdQuery = (params: invitationById.Params) => ({
	name: "invitationById",
	sql: invitationByIdSql,
	args: [params.id],
});

export const invitationById = Object.assign(
	async function invitationById(client: Client, params: invitationById.Params): Promise<invitationById.Result | null> {
		const rows = await client.all<invitationById.Result>(invitationByIdQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: invitationByIdSql, query: invitationByIdQuery },
);

export namespace invitationById {
	export type Params = {
		id: string;
	};
	export type Result = {
		id: string;
		orgId: string;
		role: ('owner' | 'member');
		emailHint?: string;
		expiresAt: number;
		revokedAt?: number;
		acceptedBy?: string;
	};
}

const revokeInvitationSql = `
update invitations set revoked_at = ?
where id = ?
  and org_id = ?
  and accepted_by is null
  and revoked_at is null
  and (? = 1 or exists (
    select 1 from memberships a
    where a.org_id = invitations.org_id and a.user_id = ? and a.role = 'owner'
  ));
`.trim();
const revokeInvitationQuery = (data: revokeInvitation.Data, params: revokeInvitation.Params) => ({
	name: "revokeInvitation",
	sql: revokeInvitationSql,
	args: [data.revokedAt, params.id, params.orgId, params.asOperator, params.actorId],
});

export const revokeInvitation = Object.assign(
	async function revokeInvitation(client: Client, data: revokeInvitation.Data, params: revokeInvitation.Params) {
		return client.run(revokeInvitationQuery(data, params));
	},
	{ sql: revokeInvitationSql, query: revokeInvitationQuery },
);

export namespace revokeInvitation {
	export type Data = {
		revokedAt: number | null;
	};
	export type Params = {
		id: string;
		orgId: string;
		asOperator: number;
		actorId: string;
	};
}

const invitationByTokenSql = `
select
  i.id,
  i.org_id as orgId,
  i.role,
  i.email_hint as emailHint,
  i.expires_at as expiresAt,
  i.revoked_at as revokedAt,
  i.accepted_by as acceptedBy,
  o.name as orgName,
  (select m.role from memberships m where m.org_id = i.org_id and m.user_id = ?) as memberRole
from invitations i
join organizations o on o.id = i.org_id
where i.token_hash = ?
limit 1;
`.trim();
const invitationByTokenQuery = (params: invitationByToken.Params) => ({
	name: "invitationByToken",
	sql: invitationByTokenSql,
	args: [params.userId, params.tokenHash],
});

export const invitationByToken = Object.assign(
	async function invitationByToken(client: Client, params: invitationByToken.Params): Promise<invitationByToken.Result | null> {
		const rows = await client.all<invitationByToken.Result>(invitationByTokenQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: invitationByTokenSql, query: invitationByTokenQuery },
);

export namespace invitationByToken {
	export type Params = {
		userId: string;
		tokenHash: string;
	};
	export type Result = {
		id: string;
		orgId: string;
		role: ('owner' | 'member');
		emailHint?: string;
		expiresAt: number;
		revokedAt?: number;
		acceptedBy?: string;
		orgName: string;
		memberRole?: ('owner' | 'member');
	};
}

const acceptInvitationSql = `
update invitations set accepted_by = ?, accepted_at = ?, acceptance_id = ?
where token_hash = ?
  and accepted_by is null
  and revoked_at is null
  and expires_at > ?
  and not exists (
    select 1 from memberships m where m.org_id = invitations.org_id and m.user_id = ?
  );
`.trim();
const acceptInvitationQuery = (data: acceptInvitation.Data, params: acceptInvitation.Params) => ({
	name: "acceptInvitation",
	sql: acceptInvitationSql,
	args: [data.acceptedBy, data.acceptedAt, data.acceptanceId, params.tokenHash, params.now, params.userId],
});

export const acceptInvitation = Object.assign(
	async function acceptInvitation(client: Client, data: acceptInvitation.Data, params: acceptInvitation.Params) {
		return client.run(acceptInvitationQuery(data, params));
	},
	{ sql: acceptInvitationSql, query: acceptInvitationQuery },
);

export namespace acceptInvitation {
	export type Data = {
		acceptedBy: string | null;
		acceptedAt: number | null;
		acceptanceId: string | null;
	};
	export type Params = {
		tokenHash: string;
		now: number;
		userId: string;
	};
}

const insertAcceptedMembershipSql = `
insert into memberships (org_id, user_id, role)
select org_id, accepted_by, role
from invitations
where token_hash = ? and acceptance_id = ?;
`.trim();
const insertAcceptedMembershipQuery = (params: insertAcceptedMembership.Params) => ({
	name: "insertAcceptedMembership",
	sql: insertAcceptedMembershipSql,
	args: [params.tokenHash, params.acceptanceId],
});

export const insertAcceptedMembership = Object.assign(
	async function insertAcceptedMembership(client: Client, params: insertAcceptedMembership.Params) {
		return client.run(insertAcceptedMembershipQuery(params));
	},
	{ sql: insertAcceptedMembershipSql, query: insertAcceptedMembershipQuery },
);

export namespace insertAcceptedMembership {
	export type Params = {
		tokenHash: string;
		acceptanceId: string;
	};
}
