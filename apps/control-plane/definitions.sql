-- The control-plane directory. The one authoritative store of "who exists, which orgs/projects exist, who
-- can access what, and where ingress goes." Strongly consistent (D1) — no KV list() lag. The OAuth provider
-- keeps its own OAUTH_KV (tokens/grants/clients); this D1 is OURS (design §2a + §8).
--
-- Org-centric (like apps/os): users belong to orgs, projects belong to orgs, access is org membership.
-- This is what makes "create an org + project during MCP /authorize" (ADR 0029, emerge-with-a-project)
-- a first-class flow rather than a bolt-on.

create table users (
  id text primary key,            -- user:<lowercased-email>
  email text not null unique,
  created_at text not null default current_timestamp
);

create table orgs (
  id text primary key,            -- org_<hex>  (minted, distinct from slug — mirrors apps/auth)
  name text not null,
  slug text not null unique,      -- globally-unique org slug
  created_at text not null default current_timestamp
);

-- Who belongs to which org, and as what. THIS is "who can access what" — access to a project is
-- membership in its org.
create table org_members (
  org_id text not null references orgs(id),
  user_id text not null references users(id),
  role text not null default 'member',   -- 'owner' | 'member'
  created_at text not null default current_timestamp,
  primary key (org_id, user_id)
);

create table projects (
  id text primary key,            -- prj_<hex>  (minted, distinct from slug — mirrors apps/auth)
  slug text not null unique,      -- GLOBALLY unique (not per-org) — a slug taken in any org is taken
  org_id text not null references orgs(id),
  created_at text not null default current_timestamp
);

-- Ingress routes are a PROPERTY OF A PROJECT: a project owns 0..n hostnames. Hostname -> project routing
-- is a reverse lookup here (replacing the kernel's routing.ts). Custom domains = just more rows.
create table routes (
  host text primary key,          -- e.g. myproj.example.com  (the ingress hostname)
  project_id text not null references projects(id),
  app text not null default ''    -- which app within the project ('' = the default app)
);

-- API keys / PATs: bearer credentials scoped to projects (design §2a). Store the HASH, never the raw key.
create table api_keys (
  hash text primary key,          -- sha256(raw key)
  user_id text not null references users(id),
  label text,
  grants text not null,           -- JSON: [{ projectId, scopes:[...] }]
  created_at text not null default current_timestamp
);

create index idx_org_members_user on org_members (user_id, org_id);
create index idx_projects_org on projects (org_id);
create index idx_routes_project on routes (project_id);
