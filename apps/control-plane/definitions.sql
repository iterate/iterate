-- The control-plane directory. The one authoritative store of "who exists, which projects exist, who can
-- access what, and where ingress goes." Strongly consistent (D1) — no KV list() lag. The OAuth provider
-- keeps its own OAUTH_KV (tokens/grants/clients); this D1 is OURS (design §2a + §8).

create table users (
  id text primary key,            -- user:<lowercased-email>
  email text not null unique,
  created_at text not null default current_timestamp
);

create table projects (
  id text primary key,            -- project id (slug-derived for now)
  slug text not null unique,
  created_at text not null default current_timestamp
);

-- Who can access which project, and as what. THIS is the "membership" that was only ever real in the
-- auth.iterate.com provider before — now first-class and local.
create table memberships (
  project_id text not null references projects(id),
  user_id text not null references users(id),
  role text not null default 'member',   -- 'owner' | 'member'
  created_at text not null default current_timestamp,
  primary key (project_id, user_id)
);

-- Ingress routes are a PROPERTY OF A PROJECT: a project owns 0..n hostnames. Hostname -> project routing
-- is a reverse lookup here (replacing the kernel's routing.ts config/KV). Custom domains = just more rows.
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

create index idx_memberships_user on memberships (user_id, project_id);
create index idx_routes_project on routes (project_id);
