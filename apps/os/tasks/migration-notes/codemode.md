# Codemode stream processor migration notes

Migration of the `codemode` processor from
`packages/shared/src/stream-processors/codemode/*` (legacy
`implementProcessor` model, hosted on the OS `StreamProcessorRunner` DO) to a
class-based `StreamProcessor` hosted directly on `CodemodeSession`. Follows the
decisions in `apps/os/tasks/stream-processor-class-migration-log.md` (D1–D11).

## Files

- `apps/os/src/domains/codemode/stream-processors/codemode/contract.ts` — new
  contract on `@iterate-com/streams` `defineProcessorContract`. Event types and
  payload schemas are wire-identical to the legacy contract; the reducer moved
  into the class (D6). `standardProcessorBehavior` dropped per D11: no
  `hasRegisteredCurrentVersion` state field, no consumed/emitted
  `core/stream-processor-registered` event (the host now appends
  `stream/processor-registered` after each handshake).
- `apps/os/src/domains/codemode/stream-processors/codemode/implementation.ts` —
  `CodemodeProcessor extends StreamProcessor<...>`. Also exports
  `ExecuteCodemodeFunctionCallInput` (wire-compatible copy) so out-of-domain
  capability entrypoints can be repointed here when `packages/shared`'s copy is
  deleted.
- `apps/os/src/domains/codemode/stream-processors/codemode/code-executor.ts` —
  verbatim copy of the legacy executor interface types
  (`CodemodeScriptExecutor`, `CodemodeProcessorSession`,
  `CodemodeProcessorLogger`), needed permanently by `codemode-session.ts`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts` — hosts the
  processor (`host = createStreamProcessorHost(this.ctx)`,
  `codemode = this.host.add("codemode", ...)`), public
  `requestStreamSubscription`, callable subscriber, runner-state rewiring.
- `pnpm-lock.yaml` — see "zod instance unification" below.

The legacy sources in `packages/shared/src/stream-processors/codemode/` and the
legacy runner wiring in
`apps/os/src/domains/streams/durable-objects/stream-processor-runner.ts` are
left in place for the orchestrator to delete at the end of the migration.

## Side-effect semantics (the part worth re-reviewing)

The legacy OS runner adapted codemode with `detachedSideEffects: true`, i.e.:

- `ensureSessionStarted` (append `session-started` with the session capability
  callable, fixed idempotency key) was AWAITED before the checkpoint advanced;
- script execution ran via `keepAlive` — detached, NOT blocking the checkpoint.

The class model preserves exactly that split:

- `processEventBatch` override: when the batch has live consumed events and
  reduced state has no `session-started` yet, `blockProcessorWhile` a memoized
  `session-started` append, then `super.processEventBatch(...)`.
- `processEvent` for `script-execution-requested`: `runInBackground`. Blocking
  the checkpoint on script completion would deadlock-by-timeout: scripts call
  back into `CodemodeSession.callFunction`, which appends function-call events
  and then waits for THIS processor's checkpoint to pass them.

Idempotency keys are unchanged: `events.iterate.com/codemode/session-started`
(fixed), `codemode/script-execution-completed@<offset>`,
`codemode/log-emitted/<seq>@<offset>`.

## Dead code deliberately not ported

The legacy implementation's internal session machinery (~350 lines:
`createProcessorSession`, `callFunction` with builtins/tool-provider
resolution/`dispatchCallable`/event-mediated waits) was dead in the OS wiring:
`createCloudflareCodemodeScriptExecutor` was always built with
`getSessionCapability` pointing at the CodemodeSession DO
(`wrapSessionCapability: false`), so the executor never used the processor's
internal session. CodemodeSession owns the whole ctx.\* call protocol. The new
processor deps are only `buildSessionCapabilityCallable`,
`getSessionCapability`, `scriptExecutor`, `now?`. Since the processor lives ON
CodemodeSession, the session capability is now handed over locally instead of
re-dialing the DO through `CODEMODE_SESSION.getByName(...)`.

## Subscription & runner-state rewiring

- `ensureProcessorSubscription` now appends a
  `durableObjectProcessorSubscriber({ bindingName: "CODEMODE_SESSION",
durableObjectName: this.name, processorName: "codemode" })` subscriber under
  the same `subscriptionKey` (`codemode-session:<doName>`). Idempotency key
  gained a `:callable` suffix so the new subscriber event lands on
  pre-migration streams (I3 in the decision log).
- `getRunnerState()` reads `host.runtimeState("codemode")`; the two legacy
  cursors (`reducedThroughOffset`, `afterAppendCompletedThroughOffset`) are
  both reported as the single checkpoint offset — same collapse the retired
  runner DO's `runtimeState()` already did. `codemodeProcessorRunnerName` (the
  legacy runner DO name derivation) is deleted.
- `waitForProcessorCatchUp` now waits for the checkpoint to reach the last
  CONSUMED-type event in history, not the stream max offset: the host
  subscribes with `eventTypes: contract.consumes` (D9), so the checkpoint
  legitimately trails the stream head when the tail holds non-codemode events.
- `resolveRegisteredProvider` reads `(await this.codemode.snapshot()).state`
  directly — typed, and drops the old `as any` casts.

## zod instance unification (pnpm-lock.yaml change)

`packages/streams` resolved `zod@4.4.3` while every other importer (apps/os,
packages/shared, …) resolved `4.3.6`. zod schemas are NOT cross-instance
assignable at the type level, so any apps/os-authored contract fed into the
streams `StreamProcessor` machinery degraded to
`ProcessorState = unknown` / un-narrowed events. Fixed by pinning
packages/streams' resolution down to `4.3.6`
(`pnpm --dir packages/streams update zod@4.3.6` — lockfile-only change; both
apps/os and packages/streams typecheck clean). A broader `pnpm dedupe zod` (up
to 4.4.3 everywhere) was tried first and broke unrelated typing
(`routes/.../streams/index.tsx`, `packages/mock-http-proxy`). Every sibling
domain migration needs this same unification.

## Test results

`pnpm --dir apps/os test:codemode-session`: 16/17 pass (vs. all
script-executing tests failing on the unmigrated base, since the new Stream DO
no longer dials `built-in` subscribers).

The one failure — "runs loopback RPC capability examples with live handles and
callbacks" — is a CROSS-DOMAIN dependency on the agents migration, verified by
instrumentation: every codemode catch-up in that test is millisecond-fast; the
test exceeds its 5s deadline because `ctx.agents.create().sendMessage(...)`
runs `AgentDurableObject.waitForAgentProcessorsCatchUp`, which polls legacy
`STREAM_PROCESSOR_RUNNER` runner state for `built-in` subscriptions the new
Stream DO never dials, and times out after its full 5s. It should go green once
the agents domain is on the class model.

## Hand-off items for the orchestrator / sibling agents

- `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts`
  (`routedStreamBootstrapEvents`) still appends a codemode
  subscription-configured event with the LEGACY `built-in` subscriber under the
  SAME `subscriptionKey` but a different idempotency key. On routed streams,
  whichever subscriber event lands later wins the key — a late legacy append
  would silently stop deliveries (legacy subscribers reduce but are dropped
  from supported runtime state). The slack migration must switch it to
  `durableObjectProcessorSubscriber({ bindingName: "CODEMODE_SESSION", ... })`
  (and append `:callable` to its idempotency key).
- Out-of-domain importers of the legacy
  `@iterate-com/shared/stream-processors/codemode/{contract,implementation,code-executor}`
  (`ToolProviderRegistration`, `ExecuteCodemodeFunctionCallInput`,
  `CodemodeProcessorContract` in the orpc router/slack/e2e) keep compiling
  against the legacy sources; repoint them to
  `apps/os/src/domains/codemode/stream-processors/codemode/*` before deleting
  `packages/shared/src/stream-processors`.
- `CodemodeSessionEnv` no longer requires `STREAM_PROCESSOR_RUNNER`.
- Old runner checkpoints (legacy runner DO KV `snapshot:v5`) are abandoned, not
  migrated: on first callable handshake the processor rebuilds state from full
  history with the side-effect anchor at the new subscription-configured
  offset, so no historical scripts re-execute.
