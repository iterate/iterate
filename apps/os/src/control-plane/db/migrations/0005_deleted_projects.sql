-- A DELETED PROJECT'S ID (definitions.sql): written from now on as a project's row is deleted, so a
-- root context is never born again for it. A project deleted before this migration left none: its
-- storage is the context sweep's (scripts/ci/context-sweep.ts).
create table deleted_projects (
  id text primary key
);
