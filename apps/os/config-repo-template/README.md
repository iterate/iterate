# Project configuration

This repository is the project's executable configuration. `worker.ts` is the
default project worker (`fetch` plus `processEvent`). It declares packaged apps
such as `GithubAiLinter`, `GuestbookApp`, and `TodoApp`; project-owned app source
lives under `apps/`, and the packaged linter reads editable policy from `rules/`.

## Project lifecycle hooks

The `processEvent` switch in `worker.ts` exposes the raw lifecycle events. Each
case is ordinary userspace TypeScript: get `itx` there and write whatever calls
the project needs. There is no configuration-reconciliation framework around
them.

- `project/create-requested` is the logical creation-only hook. The platform
  does not commit terminal `project/created` until this case returns
  successfully. Delivery is at least once, so subscriptions, appends, and
  other effects still need stable idempotency keys. The seeded example directly
  calls `itx.scheduler.ensure(...)` here to install one 15-minute heartbeat.
- `project/heartbeat-triggered` is the ordinary event appended by that
  Scheduler script. Its payload is only `{ scheduleKey }`. Put arbitrary
  periodic itx calls directly in this case.
- root `stream/woken` is available for work that should run when the project
  stream wakes after hibernation or an OS deployment.
- `repo/commit-completed`, with exact `/repos/config` cross-post provenance, is
  available for work that should run after config source changes and the new
  worker build handles its first event.

The heartbeat uses the Scheduler's native recurrence shape:
`{ every: seconds }`, `{ cron, timezone? }`, or `{ at: ISO timestamp }`. Copy
the literal `scheduler.ensure(...)` call to add another schedule, use
`{ every: 1 }` in a fast test project, or delete it when a project needs no
heartbeat. `ensure(...)` leaves a matching schedule's clock, run count, and
defining event untouched.

Nothing interprets the source file as desired state. Changing or deleting an
existing schedule is explicit code too: call `scheduler.ensure(...)` or
`scheduler.cancel(...)` from whichever lifecycle case should apply the change.
Missed interval occurrences coalesce; the Scheduler does not backfill one event
per missed interval. The scheduler execution ID is the heartbeat append's
idempotency key.

The root `project-worker` subscription key is platform-owned. Creation hooks
install any additional subscriptions under their own distinct keys.
