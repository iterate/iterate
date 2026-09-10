-- The control-plane directory. The one authoritative store of "who exists, which orgs/projects exist, and
-- who can access what." Strongly consistent (D1) — no KV list() lag. The OAuth provider keeps its own
-- OAUTH_KV (tokens/grants/clients); this D1 is OURS.
--
-- Org-centric (like apps/os): users belong to orgs, projects belong to orgs, access is org membership
-- — the console, `/api` (`projects.create`) and `/mcp` create projects through the one directory door.
--
-- Idempotent (IF NOT EXISTS) on purpose: the e2e lane applies it into a fresh local D1 on every run and
-- `pnpm db:schema:remote` re-applies it to the deployed D1 as a no-op.

create table if not exists users (
  id text primary key,            -- user_<lowercased-email> (colon-free: OAuth tokens split on ':')
  email text not null unique,
  created_at text not null default current_timestamp
);

-- Google subjects stay stable when an email changes. A verified first login may
-- adopt an existing operator-created user, but cannot replace another identity.
create table if not exists google_identities (
  subject text primary key,
  user_id text not null unique references users(id)
);

create table if not exists orgs (
  id text primary key,            -- org_<hex> (minted), or org_admin — the deployment's own, no members (control-plane.ts adminOrg)
  name text not null,
  created_at text not null default current_timestamp
);

-- Who belongs to which org, and as what. THIS is "who can access what" — access to a project is
-- membership in its org.
create table if not exists org_members (
  org_id text not null references orgs(id),
  user_id text not null references users(id),
  role text not null default 'member',   -- 'owner' | 'member'
  created_at text not null default current_timestamp,
  primary key (org_id, user_id)
);

-- A project's id is ONE DNS-safe name (a slug), stored once: the directory row, the context DO's
-- name (`{id}.iterate{path}`) and the project-host label (`<app>--<id>.<base>`). Globally unique.
create table if not exists projects (
  id text primary key,
  org_id text not null references orgs(id),
  created_at text not null default current_timestamp
);

create index if not exists idx_org_members_user on org_members (user_id, org_id);
create index if not exists idx_projects_org on projects (org_id);

-- Provider grants remain the inventory. These rows record observed activity and
-- deny access durably before eventually-consistent provider cleanup completes.
create table if not exists oauth_activity (
  user_id text not null,
  grant_id text not null,
  last_used_at integer,
  revoked_at integer,
  cleanup_pending integer not null default 0,
  primary key (user_id, grant_id)
);
