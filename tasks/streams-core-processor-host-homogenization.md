---
state: ready
priority: high
size: large
dependsOn: []
---

# Streams: subscriber presence + reconciler homogenization (plan of record)

**Implementation: https://github.com/iterate/iterate/pull/1460** (draft until
the deployed-environment e2e run, including the new crash test).

Background and full audit findings:
`tasks/agents-system-audit-and-reconciler-design.md`. This file reflects the
decisions from the planning session (June 2026) and supersedes the earlier
sketch. **One combined PR. No backwards compatibility — prod DB is
disposable** (existing streams may be deleted; reducers need no legacy cases).

## The framing

Every processor's `processEvent` is a **reconciler**: its job is to reconcile
non-serializable runtime state (in-flight LLM calls, timers, open
connections/sockets) against reduced state (what should currently be true).
Its two operations, broadly:

1. **Append events** — change reduced state / the durable record.
2. **Mutate runtime state** — open connections, arm timers, start LLM calls.

No special `reconcile()` API — this is what processEvent is.

## Decisions (all resolved)

1. **Vocabulary.** Keep `stream/created` (genesis; offset-1 invariant in
   validateAppend; carries namespace/path) and `stream/woken` (stream DO
   incarnation, has incarnationId). Add `stream/subscriber-connected` and
   `stream/subscriber-disconnected`. Stop emitting
   `stream/processor-registered` — processor contract info rides in the
   connected payload when the subscriber is a processor host.
2. **Granularity: per connection.** One connected event per subscription
   (per `subscriptionKey`) — processor subscriptions AND inbound
   `subscribe()` calls. The roster in core reduced state is an exact
   event-sourced mirror of the runtime `#connections` map (same key). An
   agent host wake appends ~6 connected events (one per processor), grouped
   for display by the shared host `incarnationId`.
3. **Stream-side appends, no idempotency keys.** `#openConnection` appends
   subscriber-connected; close/`onRpcBroken` append subscriber-disconnected.
   Exactly once per actual open/close by construction, so no dedup keys —
   and host-side dedup would break the roster across disconnect/reconnect
   cycles. The connecting party passes its identity in the subscribe call:
   hosts pass `{incarnationId, processor: {slug, version, contract info}}`;
   inbound callers (browser store `stream-browser-store.ts:387`, peer streams
   `stream.ts:822`, streams-capability `:442`, oRPC router `streams.ts:141`)
   pass an optional descriptor; inbound's auto-generated UUID subscriptionKey
   doubles as incarnation identity for ephemeral subscribers. Refactor freely
   here to reduce indirection (explicit license from planning).
4. **Presence roster in core reduced state.** Core state gains a
   `connections`/roster projection keyed by subscriptionKey (direction,
   subscriber descriptor, incarnationId, connectedAt offset): "who is looking
   at this stream right now". Reducer rules: `woken` **clears the roster**
   (all connections died with the previous stream incarnation — survivors
   re-dial and re-land), connected adds, disconnected removes. No heartbeats,
   no staleness. `processorsBySlug` (event docs, codemode instructions — the
   D11 dependency in `apps/os/src/domains/codemode/stream-processors/codemode/contract.ts:9-11`)
   is now folded from connected events' contract payloads instead of
   processor-registered (`core/implementation.ts:191`).
5. **Core homogenization: same shape, still inline.** CoreStreamProcessor
   keeps being invoked inline at append time (validateAppend needs sync
   state), but gains the processor shape: the `#connections` map moves from
   the Stream DO class into core as instance/runtime state, and outbound
   dialing (today `#reconcile()`, `stream.ts:708-756, 81`) moves into core's
   processEvent — "subscription-configured but no live connection → dial".
   Stream DO shrinks to log + pump + thin shell. NOT fully-hosted core
   (would force double reduction / split brain for append validation).
6. **Delivery union, framework-level.** The host unions presence event types
   into every processor's delivery filter (filter built from
   `contract.consumes`, `stream-processor-host.ts:197`); contracts stay
   purely domain. The StreamProcessor base class routes presence events so
   domain `reduce`/`assertNever` never sees an undeclared type, while
   processEvent implementations CAN handle them. Key safety property
   (verified in planning): a subscriber-connected event is appended after the
   handshake fixes the replay offset, so its offset exceeds every replayed
   event — it is always the tail of any batch it shares, so state-at-event ==
   batch-final state, and per-event reconciliation checks are safe.
7. **Provider recovery on connect.** Move the dangling-started check
   (`cloudflare-ai/implementation.ts:181`, `openai-ws/implementation.ts:229`)
   from the `processEventBatch` overrides into processEvent's
   subscriber-connected case (any connected event triggers it; cheap when
   nothing dangles). **Delete both processEventBatch overrides.** Before
   re-executing, append an explicit attempt-failed event, e.g.
   `openai-ws/llm-request-attempt-failed {llmRequestId, reason:
"host-restarted", incarnationId}` — durable record, NOT a model-visible
   input row. Today's silent re-execution goes away.
8. **Scheduler (debounce wedge) fix: IN scope.** Agent processor handles
   subscriber-connected in processEvent: if reduced state says phase
   `scheduled` and this instance has no timer armed → fire the request path
   immediately (default debounce is 1000ms, `agent/contract.ts:48`; any
   crash+redial exceeds it, so no `dueAt` needed). Fixes audit bug 2.1.
   NOTE: this is unrelated to the deferred clock/alarm task
   (`tasks/streams-core-clock-durable-timers.md`) — no polling, no timers; it
   rides the same presence trigger as #7.
9. **Browser presence: IN scope** (it is what makes the roster read "how many
   people are looking at this stream"). Browser tabs attach via inbound
   subscribe(); connect/disconnect events flow from #3 automatically. A nice
   side effect: opening the stream page delivers a batch and heals any wedged
   processor. Declared browser _contracts/ACLs_ (what a browser may append)
   are OUT of scope.

## Tests (write red first)

- **Provider recovers on wake with zero new domain events**: seed reduced
  state with a `started` request, fresh processor instance (post-crash:
  empty `#executedLlmRequestIds`), ingest a batch containing only a
  subscriber-connected event → assert attempt-failed appended + request
  re-executed. Impossible to pass today; that's the point.
- **Scheduler recovers on wake**: reduced state phase `scheduled`, fresh
  instance, connected-only batch → `llm-request-requested` appended.
- **Roster reduction**: connected/disconnected/woken sequences → roster
  contents; woken clears; reconnect after rpc-broken re-lands.
- **Core dialing as processEvent**: subscription-configured with no live
  connection → dial attempted; configured + connected → no-op.
- Style to follow: `cloudflare-ai/implementation.test.ts:39,61`,
  `openai-ws/implementation.test.ts:230` (events array + seeded snapshot +
  fresh instance + ingest + assert; plain-Node vitest — a "crash" is just a
  fresh instance + connected event).
- **e2e crash test: IN scope.** Add a debug `kill()` to AgentDurableObject
  (Stream DO already has one, `stream.ts:570` → `ctx.abort`); in
  `agents.e2e.test.ts`: send message → kill host mid-LLM-request → assert
  reply still arrives and the stream shows attempt-failed + re-issue.

## Out of scope (separate tasks / later)

- Durable timers / core-owned clock:
  `tasks/streams-core-clock-durable-timers.md` (alarm backstop for the rare
  stream-and-host-both-dead-with-zero-traffic case).
- Event kinds metadata: `tasks/streams-event-kinds-metadata.md` (presence
  types unioned via hardcoded list for now).
- Browser declared contracts/ACLs.
- Provider implementation dedup (openai-ws/cloudflare-ai shared skeleton),
  request-by-reference instead of materialized body, project-worker context
  hook: audit doc §7.

## Suggested build order within the PR

1. Event types + core reducer roster (+ red roster tests).
2. Stream-side connected/disconnected appends in `#openConnection`/close;
   thread subscriber identity through subscribe()/requestStreamSubscription
   and the four inbound callers.
3. Move `#connections` + dialing into CoreStreamProcessor (same-shape
   inline); delete Stream DO `#reconcile`.
4. Framework delivery union + base-class presence routing.
5. Provider recovery-on-connect + attempt-failed events; delete
   processEventBatch overrides (+ red recovery tests first).
6. Scheduler recovery-on-connect (+ red test first).
7. AgentDurableObject debug kill() + e2e crash test.
8. Sweep: delete processor-registered emission, update processorsBySlug
   source, fix event-docs/browser-feed grouping for new types.
