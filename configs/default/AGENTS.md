# Project configuration

This repository is the project's executable configuration. `worker.ts` is the
default project worker (`fetch` plus `processEvent`). It declares packaged apps
such as `GithubAiLinter`, `GuestbookApp`, and `TodoApp`; project-owned app source
lives under `apps/`, and the packaged linter reads editable policy from `rules/`.

The seeded repo also contains `AGENTS.md` (born with this file's content, then
independent): `worker.ts` injects `AGENTS.md`'s contents into every agent's
context automatically (at agent birth and again on every config-repo commit —
see `#syncAgentsMdContext`). Write stable project facts into `AGENTS.md` and
every agent learns them; keep it lean, because it rides every LLM request of
every agent.

## Project lifecycle hooks

The `processEvent` switch in `worker.ts` exposes the lifecycle events. Each
case is ordinary userspace TypeScript: call through `this.itx` directly, such
as `await this.itx.scheduler.set(...)`. The getter memoizes the native Workers
RPC promise-proxy for that stateless invocation, so nested calls pipeline
without first awaiting the project root. There is no
configuration-reconciliation framework around them.

- `project/heartbeat-triggered` is the ordinary event appended by that
  Scheduler script. Its payload is only `{ scheduleKey }`. Put arbitrary
  periodic itx calls directly in this case.
- root `stream/woken` is available for work that should run when the project
  stream wakes after hibernation or an OS deployment.
- `project/worker-updated` is the config-application hook. The
  project-creation terminal publishes the first one after probing the trusted
  seed worker; it does not react to the raw seed commit. For each later config
  repo commit, the platform appends another only after the current default
  worker has built, loaded, and answered a readiness probe. If several commits
  land quickly, a later HEAD may reconcile earlier commit facts too. This is
  deliberately a reconcile-current-config hook, not an exact per-commit
  activation callback. The seeded example calls
  `itx.scheduler.set(...)` here to install one 15-minute heartbeat.
- `project/created` is the first userspace event. The root worker subscription
  is installed immediately before it in the same atomic append, so the seeded
  worker receives it after the platform creation saga has completed. This
  template uses it to create `/agents/onboarding`, install the template-local
  `ONBOARDING.md` prompt, trigger the agent's first turn, and navigate each
  connected `/clients/os-app/**` browser client that is still on the new
  project's landing page to its chat. A five-minute userspace open request
  also lets a generic `capability-provided` client fact fulfill that navigation
  when the new route mounts just after this event. A user who has already moved
  elsewhere is not interrupted by a delayed lifecycle delivery.

`project/create-requested` remains platform-only: it precedes the userspace
worker subscription. The terminal `project/created` certificate includes the
birth configuration, including `config.configRepoTemplate` when the project
was created from a public template.

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
