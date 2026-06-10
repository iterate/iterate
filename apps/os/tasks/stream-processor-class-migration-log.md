# OS Stream Processor Class Migration — Decision Log

Rewrite of the #1402 spike on top of the merged class-based `StreamProcessor`
model (#1401). Goal: every processor apps/os hosts runs as a `StreamProcessor`
subclass owned directly by a domain Durable Object —

```ts
class RepoDurableObject extends DurableObject {
  repo = new RepoProcessor({ ... });
}
```

— and the Stream DO reaches subscribers through the `packages/shared` Callable
abstraction instead of a hardcoded runner binding.

This file records design decisions and issues hit along the way, in order.

## Decisions

### D1. Keep the subscribeOutbound pump; swap only the dialing to Callable

The Stream DO's outbound machinery (cursor per subscription, fire-and-forget
batch pump, reconcile-on-topology-change) is battle-tested. We do NOT redesign
delivery. The only change: `#connectOutboundConnection` no longer hardcodes
`env.STREAM_PROCESSOR_RUNNER.getByName(...).requestSubscription(...)`
(stream.ts:726). Instead the `stream/subscription-configured` payload carries a
`Callable` descriptor and the Stream DO runs
`dispatchCallable(subscriber.callable, { env, exports }, handshakeArgs)`.

The handshake args stay shape-compatible with today's `requestSubscription`:
`{ stream, subscriptionKey, streamMaxOffset, subscriptionConfiguredEvent,
streamRuntimeState }`. The live `stream` RpcTarget stub passes through Workers
RPC exactly as before — Callable's workers-rpc dispatch is the same transport.

Consequence: `packages/streams` depends on `packages/shared` (confirmed no
cycle: shared does not import streams).

### D2. Subscriber schema: `{ type: "callable", callable: Callable }`

The core contract's `SupportedOutboundSubscriber` gains a callable variant and
the legacy `{ type: "built-in", transport: "workers-rpc", processorSlug }`
moves to the historical (tolerated-but-dropped) union, like the old
capnweb-websocket transports before it. Old subscriptions on existing streams
keep reducing into state without runtime support; OS re-appends callable
subscriptions on agent/repo/etc. first access (the existing
`ensure*Subscriptions` paths already re-append idempotently — but see I3:
idempotency keys must change so the NEW subscription event actually lands).

No security/authorization on who may register which callable — explicitly out
of scope per the task.

### D3. One host helper, processors as plain DO fields

A small `StreamProcessorHost` (packages/streams, worker-side) gives a DO
everything it needs while keeping the class-field aesthetic:

```ts
class AgentDurableObject extends DurableObject<Env> {
  host = createStreamProcessorHost(this.ctx);
  agent = this.host.add("agent", (ctx) => new AgentProcessor({ ...ctx, openai }));
  chat = this.host.add("agent-chat", (ctx) => new AgentChatProcessor(ctx));

  requestStreamSubscription(args: RequestStreamSubscriptionArgs) {
    return this.host.requestStreamSubscription(args);
  }
}
```

- `add(name, build)` constructs the processor immediately with host-provided
  base deps (`iterateContext`, `readState`/`writeState` over `ctx.storage.kv`
  keyed by name, `keepAliveWhile` via `ctx.waitUntil`-compatible tracking).
- `requestStreamSubscription` routes by processor name (carried in the
  callable's `transformInput.shallowMerge: { processorName: "agent" }` or an
  explicit field in the subscription payload), reads the processor's
  checkpoint, and calls back `stream.subscribeOutbound({ processEventBatch:
(batch) => processor.ingest(batch), replayAfterOffset })`.
- Multiple processors with different names per DO fall out for free.

### D4. Late-bound stream context

Processors are constructed at DO field-init time, before any subscription
exists, but `iterateContext.stream.append` needs the stream. The host owns a
per-processor binding box `{ streamStub, namespace, path }` filled during
`requestStreamSubscription` (and re-filled on re-handshake after hibernation —
the Stream DO re-dials on reconcile exactly for this). The context the host
passes to `add(...)`'s builder closes over that box; appending before the
first handshake throws a clear error.

### D5. Side-effect anchor lives in the base class

The old runner had two cursors (`reducedThroughOffset`,
`afterAppendCompletedThroughOffset`) plus a first-attach lookback policy so a
processor attaching to an existing stream rebuilds state from full history
without re-running side effects. The class model has ONE checkpoint, so
without an equivalent, first attach would re-fire every historical side effect
(e.g. agent re-issuing LLM requests for old messages). Resolution:

- `StreamProcessorBaseDeps` gains optional `sideEffectsAfterOffset?: () =>
number` (default `() => 0`). The default `processEventBatch` skips
  `processEvent` for reduced events at or below it; `ProcessEventBatchArgs`
  exposes it so batch overrides can apply the same rule.
- The host sets it per subscription to the `subscription-configured` event's
  offset — the same anchor the old runner used.
- The old 1s first-attach lookback grace is dropped for now: OS appends
  subscription-configured events before the first user-visible event on a
  fresh agent stream, so anchor < first input holds. Revisit if e2e disagrees.

### D6. Processor migration shape

Each legacy processor (`implementProcessor(contract, build)` with
`afterAppend`/`onStart`) becomes a `StreamProcessor` subclass:

- contract keeps `defineProcessorContract` (the shared and streams models use
  compatible contract shapes; reducers move from contract/implementation into
  the class's `reduce`).
- `afterAppend` body → `processEvent` (sync) with async work routed through
  `blockProcessorWhile`/`runInBackground`; `streamApi.append` → typed append
  helper over `this.ctx.stream`.
- `onStart` connection warmup (openai-ws) → lazy instance fields; the DO
  instance is the connection scope, same as the old runner DO was.
- runner-only concepts (`shouldApplySideEffects`, `keepAlive`) map to the
  anchor (D5) and `runInBackground`.

### D7. The StreamProcessorRunner DO is retired

Processors move onto the domain DOs that already exist (Agent, Project, Repo,
SlackIntegration, SlackAgent, CodemodeSession). Where a stream needs a
processor with no natural domain DO (jsonata-reactor on arbitrary streams,
echo/circuit-breaker debug processors), a thin generic `ProcessorHostDO`
remains, built on the same host helper — but it is one `host.add` per
processor, no slug dispatch switch.

Callers of the old runner's `runtimeState()` (codemode session debug,
e2e `runtimeState` assertions) move to an equivalent on the host helper:
`host.runtimeState(name)` returning `{ snapshot, state, checkpointOffset }`.

### D8. Reverted #1401 fixes return here

The atomic browser-checkpoint transaction and `shutdown()` work was reverted
from #1401 after a consistent streams-e2e virtualized-scroll failure (see I1).
The `shutdown()` concept returns as part of the host helper teardown story if
needed; the browser-side atomic checkpoint is independent and will be re-done
separately with the e2e failure understood first.

### D9. Subscriptions filter by event type, driven by the contract

`subscribe`/`subscribeOutbound` accept `eventTypes?: readonly string[]`; the
pump filters post-read while its cursor advances past non-matching events, so
a resume offset can sit on a filtered-out event without re-delivery. The host
always passes `processor.contract.consumes` — the contract is the filter; a
`"*"` in consumes means unfiltered. Consequence to revisit: a processor whose
consumed events are sparse keeps a checkpoint behind the stream head, so
re-handshakes re-read (and re-filter) the gap server-side. Cheap until proven
otherwise.

### D10. Migrated OS processors move into apps/os domains

`packages/streams` now depends on `packages/shared` (for Callable), so shared
can no longer import streams — migrated processor classes cannot live in
`packages/shared/src/stream-processors`. They move next to the DOs that host
them under `apps/os/src/domains/*/stream-processors/`, which is where they
belonged anyway: they are OS product logic, and apps/os depends on both
packages. `packages/shared/src/stream-processors` is deleted at the end of the
migration. Wire formats (event types/payloads) are unchanged by the move.

Processors the old OS runner never selected (`scheduling`,
`jsonata-transformer`, `dynamic-worker`) are not migrated — they are deleted
with the legacy model unless a live subscription path turns up.

### D11. Processor self-registration moves to the host

`standardProcessorBehavior` (per-processor `processor-registered` self-append
with a `hasRegisteredCurrentVersion` state flag) is replaced by the host
appending one idempotency-keyed `processor-registered` event per slug+version
after each successful subscription handshake.

## Issues encountered

### I1. Atomic-checkpoint/shutdown commit broke the virtualized-scroll e2e

`41762ad81` (checkpoint upsert inside the projection transaction + browser
leader `shutdown()` + writer-lock release deferral) failed
`large streams stay virtualized and can scroll from tail to earliest rows`
twice in CI while the parent commit was green; mirror contents were complete
(event-count assertion passed) but the tail row never became visible —
i.e. a scroll/notification behavior change, not data loss. Reverted to unblock
#1401; root cause not yet established. Suspect the writer-lock release
deferral changing teardown/re-election timing during the seeding phase.

### I2. zod resolved to two versions across the workspace

The lockfile resolved `packages/streams`' `zod@^4.3.6` to 4.4.3 while apps/os
and packages/shared resolve to 4.3.6. zod brands its types per minor version,
so every OS-defined contract failed deep type-identity checks against the
streams package's generics. Fixed with a one-line lockfile pin of the streams
importer to 4.3.6.

### I3. Contract-filtered delivery changes "caught up" semantics

With `eventTypes: contract.consumes` (D9), a processor's checkpoint only
advances to the latest consumed event, never the raw stream head. Catch-up
helpers that polled `checkpoint >= maxOffset` would time out; they now compare
against the latest history offset of a consumed type (repo, slack, agents).

### I4. Existing streams keep only legacy subscriptions until re-appended

Callable subscriptions land via the ensure-on-access paths with new
idempotency keys, so new and re-visited streams self-heal. Streams that are
never re-visited through an ensure path (e.g. already-routed Slack threads)
retain only legacy `built-in` subscriptions, which no longer dial. Acceptable
for previews/new projects; production would need a backfill pass.

### I5. Wake-hook catch-up deadlocks against the lifecycle gate on co-hosted DOs

The codemode-session workerd test "runs loopback RPC capability examples with
live handles and callbacks" kept failing after the agents-domain migration.
Root cause: `AgentDurableObject`'s instance-wake hook awaited
`waitForAgentProcessorsCatchUp` — but wake hooks run inside
`ctx.blockConcurrencyWhile` (the lifecycle gate), and in the class model the
processors are co-hosted on the same DO. The Stream DO's subscription
handshake (`requestStreamSubscription`) and event delivery are _inbound_ calls
into that DO, which the closed input gate queues, so the local checkpoints the
wait polls can never advance: the wait burned its full 5s on every instance
wake. The test's script does `ctx.agents.create().sendMessage(...)`, whose
`initialize` triggered the wake hook; the 5s stall pushed
script-execution-completed past the test's own 5s `waitFor`.

This was fine in the legacy model only because the processors lived on a
_different_ DO (the runner): the wake hook polled the runner's checkpoints via
outbound RPC, and the Stream DO delivered to the runner — neither needed this
DO's input gate. The per-processor consumed-event target fix (I3) was correct
but insufficient: with the gate closed, no target > 0 is reachable.

Fix: the wake hook no longer waits; `AgentDurableObject` memoizes one
deferred `waitForAgentProcessorsCatchUp` per instance wake
(`ensureStartedAndCaughtUp()`), awaited by the public methods
(`sendMessage`, `getRuntimeState`, `doThing`, `executeCodemodeFunctionCall`)
_after_ `ensureStarted()` returns — i.e. outside the gate, where the handshake
and deliveries can interleave with the poll. Same once-per-wake semantics,
no gate deadlock. `afterAppend` keeps its own fresh wait (it recomputes
targets at call time). The other migrated domains (repo, slack-integration,
slack-agent, codemode-session) already waited only in regular methods; rule of
thumb going forward: never await processor catch-up inside
`blockConcurrencyWhile` on a DO that hosts the processors.

### I6. streams-e2e tail-anchoring flake (large-streams + heavy-append specs)

The two `stream-browser.spec.ts` failures on this branch (`[data-index='1501']`
never visible; `streamDistanceFromEnd > 200` received `0`) are **not** caused
by the migration. They reproduce identically on origin/main under 6x CDP CPU
throttling (`Emulation.setCPUThrottlingRate`) and pass 5x consecutively
unthrottled on both branch and main on a fast machine. The branch's only
plausible contribution is shifting CI timing closer to a pre-existing cliff
(this also explains I1: the reverted checkpoint commit perturbed the same
timing). Branch suspects were cleared explicitly: browser subscribers pass no
`eventTypes` filter to `subscribe` (delivery unchanged), local spec durations
match main, and the zod 4.3.6 pin is type-level only.

Root cause — two races in the example app's `use-initial-tail-scroll.ts`
tail pin, plus a TanStack Virtual (3.17 core) behavior they interact with:

1. **Snap-back** (heavy-append spec, distance `0`): the pin "settled" on a
   250ms count-quiescence timer, and programmatic `scrollTop` writes never set
   `userLeftTail` (only wheel/pointer/touch/key did). On a slow runner a late
   rAF-batched SQLite invalidation lands after the test scrolls up 500px, the
   not-yet-settled pin fires `scrollToEnd()`, and the viewport snaps back.
2. **Lost/short tail** (large-streams spec, tail row never rendered; locally
   the pin stopped 74px short): a >250ms gap mid-replay settles the pin while
   thousands of rows are still streaming; afterwards only TanStack's
   `followOnAppend` holds the tail, but it (a) only re-engages within
   `scrollEndThreshold` (80px) of the end and (b) can resolve its reconcile
   target against a pre-commit `scrollHeight`, leaving a residual undershoot
   of ~2px per newly-windowed row (estimate 38px vs measured 40px; a ~44-row
   window ≈ 88px > 80px threshold) — which silently breaks the follow chain.

Fix (`packages/streams/example-app/src/lib/use-initial-tail-scroll.ts`, no
wire/subscription changes): the pin now holds until the user actually leaves
the tail and converges to the real bottom. "Left the tail" additionally
detects any scroll with a scrollTop decrease **and** a distance-from-end
increase (catches programmatic/test scrolls and scrollbar drags; immune to
appends, which grow scrollHeight without touching scrollTop, and to TanStack's
above-viewport resize adjustments, which move scrollTop and scrollHeight
together). The settle timer now re-arms and re-`scrollToEnd()`s until the real
DOM distance-from-end is ≤2px, so mid-replay stalls and stale-scrollHeight
follows can no longer strand the viewport; `settledInitialEndScroll` only
gates unread-badge suppression. Verified: both specs pass under 6x/8x/10x
throttle (previously failed at 6x on branch _and_ main) and 5x consecutively
unthrottled; full 26-spec suite green twice.

**Follow-up: CI-only recurrence of the large-streams spec.** After the fix
above, the large-streams spec kept failing on every streams-e2e CI run
(`[data-index='1501']` element not found) while passing 10/10 locally —
including at 10x CPU throttle + 150ms CDP network latency against the
deployed staging worker, and 4/4 inside the official Linux Playwright Docker
image over real network. The workflow uploaded no artifacts, so the first
iteration added (a) an `actions/upload-artifact` step on failure
(`.github/ts-workflows/workflows/streams-e2e.ts`), (b) a release-transition
`console.debug` breadcrumb in the tail-pin hook (traces capture console), and
(c) env-gated CDP throttling in the spec (`E2E_CPU_THROTTLE`,
`E2E_NET_LATENCY_MS`) for local CI-condition repro.

The captured CI trace was conclusive. ~1.2s into the 1500-row replay the pin
logged `released: scroll-away {lastScrollTop:28723, nextScrollTop:28711,
lastDistanceFromEnd:0, nextDistanceFromEnd:3888, scrollHeight:33319}` with no
preceding input event, and the final DOM snapshot showed the viewport
stranded at rows ~808–878 of 1502 (scrollTop ~32k). Decoded: the viewport sat
on the _real_ DOM bottom (28723, pushed there by TanStack's clamped
`wasAtEnd` grow-adjustments), then TanStack's scroll-reconcile loop snapped
scrollTop back to _its_ end target (28711) — the virtualizer's end is short
of the real DOM bottom by the height of non-virtualized chrome inside the
scroller, and that gap is platform-dependent (~12px on CI Linux font metrics,
≤2px on macOS, which is why the 2px epsilon hid it locally). One coalesced
scroll event combined that −12px write with a +3876px append burst, which the
I6 delta heuristic ("scrollTop down AND distance-from-end up = user left")
misread as a user scroll-away; the released pin then stranded the viewport
mid-replay. The heuristic is unfixable in principle: under scroll-event
coalescing, the virtualizer's own convergence writes are indistinguishable
from a user scrolling away.

Final fix: the pin releases **only** on user-input signals
(wheel/pointerdown/touchmove/keydown) or an explicit `markUserLeftTail()`;
the scroll-delta heuristic is gone. Programmatic scrollers must announce
intent — the e2e scroll helpers (`scrollStreamBy`, `scrollToMiddle`,
`sampleUpwardScroll`, `jitterScrollAwayFromBottom`) now dispatch a synthetic
`wheel` event before writing `scrollTop`, the same signal a real user
produces, so the heavy-append spec's no-snap-back guarantee is preserved
through the input path. Verified: full 26-spec suite green locally; the two
tail-pin specs 5x consecutively green under 6x throttle + 100ms latency; full
suite 3x against a deployed Linux-built scratch worker from the Linux
Playwright container (only the two sqlite3-CLI specs fail there — the image
lacks the `sqlite3` binary).

### I7. Core side effects ran against pre-commit stream state — ancestors dialed as `uninitialized:*`

Preview e2e `admin-project` failed: `project.streams.list` only ever returned
the root `/` stream. The list walks `childPaths` from the root, and no
`stream/child-stream-created` events were landing on ancestors. Wrangler-tail
plus a workerd repro showed the announcing stream dialing
`uninitialized:/`/`uninitialized:/probe` — the core processor's
`stream/created` side effect (`processReducedEvent` → `runInBackground` →
`ctx.stream.append({ streamPath: ancestorPath })`) starts executing
synchronously inside `#appendBatchHere`, _before_
`this.#coreProcessorState = workingCoreProcessorState` commits, so
`#resolveStream` read the initial placeholder state (`namespace:
"uninitialized"`). This was latent on main too (repros identically at
origin/main); production streams predate the new Stream DO listing path.

Fix (`packages/streams/src/workers/durable-objects/stream.ts`):
`#appendBatchHere` collects `{event, previousState, state}` tuples and runs
`coreProcessor.processReducedEvent` _after_ the event rows + core state
commit, alongside the rest of the post-commit fan-out. Regression test:
`project-ingress.test.ts` "creating a stream registers childPaths on its
ancestor streams".

### I8. Stream dialed CodemodeSession before initialization — swallowed ingest failures silently skipped events

Both remaining agents e2e failures (`routes Slack webhooks ... bang command
replies` timeout; `completes slack-agent event-mode codemode calls` →
`No codemode provider registered for slack.agent.threadInfo`) had one root
cause. `routedStreamBootstrapEvents` appends the codemode subscription from
the Slack integration, so the routed stream dials a `CodemodeSession` DO that
nothing has ever `initialize({name})`d. Its `requestStreamSubscription` went
straight to `host.requestStreamSubscription` (unlike slack-integration /
slack-agent, which `ensureStartedOrInitializeFromRuntimeName` first). The
handshake itself succeeded (`processor-registered codemode` landed), but the
first delivered batch hit the codemode processor's session-started gate
(`processEventBatch` → `#ensureSessionStarted` →
`buildSessionCapabilityCallable()` → `this.name`) which threw
`NotInitializedError`.

The amplifier: the host's `processEventBatch` callback _swallows_ ingest
failures (`.catch(console.error)`) while the Stream DO's pump cursor advances
(fire-and-forget delivery, D1). A failed batch is therefore lost to that
connection forever: the processor's checkpoint stays behind, but redelivery
only happens on the next _handshake_ — and reconcile never re-dials a key
whose connection is still open. Net effect on the routed stream: the default
tool-provider registrations (offsets ~5–11) and the slack-agent provider
(~17) were skipped; the eventual `executeScript` initialized the DO,
re-appended a subscription-configured (same key → no re-dial), and the old
pump delivered only `script-execution-requested` into a near-empty state —
fresh `session-started` _after_ the script request, then "No codemode
provider registered". In the bang-command test nothing ever initialized the
session, so the script never executed at all (130s timeout).

Fix: `CodemodeSession.requestStreamSubscription` now
`ensureStartedOrInitializeFromRuntimeName()` (same pattern as
slack-integration/slack-agent) before wiring the host. Regression test:
`codemode-session.test.ts` "executes scripts on a session first dialed by a
bootstrap subscription" (red without the fix). Sharp edge to remember: any
deterministic throw inside a hosted processor's batch path (reduce, schema
parse, blockProcessorWhile work) silently skips those events on the live
connection — the checkpoint protects durability only across re-handshakes.
The other hosted DOs were audited: Agent/Project/Repo processors read stream
context from host subscription state (not lifecycle name), and their
subscriptions are only appended post-initialize.

### I9. (running list — updated as migration proceeds)

### Legacy deletion

The legacy (non-class) processor model is now deleted everywhere.

**Deleted:**

- `apps/os/src/domains/streams/durable-objects/stream-processor-runner.ts`
  (754 lines, the OS runner DO) plus every reference: the
  `STREAM_PROCESSOR_RUNNER` binding and `DurableObjectNamespace` in
  `alchemy.run.ts`, the `StreamProcessorRunner` re-exports from
  `entry.workerd.ts` and the three workerd test entries, and the DO bindings +
  `new_sqlite_classes` migration steps in the three `*.wrangler.vitest.jsonc`
  configs.
- `packages/shared/src/stream-processors/**` (whole legacy model + all OS
  processor contracts/implementations, ~40 files) and all of its
  `package.json` export entries plus the `test:stream-processors` script.
- `packages/shared/src/durable-object-utils/mixins/with-stream-processor.ts`
  and `with-stream-processor-runner.ts` (+ its type/unit tests) and their
  export entries — the only remaining importer was the codemode-session test's
  `StreamProcessorRunnerState` type, replaced by
  `Awaited<ReturnType<CodemodeSession["getRunnerState"]>>`.
- `packages/streams`: `src/processor.ts`, `src/processor-runner.ts`,
  `src/processors/standard-processor-behavior.ts`,
  `src/node/connect-processor-runner.ts` (zero importers), and the
  `./processor` / `./processor-runner` exports. `src/types.ts` lost the
  runner-handshake types (`StreamProcessorRunnerRpc`,
  `StreamProcessorRunnerRuntimeState`, `StreamProcessorRunnerSnapshot`).
- Legacy-runner-only helpers in `packages/streams/src/shared/stream-processors.ts`:
  `StoredProcessorState`, `createStoredProcessorState`,
  `FirstAttachAfterAppendPolicy`, `ProcessorImplementation`,
  `BuiltinProcessorImplementation`, `Processor`, `BuiltinProcessor`,
  `implementProcessor`, `implementBuiltinProcessor`, `reduceProcessorEvents`,
  `runProcessorOnStart`, `runProcessorAfterAppend`,
  `catchUpProcessorFromStream`, `consumeLiveProcessorEvent` (and its private
  helpers). Kept everything contracts and the class model use, including
  `runProcessorReduce` (used by `packages/ui`'s stream-view projection) and
  `validateProcessorContract`.
- The unused DO storage helpers in `packages/streams/src/shared/event.ts`
  (`writeEvent`/`writeEventFromKv`/read/init helpers and the
  `DurableObjectStorage`-derived types). The Stream DO has its own inline SQL;
  nothing imported them — and removing them is what lets `packages/ui`
  (lib: dom, no workers types) typecheck against
  `@iterate-com/streams/shared/stream-processors`.
- The `createRepoStreamProcessor` old-model compile shim in
  `repo-stream-processor.ts` and the legacy-runner re-export block in
  `agent-durable-object.ts`.

**Repointed (~35 files):** every `@iterate-com/shared/stream-processors/*`
import now targets the new homes — codemode contract/implementation →
`~/domains/codemode/stream-processors/codemode/*`, agent contract →
`~/domains/agents/stream-processors/agent/contract.ts`, jsonata-reactor →
`~/domains/agents/stream-processors/jsonata-reactor/contract.ts`, and model
helpers (`getInitialProcessorState`, `ProcessorContractShape`,
`ProcessorStreamApi`, `defineProcessorContract`, `runProcessorReduce`) →
`@iterate-com/streams/shared/stream-processors`. `packages/ui` gained a
`@iterate-com/streams` workspace dep. The agent contract's
`CodemodeProcessorContract` dep now points at the new codemode contract — no
import cycle appeared (codemode's contract only imports zod/Callable/streams).

**Judgment calls:**

- Alchemy DO deletion needs no explicit migration entry: alchemy computes
  `deleted_classes` server-side by diffing the worker's previous DO bindings
  (tag-encoded stable ids) against the next deploy's bindings
  (`worker-metadata.ts` in alchemy 0.83). Removing the binding is sufficient;
  the next deploy emits `deleted_classes: ["StreamProcessorRunner"]`.
- `packages/streams/src/subscription.ts` stays: `createStreamSubscription` is
  live infrastructure (SSE bridging in `apps/os` `orpc/routers/streams.ts` and
  `streams-capability.ts`), not legacy-model code.
- `e2e/test-support/create-test-project.ts` now constrains `processors` with a
  structural `ProcessorContractLike` (`events` + optional `processorDeps`)
  because `defineProcessorContract`'s return type routes `reduce` through
  `Omit`, which loses method bivariance against the wide
  `ProcessorContractShape`.
- `agents.e2e.test.ts`: the legacy `built-in`/`capnweb-websocket` slack
  subscription fixture now appends the same callable subscriber payload as
  `SlackIntegrationDurableObject.ensureIntegrationSubscription`
  (subscriptionKey `slack:${projectId}`), and the subscriber assertions check
  `type: "callable"` + `transformInput.shallowMerge.processorName` instead of
  `processorSlug`.
- Known pre-existing failure (unrelated, reproduced with this change stashed):
  `codemode-session.test.ts` › "runs loopback RPC capability examples with
  live handles and callbacks" times out in `waitForScriptExecutionCompleted`
  on this branch. The other 16 tests in that suite and all 5 project-ingress
  tests pass.
