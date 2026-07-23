# Project configuration

This repository is the project's executable configuration. `worker.ts` is the
default project worker (`fetch` plus `processEvent`); `apps/` contains the apps
and stateful processors it hosts.

## Creation and reconciliation

The `processEvent` switch in `worker.ts` has two deliberate hooks:

- `project/create-requested` is the creation-only hook. Put initial
  subscriptions and appends in that case, with stable idempotency keys because
  delivery is at least once. The platform does not commit terminal
  `project/created` until this event has been processed successfully.
- `reconcileProject()` is the idempotent desired-state hook. It runs during
  creation, whenever the root stream wakes after an OS deployment or
  hibernation, after a config-repo commit finishes, and when a configured
  heartbeat fires. Add `ensure … exists` work here; it must be safe to run
  repeatedly.

`heartbeatSchedules` uses the scheduler's normal recurrence union:
`{ every: seconds }`, `{ cron, timezone? }`, or `{ at: ISO timestamp }`. Add
multiple entries for multiple cadences, use `{ every: 1 }` in a fast test
project, or use `[]` for no periodic reconciliation. The default is one
15-minute schedule. Missed interval occurrences coalesce; the scheduler does
not backfill one heartbeat per missed interval.

Heartbeat schedules owned by this file use the
`iterate/config/heartbeat/` key prefix. Reconciliation calls
`scheduler.ensure(...)` for each desired definition; the Scheduler leaves a
matching schedule's clock, run count, and defining event untouched. It removes
stale owned keys and never removes unrelated customer schedules. A trigger appends
`events.iterate.com/project/reconciliation-requested` to `/` with only
`{ scheduleKey }`; the scheduler execution ID is the append idempotency key.
The root `project-worker` subscription key is platform-owned; creation hooks
install any additional subscriptions under their own distinct keys.
