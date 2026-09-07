-- The control plane's ONE table: which projects exist. Nothing else — Jonas's 2026-09-07 wave-0 decision
-- ("super mega simple: Workers RPC and a D1 that just knows which projects exist"). A project host is served
-- only for a project that is here; everything a project IS lives in its own contexts' logs.

create table projects (
  id text primary key,                              -- the project id as the context codec spells it ([A-Za-z0-9_-]+)
  created_at text not null default current_timestamp
);
