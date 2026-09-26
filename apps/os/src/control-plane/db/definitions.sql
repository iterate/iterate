-- THE CONTROL PLANE'S SCHEMA, the deployment's D1 (binding DB): every user, identity, organization,
-- membership, project, invitation, custom hostname and OAuth grant. sqlfu types the queries in
-- queries/*.sql against this file; migrations/ is what a database runs (`pnpm db:check` holds the
-- two equal). Times are epoch ms, except oauth_grants.expires_at, which is epoch s (KV's unit).
-- D1 enforces foreign keys (https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

-- email: trimmed and lower-cased (catalog.ts `emailAddress`). A user is never deleted.
create table users (
  id text primary key,
  email text not null unique
);

-- A provider's stable subject, linked to a person once: one subject per provider per person.
-- added_at: when the person, signed in, added it to their account (catalog.ts `addIdentity`); null
-- for one a sign-in linked by its email. The address an added one's provider reports is never theirs.
create table identities (
  provider text not null,
  subject text not null,
  user_id text not null references users (id),
  added_at integer,
  primary key (provider, subject),
  unique (provider, user_id)
);

-- A person with a sign-in they added keeps their email: the address an added sign-in's provider
-- reports is never theirs (catalog.ts `linkIdentity` never writes it), and this refuses the write
-- from anything else, such as a version of the platform older than `added_at`. An operator who
-- must change such an email clears the identity's `added_at` first.
-- BEGIN and END in capitals: D1's query API finds the end of a trigger only so, and answers a
-- lowercase one "incomplete input" (probed on a preview's D1, 2026-09-26).
create trigger users_email_kept_by_added_sign_in
before update of email on users
when new.email <> old.email
  and exists (select 1 from identities i where i.user_id = old.id and i.added_at is not null)
BEGIN
  select raise(abort, 'a person with an added sign-in keeps their email');
END;

create table organizations (
  id text primary key,
  name text not null
);

create table memberships (
  org_id text not null references organizations (id) on delete cascade,
  user_id text not null references users (id),
  role text not null check (role in ('owner', 'member')),
  primary key (org_id, user_id)
);
create index memberships_user on memberships (user_id);

-- A row is inserted once and never updated: the edge's memo and a context's stored slug rely on it.
-- No cascade: an organization that holds a project cannot be deleted.
create table projects (
  id text primary key,
  slug text not null unique,
  org_id text not null references organizations (id)
);
create index projects_org on projects (org_id);

-- An invitation link: the token's SHA-256 is the lookup (the token itself is never stored), the id
-- the owners' handle. Single use: `accepted_by` is set once, and `acceptance_id` names the request
-- that set it, so only that request's batch adds the membership (catalog.ts `acceptInvitation`).
create table invitations (
  id text primary key,
  token_hash text not null unique,
  org_id text not null references organizations (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  email_hint text,
  created_by text not null,
  created_at integer not null,
  expires_at integer not null,
  revoked_at integer,
  accepted_by text,
  accepted_at integer,
  acceptance_id text
);
create index invitations_org on invitations (org_id);

-- THE CUSTOM HOSTNAMES, the edge's routing table for hostnames a project added itself: a hostname
-- is ONE project's. A claim is its project processor's to take and release (project/processor.ts),
-- so project_id is not a foreign key.
create table project_hostnames (
  hostname text primary key,
  project_id text not null
);
create index project_hostnames_project on project_hostnames (project_id);

-- A project's primary hostname (project/processor.ts publishes it): one of its hostnames, which its
-- URLs use and the edge redirects its ingress-base navigations to. Read only while the project
-- still holds the claim.
create table project_primary_hostnames (
  project_id text primary key,
  hostname text not null
);

-- THE INTEGRATION ROUTES: where a webhook the platform's own app at a provider receives goes
-- (src/integrations/). An account there (a Slack team, a GitHub installation) is ONE connection's,
-- the log at `path` in `project_id`; a connection holds one account (catalog.ts `routeIntegration`).
create table integration_routes (
  provider text not null,
  external_id text not null,
  project_id text not null,
  path text not null,
  primary key (provider, external_id)
);
create index integration_routes_connection on integration_routes (project_id, path);

-- The OAuth provider's `grant:<userId>:<grantId>` records (oauth-store.ts). expires_at: epoch s,
-- null for a grant that never expires.
create table oauth_grants (
  key text primary key,
  value text not null,
  expires_at integer
);
create index oauth_grants_expiry on oauth_grants (expires_at);
