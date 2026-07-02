---
state: todo
priority: medium
size: medium
tags: [os, itx, projects, auth]
---

# Project archival: the delete/remove verb is missing end to end

Since the itx-v4 cutover there is deliberately NO way to delete a project —
neither on the auth worker, nor on the engine, nor in the UI. The old
always-throwing Delete button and `deleteProjectServerFn` stub were removed
rather than left half-implemented. This task adds the real verb.

## What's needed

1. **Auth worker: archive.** Projects live in the auth worker's directory
   (global-unique slugs). Archival should free the slug (or tombstone it)
   and drop the project from users' claims.
2. **Engine teardown.** `itx.projects` needs a `remove`/`archive` verb that
   tears down the project's engine state (Project DO, streams, dynamic
   workers) — or at least detaches it so DOs stop being dialable.
3. **UI.** Restore a Delete/Archive action on the projects page
   (`apps/os/src/routes/_app/projects/index.tsx`) wired to the new verb.

## Known call sites waiting on this

- `apps/os/src/lib/project-server-fns.ts` — comment where deletion was
  deliberately removed.
- `apps/os/e2e/test-support/create-test-project.ts` — disposable e2e
  projects cannot be removed; they leak until the stage resets.
- `apps/os/e2e/tui-test/run.ts` — same leak for disposable TUI projects.
- `apps/os/src/project-directory.ts` — related directory gaps noted there
  (custom-hostname provisioning + a `byHostname` endpoint) ride along with
  the auth-worker directory work.
- `apps/os/src/components/project-settings-panel.tsx` /
  `apps/os/src/components/app-sidebar.tsx` — custom hostnames
  (`updateConfig`/`ensureCustomHostname`) are part of the same missing
  project-lifecycle surface.
