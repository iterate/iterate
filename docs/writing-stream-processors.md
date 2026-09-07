# Writing and testing stream processors

How to author a stream processor whose side effects survive the one thing
guaranteed to happen to it: **eviction**. Every deploy evicts every Durable
Object; hibernation and crashes evict them on their own schedule. A processor
that is only correct while its incarnation stays alive is not correct.

Two hooks are the whole authoring surface: `reduce` applies each consumed event
to state, and `processEvent` causes side effects — that is its entire job.
The same two hooks express very different modalities, and nothing in the
framework picks one for you. A processor can be a durable message queue,
where every event must cause its side effect. It can be an agent, where
events mostly update state and the interesting side effect — start an LLM
request — is decided by looking at the state, with at most one request in
flight. It can be a pure projector with no side effects at all. This doc is
about writing the side-effect half so that any of those survives eviction.

Companion to [domain objects and stream processors](domain-objects-and-stream-processors.md)
(explicit birth certificates, reduced-state doctrine, naming). This guide covers the
half that doctrine document takes for granted: side effects, recovery,
staleness, and how to test all of it in plain node (`iterate/processors/testing`).

The machinery itself — `StreamProcessor`, `defineProcessorContract`, the
runner, the registry, keepalive/recovery durability — lives in the published
package (`packages/iterate/src/processors`, imported as `iterate/processors`).
apps/os hosts its domain processors on it, and a project's own worker can
host processors on exactly the same code through the ordinary published
dependency. The config-repo template's guestbook app
(`configs/default/apps/guestbook` — the `GuestbookApp` server in `server.tsx`,
bundled with `client.tsx` by
`createApp` and rendered via Cap'n Web + `useLiveState`) is the reference for
that userspace hosting shape. Reduced state lives on the project stream at
`/guestbook`.

## Expose the processor vocabulary directly

A domain object's ordinary write door should be a typed `append(...)`, with
its input derived mechanically as `ConsumedInput<typeof ProcessorContract>`
and its runtime boundary validated by
`ProcessorContract.parseConsumedInput(...)`. Do not hand-copy the event union,
and do not replace this door with one wrapper method per event type. A named
method is justified only when it adds real semantics such as encryption,
external I/O, provenance, multi-stream coordination, or birth/readiness
barriers. See
[Prefer a typed append door to one-event wrapper methods](domain-objects-and-stream-processors.md#prefer-a-typed-append-door-to-one-event-wrapper-methods)
for the reference implementation and raw-stream escape hatch.

## State-derived side effects

A queue-shaped processor needs nothing beyond "handle the event": the side
effect follows from the event itself. An obligation-carrying processor
(agent, capability host) additionally uses `processEvent` to compare two
things:

- **Desired state** — the reduced state. `reduce` projects stream-committed
  facts into "what should be the case": open LLM requests, pending script executions, schedules
  that should fire. Durable, replayable, survives everything.
- **Actual state** — the incarnation. Live executions, open sockets, armed
  timers. In-memory, dies with every eviction, **and that is fine** — it is
  never the source of truth.

There is no framework concept for the comparison — it is ordinary
`processEvent` code that reads `state`, checks an in-memory live-set, starts
work nobody is running, settles work whose runner died, and does it all
through idempotent appends so replays converge. It is usually guarded by one
line — `if (!args.delivery.caughtUp) return` — and that guard is a choice,
not a rule: a queue processor acts on every event and never reads the flag.

`delivery.caughtUp` is the one load-bearing fact catch-up imposes: behind the
observed head your reduced state is partial — outcomes may sit in stream
pages not yet replayed — so state-derived effects fired there act on stale desires. It
is the filter-aware form of "the stream's max offset at the moment this event
was dispatched to you": a subset-consuming processor cannot compute that from
`event.offset` alone (whether the events between it and the raw head are
consumable is invisible to it — they were never delivered), so the runner
answers "is anything you'd consume still ahead of you?" precomputed.

Normally `caughtUp` is true on the last consumed event in a scan that reaches
the observed raw head. If that scan contains no consumed event, the runner
calls `processEvent` once with `event: null`, the final reduced state, and
`caughtUp: true`; per-event dispatch must therefore guard `event !== null`.
Consumes-filtered wake frames get a trailing unfiltered self-pull so an
omitted or unconsumed raw tail cannot strand state-derived work.

The reference implementations, in reading order: the `delivery.caughtUp`
branch in `AgentProcessor.processEvent` (start/settle LLM obligations, then
derive scheduling) and `CapabilityHostProcessor` (scripts — same shape,
different settle policy).

## Userspace project lifecycle hooks

The default worker in each project's config repo handles raw lifecycle events
in its literal `processEvent` switch. There is no userspace configuration
framework: each case can run arbitrary project code directly through calls
such as `await this.itx.scheduler.set(...)`. `IterateWorkerEntrypoint`
memoizes the native Workers RPC promise-proxy for its one stateless invocation,
so nested calls pipeline without first awaiting the project root. Cloudflare
releases the RPC stubs with the execution context. This is deliberately not a
Durable Object lifetime contract.

- `project/heartbeat-triggered` is appended to `/` by a project-owned Scheduler
  script and carries only `{ scheduleKey }`.
- `stream/woken` on `/` exposes project-stream wakes, including after an OS
  deployment.
- `project/worker-updated` on `/` is the config-application hook.
  Creation's successful worker probe publishes the first one using the
  OS-stamped seed commit; the platform does not separately translate the raw
  seed commit. For each later copied config repo
  `repo/commit-completed`, the Project processor first waits for the
  authoritative current worker to build, load, and answer. Head convergence
  and in-progress builds keep the platform processor cursor behind for retry;
  deterministic source failure becomes `project/worker-update-failed`. A later
  HEAD may satisfy an earlier commit fact, so this certifies runnable current
  configuration rather than activating one exact artifact.
- `project/created` on `/` is the first userspace hook. The platform installs
  the root worker subscription immediately before the terminal certificate in
  one atomic append. The checked-in templates use it to create and proactively
  open their own onboarding agents; a template can implement a different
  reaction or none.

`project/create-requested` remains private to the platform creation saga
because it precedes the userspace subscription. The seeded worker-update case
directly calls `scheduler.set(...)` for one 15-minute heartbeat. This is
ordinary itx code, not declarative desired state. Copy the call for multiple
schedules, use `{ every: 1 }` for a fast test, or remove it for no heartbeat.
Changing an existing project's schedules is explicit too: call `set(...)` or
`cancel(...)` from the lifecycle case where that action belongs. `set(...)`
preserves the clock, run count, and defining event when the canonical
definition already matches.

The heartbeat action appends one durable `project/heartbeat-triggered` event,
using the Scheduler execution ID for append idempotency. Missed interval
occurrences coalesce into the Scheduler's next trigger; there is no heartbeat
backfill.

## Two primitives, two guarantees

This is the normal delivery-semantics trade-off, spelled as two helpers.
`blockProcessorWhile(work)` gives the work **at-least-once** semantics
(the checkpoint is held; a crash means redelivery; idempotency keys collapse
the re-run). Blocking is the exception, so justify it in a call-site comment:
name the per-event consequence that would be lost forever if the append were
dropped.
`runInBackground` alone gives **at-most-once**: the checkpoint
advances immediately and an eviction loses the closure. Every asynchronous
side effect in a `process*` hook must pick one deliberately:

| Primitive                   | Guarantee                                                                              | On eviction                                                   | Use for                                            |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `blockProcessorWhile(work)` | at-least-once: checkpoint held, crash ⇒ redelivery, idempotency keys dedupe the re-run | batch redelivered by the spine (lag is visible stream-side)   | **short** must-happen work: appends, forwards      |
| `runInBackground(work)`     | a **droppable attempt**: checkpoint advances, eviction loses the closure silently      | gone — no evidence, no retry, unless _you_ wrote the recovery | attempts whose _outcome_ something else guarantees |

`blockProcessorWhile` is not for long work: it head-of-line-blocks every later
event — including the cancellation the user is frantically sending.

A synchronous in-memory poke that is only an idempotent cache hint needs no
side-effect lane. The cache notification in
`repo-processor-implementation.ts` is the reference; it does not carry a
durable consequence.

Registrations run in strict FIFO order: each blocker starts only after the
previous one settles, so a later registration in the same `processEvent` body
observes the earlier work's appends. Order state-derived work after per-event
work by writing it later in the function — there is no separate lane.

At head, settlement appends that must land promptly use one outer
`blockProcessorWhile`; holding the frame lets redelivery retry them. Everything
that can be re-derived from state at leisure is a droppable `runInBackground`
attempt: keepalive revival and the next at-head pass derive it again.

The question every `runInBackground` callsite must answer in a comment or by
obvious construction: **"what recovers the outcome if this attempt drops?"**
Legitimate answers:

- _"my caughtUp branch restarts it from evidence on the stream"_ — the obligation pattern below;
- _"nothing — the outcome genuinely doesn't matter"_ — telemetry, best-effort
  UX touches (a Slack reaction; these must also be freshness-gated — see
  reprocessing safety below).

A naked `runInBackground` around consequential work is the exact bug class
behind the 2026-06-10 and 2026-07-07 production wedges.

## Batches are transport, not semantics

A delivery batch is a catch-up paging unit and an append-coalescing unit —
never a semantic unit. The runner reduces and processes ONE event at a time,
and the harness pins partition invariance: one batch, singletons, or random
partitions of the same stream must produce identical outcomes
(`stream-processor-runner.test.ts`). A proposed failure scenario that does
not reproduce under singleton delivery is not real. High-volume traffic
(streaming chunks, telemetry) rides ephemeral appends, which never reach
processor delivery at all — so no future throughput case adds batch semantics
to this contract either.

## The obligation pattern

For must-complete work that runs longer than a batch may block (LLM calls,
scripts), the pattern is **durable evidence on the stream + droppable
attempt + restart from state**:

1. **Evidence**: a `…-requested` event opens the obligation; the reduced
   state tracks it (with everything needed to start an attempt from state alone — model,
   code, expiry). When a domain needs to distinguish whether external work may
   have begun, a `…-started` event marks that boundary and is appended durably
   **before** the work body runs. If that append fails, the body must not run
   and no settlement may be appended: the obligation stays `requested`, the
   failure propagates (marking the keepalive window), and a later at-head pass
   retries the whole attempt. Release the live-set entry in a `finally` either
   way, or the restart code skips the id for the rest of the incarnation.
   Domains such as Agent that can safely adopt the recorded request need no
   separate started fact.
2. **Attempt**: `runInBackground`, registered in an in-memory live-set
   _synchronously, before any await_, so the same pass never classifies its
   own attempt as undriven.
3. **Restart from state**: whenever `delivery.caughtUp` is true, walk the
   reduced state's open obligations against the live-set:
   - `requested` + nobody driving + not expired → **start** (this is both the
     normal start and the lost-before-started recovery — indistinguishable on
     purpose, and neither depends on the requested event being in this batch);
   - `requested` + expired → **settle as expired failure** (see staleness);
   - `started` + nobody driving → the attempt died with its incarnation →
     **settle as orphaned failure**. Whether settling means fail-or-re-drive
     is a _domain decision_: LLM requests and scripts fail (they may have
     half-executed; the higher level re-derives); an idempotent announcement
     could re-drive. This is why this code is hand-written per processor,
     not machinery.

Use one terminal event per obligation, named `…-settled`, with a result union
whose kinds include success, failure, and cancellation; `completed` reads as
success. Cancellation is one way the obligation settles, so it shares the
settlement key and stale-result reduce guard; the user's separate intent to
stop remains its own event. Do not split one terminal state across
`…-succeeded`, `…-failed`, and `…-cancelled` event types. Repos still has split `…-completed` and
`…-failed` terminal events for stream-compatibility reasons; that shape is
grandfathered, not the template for new work.

For most domains, the settlement result union is also the durable failure
record. `stream/error-occurred` is the agent-visible error lane: among domain
processors, only `AgentProcessor` emits its failures there today so the agent
can transcribe them into model-visible context. General runner-side emission
remains a filed follow-up.

Build processor-owned idempotency keys with
`this.idempotencyKey(key, event)` by default. When the deciding identity must
be embedded by hand, separate it with `@` (`settle@<identity>`); when an event
is supplied, the helper's own `@<path>:<offset>` suffix prevents same-slug
processors forwarding into one stream from colliding. A raw string key is
reserved for deliberate cross-processor convergence, such as shared agent
binding and route-configuration keys, and needs a comment saying that the
collision is the point.

Settlements reuse the normal path's idempotency key. Identical bodies really
do dedupe, but settlement bodies often contain incarnation-dependent values
such as durations, partial text, or freshly signed URLs; when two such bodies
race under one key, the stream rejects the loser as a same-key-different-body
conflict. Use tolerate-as-settlement when losing the race means the obligation
is already settled (the fleet's `#appendUnlessLostIdempotencyRace` shape). Use
read-back-the-winner when the loser must know the authoritative outcome
(`CapabilityHostProcessor`). Use observe-before-append when an unexpected
occupant is a bug that must surface loudly (`SchedulerProcessor`).

## Staleness: wake whenever, act only within the intent's horizon

Recovery can deliver an obligation arbitrarily late — a revival minutes after
a deploy, or days after a crash loop finally met its antidote. **Do not enact
side effects blindly**: check how old the intent is (and, for cross-checks,
how far your reduced state sits from the stream head) before starting anything.

- **`expiresAt` on the requested event.** The requester stamps it as the
  deadline for the **whole obligation**, including its terminal settlement;
  it is not merely a latest-start time. The processor refuses to start past
  it and settles the obligation as expired instead. A started attempt must
  bound every phase to the remaining budget and reserve a short final window
  for appending its terminal outcome. This makes late wakes and wedged RPCs
  safe by construction: an agent revived a week late reports a failure, it
  does not answer a week-old prompt, and an attempt cannot run unbounded after
  the intent expired. Every new obligation type should carry an explicit
  expiry. Processors with expiry or deadline logic take `now` as a required
  dependency; making it optional makes virtual-time tests depend on the host
  clock. New contracts stamp expiries as epoch-ms numbers, not ISO strings.
- **Vendor idempotency for dangerous effects.** For a payment-shaped effect,
  the obligation key must ride to the vendor (e.g. a Stripe idempotency key)
  so at-least-once attempts collapse server-side. Dangerous **and**
  non-idempotent at the vendor ⇒ short expiry, fail closed, escalate to a
  human-visible failure.
- **Hesitation windows.** For retractable intents, put deliberate wall-clock
  between evidence and attempt so invalidating events can land. The agent
  computes debounce plus failure backoff from the pending trigger, then
  appends `llm-request-requested`; its timer is a droppable attempt because
  losing it costs latency, never the request, and the next at-head pass
  derives the same intent from reduced state.

## Reprocessing safety: the whole stream can be replayed at you

The reduction checkpoint is a disposable cache of the reduced state. A
reducer-version change re-reduces from offset 0 with `reduce` only; it does
**not** rerun `processEvent`. The
processing cursor is separate and authoritative. But a new subscriber, an
operator-requested `reprocessFrom`, or an at-least-once redelivery can still
run `processEvent` over historical events, with **event-time state**: at each
event, `state` is the reduction up to that offset, not current truth.

The explicit-birth guard is therefore NOT a replay-safety guard. It only says
whether the processor exists at this point in its history. Once the birth has
reduced, every later historical event passes that guard during a replay, so a
vendor call attached directly to one of those events fires again. The same
shape would re-add 👀 reactions to every historical Slack message (a
rate-limit crash-loop inside `blockProcessorWhile`, with reaction
resurrection as the user-visible symptom).

A per-event append under an idempotency key must have a body that is a
deterministic function of that event and its reduced configuration. A `now()`,
random id, or freshly signed URL in the body turns at-least-once redelivery
into a same-key-different-body conflict that wedges the frame forever. Anchor
deadlines to `event.createdAt`, not the delivery clock.

Every consequential side effect in a `process*` hook must be one of exactly
three shapes:

1. **An append with a stable idempotency key.** Safe by construction: the
   stream dedupes the replay. This is why the durable forwards (Slack
   router → thread stream, repo → PR-agent stream) need no other gate — a
   replay re-dials the appends and they all collapse.
2. **An obligation restarted from the AT-HEAD reduced state** (the pattern
   above). Safe because the at-head reduced state has absorbed every
   committed settlement:
   requested-and-settled pairs cancel out _before_ `processEvent` acts.
   The `delivery.caughtUp` branch in `RepoProcessor.processEvent` is the
   minimal creation example—reduce `createRequest` and `birthCertificate`,
   then provision only when the at-head state has an open request and no
   terminal certificate.
3. **An acknowledgement/cosmetic lane gated on FRESHNESS** — compare
   `event.createdAt` against an injected `now`. Acks mean "your message was
   just picked up"; they are only meaningful near arrival, so stale replays
   (and late wakes) skip them. The Slack 👀 ack and the assistant-status
   repaint are the references (`webhookAckIsFresh` in
   `integrations/utils.ts`); the status lane is additionally
   latest-fact-wins, painted at most once per at-head batch.

For transient vendor cosmetics, remember the latest qualifying fact in an
in-memory field, then at head read and clear that field first and paint it at
most once; `#unpaintedPresenceFact` in
`slack-agent-processor-implementation.ts` and `#unpaintedTypingFact` in
`telegram-agent-processor-implementation.ts` are the reference pair.

Integration transcription also has one concrete shape: append exactly one
`agents/context-added` per source event, with `role: developer`, a transcript
headed by the literal source event type, an `actor` naming the untrusted
sender, and one `refs` entry pointing at that exact source event. Set
`dont-trigger-request` unless that surface's wake rule fires, and turn a
permanent enrichment failure into an explicit note inside the content rather
than silently dropping data. `slack-agent-processor-implementation.ts`,
`telegram-agent-processor-implementation.ts`, and
`email-agent-processor-implementation.ts` are greppable checks of the same
convention.

Vendor work that is **idempotent-by-overwrite** inside a durable lane
(re-downloading Slack-shared files to a per-event storage key) is acceptable:
wasteful on replay, never wrong.

Ephemeral events (`append({ ephemeral: true })` — LLM streaming chunks and
other transient signals) are opt-in per type: delivery hands one to a
processor only when the contract's own catalogue marks that type
`ephemeral: true` AND `consumes` names it explicitly — `"*"` never matches an
ephemeral event, and catch-up reads exclude them regardless. So most
processors never see one and never need to filter; a processor that opts in
(a live-window derivation such as the codemode-tag template's interpreter)
must treat them as side-effect input only: **never fold an ephemeral event
into reduced state** — catch-up and replay do not contain them, so state
derived from one diverges from re-reducing the durable log.
Corollary: anything your reducer or a durable append depends on must NOT be
appended ephemeral — the durable truth is always its own event (chunks →
an assistant-role `agents/context-added` item).

### The replay test

Every processor whose `process*` hooks touch a vendor must have one. It is a
few lines, and it doubles as scenario 4 below:

1. Run the normal live flow against an in-memory stream, vendor fakes
   recording.
2. Advance the injected clock past the freshness horizon.
3. Construct a SECOND, fresh processor instance over the SAME stream and
   deliver the whole stream from offset 0 — that IS a replay.
4. Assert: the fresh instance's vendor fakes saw **zero** calls (make a
   dangerous fake THROW, so reaching it fails loudly), the stream gained
   **zero** events, and the replayed state equals the live instance's.

References: the replay tests in `slack-processor.test.ts` /
`slack-agent-processor.test.ts` (router ack/forwards + agent status/ack) and
`repo-processor.test.ts` (GitHub push import).

## What the runner registry gives you for free (and what it demands)

`createStreamProcessorRegistry` wires each durable runner to a **keepalive**
(`stream-processor-keepalive.ts`): while registered work is in flight, a
durable DO alarm sits ~10s ahead of it. An incarnation that dies owing work
gets its alarm fired in a fresh incarnation, which revives the processor:

1. append one `events.iterate.com/stream/processor-revived` fact to the
   stream (durable evidence; also cold-boots the stream DO, whose `woken`
   fan-out restores the spine's deliveries);
2. let ordinary delivery drive the named processor through the runner; a
   processor may consume the fact when it reacts to the fact itself, but
   consumption is not required for recovery: reaching head guarantees either
   a consumed event with `caughtUp: true` or the eventless
   `processEvent(event: null, caughtUp: true)` pass.

Recovery therefore has exactly one entrypoint — batch delivery. For Agent, the
stream story is `…llm-request-requested` → `…/revived` →
`…llm-request-settled`: the fresh incarnation adopts the still-open request.
When that settlement is a retryable failure, its `reduce` arm turns the
failure into the next pending trigger under the cap; the next at-head pass
applies backoff and records a new `…llm-request-requested` intent.

The keepalive is also a **crash-loop breaker**, because a DO must never stay
awake forever from a bug: every revival durably marks a counter _before_
doing anything and arms its retry along a backoff
(10s → 1m → 5m → 30m → 6h plateau, forever ≈ 4 wakes/day). The budget resets
only on a **quiet-clean confirmation** (a fire that finds all work settled
successfully) or a **version change** — the antidote deploy retries
immediately. Wedged work that never settles (a hung promise no deadline owns)
trips a busy-fire cap after ~15 minutes and decays into the same backoff.
Enforcement lives in DO KV _below_ the reduction — deliberately: a poisoned
reducer cannot be asked to reduce its own pause fact. Stream facts about crash loops
(`error-occurred`, key `processor-host-crash-loop:<version>`) are evidence,
not enforcement.

What hosting code must do:

- **Wire `alarm()`** on every DO class that hosts processors:
  `alarm() { return this.#registry.handleAlarm(); }`. A registry without it
  has no revival.
- **Stateful dynamic workers** (project-userspace DOs, hosted as workerd
  facets) have no native alarms, but `IterateDurableObject` routes the
  standard `ctx.storage` alarm API through the platform Durable Object
  hosting the worker, so `this.ctx` just works as the registry state; the
  fire calls the class's `alarm()`. The seeded template's guestbook is the
  reference shape.
- **Share the alarm through slices** if the DO schedules its own work: state
  desires via the registry's alarm slices; tolerate early fires; re-arm
  inside your handler (see `SchedulerDurableObject`).
- **Worker-hosted processors** (push-lane subscribers with stream-owned
  cursors, e.g. the project worker) have no alarm and no keepalive: their
  recovery is the spine's ack-based redelivery, which only covers
  `blockProcessorWhile`-shaped work. They must not start droppable attempts
  whose outcome matters — route such obligations to a DO-hosted processor.

## Testing: every failure above is a few lines of plain node

`makeProcessorHarness` has one shape for every suite: the real runner,
`ProcessorKeepalive`, recovery adapter, Durable Object KV-backed progress,
alarm cell, virtual clock, and `MemoryStream`. `crash()` is eviction and does
not attach its successor; a new append or a due alarm is the production-real
wake. See `email-agent-recovery.test.ts`, `repo-recovery.test.ts`,
`capability-host-recovery.test.ts`, and `telegram-agent-recovery.test.ts`.
The registry's own isolation fakes remain in
`stream-processor-registry.test.ts` because that suite tests the registry
layer itself.

With `makeProcessorHarness`, step tuples are the scenario spine; use
`h.append(...)` and `h.advanceTime(...)` for single actions. Raw
`h.stream.append(...)` is the committed-but-undelivered door: it commits to
the stream without driving delivery, so reserve it for premises that need
that distinction. When timing arithmetic depends on a config default such as
a debounce or expiry, read it from `h.state().config...` instead of repeating
the default as a magic number.

The rules that keep these tests honest:

- **Runtime state comes from lifecycle, never field injection.** An empty
  live-set IS "crashed mid-attempt" — produced by `h.crash()`. An in-flight
  attempt IS "vendor hasn't answered" — produced by a hanging vendor fake.
  Every state a test exercises is thereby a _reachable_ state, and the test
  doubles as the existence proof. If you cannot reach a state through the
  dials, that is the finding.
- **The stream is the assertion surface.** The doctrine forces every
  consequential outcome to be an event, so asserting on `h.stream.events` is
  complete. The only observables outside it: `h.store.alarm.at` (what's
  armed) and the keepalive KV record — the deliberately-below-the-reduction layer.
- **Dead incarnations are fenced.** A crashed incarnation's stray closures (a
  debounce timer firing late) hit a fence and fail, exactly as an evicted
  isolate cannot write. If a test needs the fence _not_ to fire, the code
  under test is relying on immortality.
- **Virtual time for alarms/expiry/backoff; real (small) time for timers.**
  `h.advance(ms)` drives the alarm and clock-dependent policy through the
  real `handleAlarm` path; genuine `setTimeout`s (the 250ms debounce) run on
  real time under a short delivery pump. Injected `now` deps are the house
  norm (scheduler, spine, keepalive) — don't reach for global
  `vi.useFakeTimers()` for host-shaped code.

Scenarios every obligation-carrying processor should have (crib from
`agent-eviction-recovery.test.ts`, `capability-host-recovery.test.ts`,
`stream-processor-registry.test.ts`):

1. eviction mid-attempt → revival settles it and the domain retries/reports;
2. eviction before any attempt → provably-never-ran work starts late (or
   expires);
3. expired obligation → settled without the vendor ever being dialed;
4. full-stream replay → settlements dedupe, nothing re-executes (the replay
   test above — required for every processor that touches a vendor);
5. the crash-loop breaker engaging on your processor's poison shape;
6. a failed started-append → nothing runs, nothing settles, the live-set is
   released, and a later batch retries the whole attempt.

## Checklist for a new processor

- [ ] A distinct `*/created` event whose payload contains only immutable facts
      required for existence (and may be `{}`); nullable
      `state.birthCertificate` stores its exact payload.
- [ ] The created reduce arm returns the existing state when
      `birthCertificate` is already set. Stable, payload-free creation keys
      make identical retries dedupe and make same-key/different-body retries
      fail loudly at append time; reduction must never wedge a committed
      frame merely because it contains a duplicate birth fact.
- [ ] Ordinary events stay in the processor's monolithic reducer. Actions
      return before birth, while command/RPC methods that require existence
      assert birth explicitly.
- [ ] The creator appends births and setup before explicit subscriptions, then
      calls `waitUntilProcessed` through the final creation-batch offset.
- [ ] The domain object exposes `append(...)` as
      `ConsumedInput<typeof ProcessorContract>` and validates it with
      `ProcessorContract.parseConsumedInput(...)`; no one-event wrapper methods
      without additional domain semantics.
- [ ] Every `runInBackground` answers "what recovers the outcome?"
- [ ] Obligations: a `…-requested` event opens the reduced-state entry; an
      optional `…-started` event records a meaningful attempt boundary; one
      `…-settled` terminal with a success/failure/cancelled result union
      deletes the entry.
- [ ] `delivery.caughtUp` branch: start undriven fresh work, settle orphans and
      expired intent, idempotency keys shared with the normal path.
- [ ] `expiresAt` stamped by the requester; the at-head branch honors it (and the
      `createdAt + DEFAULT` fallback covers raw appends).
- [ ] A failed started-append never settles and never leaks the live-set.
- [ ] Required injected `now` dep for expiry/deadline logic; new expiry fields
      are epoch-ms numbers.
- [ ] Every vendor side effect is one of the three replay-safe shapes:
      idempotency-keyed append, at-head reduced-state comparison, or
      freshness-gated ack — never guarded by event-time state alone.
- [ ] The replay test: a fresh instance fed the full stream re-executes no
      vendor work, appends nothing new, and converges to the same state.
- [ ] Hosting DO wires `alarm()` to its registry (and alarm slices if it schedules).
- [ ] Harness scenarios 1–6 above.
