# Stream Processor Class Migration — PROJECTS and REPOS domains

Migrates `project-lifecycle` and `repo` to the class-based `StreamProcessor`
model per the decision log (`apps/os/tasks/stream-processor-class-migration-log.md`).

## What changed

### Processors (both pure projections; no side effects, so no `processEvent`)

- `apps/os/src/domains/projects/stream-processors/project-lifecycle.ts`
  - Contract moves from `@iterate-com/shared/stream-processors` to
    `@iterate-com/shared/streams/stream-processors`; the reducer moves off the
    contract into `ProjectLifecycleProcessor.reduce` (D6). Event wire formats
    unchanged.
  - Dropped `createProjectLifecycleProcessor` / `reduceProjectLifecycleEvents`
    (no callers outside this file).
- `apps/os/src/domains/repos/stream-processors/repo-stream-processor.ts`
  - Same treatment: `RepoStreamProcessor` class owns `reduce`.
  - `createRepoStreamProcessor` is kept as a deprecated `{ contract,
implementation: {} }` shim ONLY because the retiring legacy
    `StreamProcessorRunner` (apps/os/src/domains/streams — out of this slice's
    scope, DO NOT EDIT) still imports it. Delete the shim together with the
    legacy runner.
  - Test rewritten on the class model (`new RepoStreamProcessor({...}).ingest`).
    The old test event carried a `streamPath` field; the class model's
    `getEventSchema` is strict, so that field had to go.

### Hosting

- `ProjectDurableObject` hosts `project-lifecycle`; `RepoDurableObject` hosts
  `repo`. Both follow D3 exactly:
  `host = createStreamProcessorHost(this.ctx)`, `this.host.add(<contract
slug>, (deps) => new XProcessor(deps))`, public `requestStreamSubscription`
  delegating to the host.
- Subscription events now carry `durableObjectProcessorSubscriber({...})`:
  - project: `bindingName: "PROJECT"`, DO name
    `getProjectDurableObjectName(projectId)`, processor `project-lifecycle`
  - repo: `bindingName: "REPO"`, DO name `getRepoDurableObjectName(params)`,
    processor `repo`
- Idempotency keys get a `:callable` suffix
  (`project-lifecycle-subscription:<id>:workers-rpc:callable`,
  `repo-subscription:<projectId>:<slug>:workers-rpc:callable`) so the new
  subscription-configured event lands on existing streams (I3 in the log).
- `STREAM_PROCESSOR_RUNNER` binding and the runner-name helpers are removed
  from both DO envs.

### Legacy runtime-state shapes preserved

- `ProjectDurableObject.getProjectLifecycleRunnerState()` now reads
  `this.projectLifecycle.snapshot()` and returns the legacy runner shape
  (`state`, `reducedThroughOffset`, `afterAppendCompletedThroughOffset` — both
  offsets are the single class-model checkpoint). The project-ingress workerd
  test asserts this shape and passes unchanged.
- `RepoDurableObject.getRepoRunnerState()` same idea (`state`,
  `reducedThroughOffset`).

## Decisions / gotchas specific to this slice

1. **Catch-up waits must not target the stream head anymore.** The host
   subscribes with `eventTypes: contract.consumes` (D9), so the pump filters
   delivery and the processor checkpoint only ever advances to the latest
   _consumed_ event — never to the head when the head is e.g.
   `subscription-configured` or `processor-registered`. The repo DO's
   `waitForRepoProcessorCatchUp()` previously polled against the full stream
   max offset; that would now time out (5s) on every `getInfo()`. It now
   computes `currentConsumedEventMaxOffset()` (latest history event whose type
   is in `repo.contract.consumes`). Explicit-offset waits (after appending
   `repo/created`) are unaffected.
2. **zod version split between apps/os and packages/streams.** The lockfile
   resolved `packages/streams`' new `zod: ^4.3.6` dep to 4.4.3 while apps/os
   (same `^4.3.6` specifier) sits on 4.3.6. zod brands its types per minor
   (`_zod.version.minor` literal), so apps/os schemas were not assignable to
   the streams package's `z.ZodType` generic bounds — every OS-defined contract
   failed typecheck against `defineProcessorContract`/`StreamProcessor`. Fixed
   with a one-line pnpm-lock.yaml change pinning the streams importer to 4.3.6
   (matches the rest of the workspace; `pnpm dedupe zod` would have worked too
   but rewrote ~3k lockfile lines). Any other domain slice hosting OS-defined
   contracts would have hit this; it is fixed globally now.
3. The legacy runner (`apps/os/src/domains/streams/durable-objects/
stream-processor-runner.ts`) has two pre-existing type errors from the
   upstream echo/circuit-breaker class conversion (`circuitBreakerProcessor` /
   `echoExampleProcessor` no longer exported). Out of scope here; goes away
   when the runner is retired (D7).
4. Dropping `reduce` from the contracts means the legacy runner would reduce
   project-lifecycle/repo as identity if it were ever dialed again — it cannot
   be, since `built-in` subscribers are dropped from supported runtime state
   (D2), and the new callable subscriptions replace them on first DO access.

## Verification

- `pnpm --dir apps/os typecheck 2>&1 | grep -E "domains/(projects|repos)"` — clean.
- `pnpm lint` (includes `iterate/stream-processor-override-args`) — clean.
- `apps/os pnpm test` — 28 files / 122 tests pass, including the rewritten
  `repo-stream-processor.test.ts`.
- `pnpm test:project-ingress` (workerd) — 5/5 pass: full end-to-end callable
  subscription (project create → Stream DO dispatches `requestStreamSubscription`
  on PROJECT → hosted processor reduces → lifecycle state assertions), plus the
  iterate-config repo path through `RepoDurableObject.createRepo`.
