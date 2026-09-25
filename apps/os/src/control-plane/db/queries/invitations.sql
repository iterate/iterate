/** @name insertInvitation */
insert into invitations (id, token_hash, org_id, role, email_hint, created_by, created_at, expires_at)
select :id, :tokenHash, o.id, :role, :emailHint, :createdBy, :createdAt, :expiresAt
from organizations o
where o.id = :orgId
  and (:asOperator = 1 or exists (
    select 1 from memberships a
    where a.org_id = o.id and a.user_id = :actorId and a.role = 'owner'
  ));

/** @name invitationById */
select
  id,
  org_id as orgId,
  role,
  email_hint as emailHint,
  expires_at as expiresAt,
  revoked_at as revokedAt,
  accepted_by as acceptedBy
from invitations
where id = :id
limit 1;

/** @name revokeInvitation */
update invitations set revoked_at = :revokedAt
where id = :id
  and org_id = :orgId
  and accepted_by is null
  and revoked_at is null
  and (:asOperator = 1 or exists (
    select 1 from memberships a
    where a.org_id = invitations.org_id and a.user_id = :actorId and a.role = 'owner'
  ));

/** @name invitationByToken */
select
  i.id,
  i.org_id as orgId,
  i.role,
  i.email_hint as emailHint,
  i.expires_at as expiresAt,
  i.revoked_at as revokedAt,
  i.accepted_by as acceptedBy,
  o.name as orgName,
  (select m.role from memberships m where m.org_id = i.org_id and m.user_id = :userId) as memberRole
from invitations i
join organizations o on o.id = i.org_id
where i.token_hash = :tokenHash
limit 1;

/** @name acceptInvitation */
update invitations set accepted_by = :acceptedBy, accepted_at = :acceptedAt, acceptance_id = :acceptanceId
where token_hash = :tokenHash
  and accepted_by is null
  and revoked_at is null
  and expires_at > :now
  and not exists (
    select 1 from memberships m where m.org_id = invitations.org_id and m.user_id = :userId
  );

/** @name insertAcceptedMembership */
insert into memberships (org_id, user_id, role)
select org_id, accepted_by, role
from invitations
where token_hash = :tokenHash and acceptance_id = :acceptanceId;
