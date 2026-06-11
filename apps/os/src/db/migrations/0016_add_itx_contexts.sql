-- The itx context catalog: id -> journal coordinate. This is a DIRECTORY
-- (the sanctioned D1 role: project directory / secrets / DO catalog), never
-- the authority — a context's state and parentage fold from its journal
-- stream; this table only answers "where does ctx_… live" for bare-id
-- restores (reconnects, isolate props).
create table itx_contexts (
  id text primary key not null,
  project_id text not null references projects (id) on delete cascade,
  journal_path text not null,
  created_at text not null default current_timestamp
);

create index idx_itx_contexts_project_id on itx_contexts (project_id);
