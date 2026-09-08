-- The control-plane directory. The one authoritative store of "who exists, which orgs/projects exist, and
-- who can access what." Strongly consistent (D1) — no KV list() lag. The OAuth provider keeps its own
-- OAUTH_KV (tokens/grants/clients); this D1 is OURS.
--
-- Org-centric (like apps/os): users belong to orgs, projects belong to orgs, access is org membership.
-- This is what makes "create an org + project during MCP /authorize" (ADR 0029, emerge-with-a-project)
-- a first-class flow rather than a bolt-on.
--
-- Idempotent (IF NOT EXISTS) on purpose: the e2e lane applies it into a fresh local D1 on every run and
-- `pnpm db:schema:remote` re-applies it to the deployed D1 as a no-op.

create table if not exists users (
  id text primary key,            -- user_<lowercased-email> (colon-free: OAuth tokens split on ':')
  email text not null unique,
  created_at text not null default current_timestamp
);

-- THE ONE ANONYMOUS IDENTITY of `open` login mode (control-plane/app.ts ANONYMOUS, and /mcp's
-- open-mode short-circuit). Seeded here so its org membership's FOREIGN KEY holds on every path.
insert or ignore into users (id, email) values ('user_anonymous', 'anonymous');

create table if not exists orgs (
  id text primary key,            -- org_<hex>  (minted, distinct from slug)
  name text not null,
  slug text not null unique,      -- globally-unique org slug
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

-- A project's id IS its slug: one DNS-safe name is the directory row, the context DO's name
-- (`{id}.iterate{path}`) and the project-host label (`<app>--<slug>.<base>`). Globally unique.
create table if not exists projects (
  id text primary key,
  slug text not null unique,
  org_id text not null references orgs(id),
  created_at text not null default current_timestamp
);

create index if not exists idx_org_members_user on org_members (user_id, org_id);
create index if not exists idx_projects_org on projects (org_id);
