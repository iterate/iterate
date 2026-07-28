# Project configuration

This repository is the project's executable configuration. `worker.ts` is the
default project worker (`fetch` plus `processEvent`). It declares packaged apps
such as `GithubAiLinter`, `GuestbookApp`, and `TodoApp`; project-owned app source
lives under `apps/`, and the packaged linter reads editable policy from `rules/`.

## Project lifecycle hooks

The `processEvent` switch in `worker.ts` exposes the lifecycle events. Each
case is ordinary userspace TypeScript: get `itx` there and write whatever calls
the project needs. There is no configuration-reconciliation framework around
them.

- `project/heartbeat-triggered` is the ordinary event appended by that
  Scheduler script. Its payload is only `{ scheduleKey }`. Put arbitrary
  periodic itx calls directly in this case.
- root `stream/woken` is available for work that should run when the project
  stream wakes after hibernation or an OS deployment.
- `project/worker-updated` is the config-application hook. The platform
  translates a config repo commit into this root event only after the current
  default worker has built, loaded, and answered a readiness probe. If several
  commits land quickly, a later HEAD may reconcile earlier commit facts too.
  This is deliberately a reconcile-current-config hook, not an exact
  per-commit activation callback. The seeded example calls
  `itx.scheduler.set(...)` here to install one 15-minute heartbeat.

`project/create-requested` and `project/created` belong to the platform's
creation saga. They are not userspace lifecycle hooks and the config worker
does not handle them.

The heartbeat uses the Scheduler's native recurrence shape:
`{ every: seconds }`, `{ cron, timezone? }`, or `{ at: ISO timestamp }`. Copy
the literal `scheduler.set(...)` call to add another schedule, use
`{ every: 1 }` in a fast test project, or delete it when a project needs no
heartbeat. `set(...)` leaves a matching schedule's clock, run count, and
defining event untouched.

Nothing interprets the source file as desired state. Changing or deleting an
existing schedule is explicit code too: call `scheduler.set(...)` or
`scheduler.cancel(...)` from whichever lifecycle case should apply the change.
Missed interval occurrences coalesce; the Scheduler does not backfill one event
per missed interval. The scheduler execution ID is the heartbeat append's
idempotency key.
