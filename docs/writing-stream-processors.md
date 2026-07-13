# Writing and testing stream processors

How to author a stream processor whose side effects survive the one thing
guaranteed to happen to it: **eviction**. Every deploy evicts every Durable
Object; hibernation and crashes evict them on their own schedule. A processor
that is only correct while its incarnation stays alive is not correct.

Companion to [domain objects and stream processors](domain-objects-and-stream-processors.md)
(creation-as-event, fold doctrine, naming). This guide covers the half that
doctrine document takes for granted: side effects, recovery, staleness, and
how to test all of it in plain node
(`apps/os/src/domains/streams/test-helpers.ts`).

## The model: a processor is a reconciler

A processor is two halves plus a comparison:

- **Desired state** — the fold. `reduce` projects journaled facts into "what
  should be the case": open LLM requests, pending script executions, schedules
  that should fire. Durable, replayable, survives everything.
- **Actual state** — the incarnation. Live executions, open sockets, armed
  timers. In-memory, dies with every eviction, **and that is fine** — it is
  never the source of truth.
- **Reconciliation** — the `reconcile` hook compares the two and acts: start
  attempts for desired work nobody is driving, settle work whose driver died,
  and do it all through idempotent appends so replays converge. The base
  class calls `reconcile` only for AT-HEAD batches (`checkpointOffset >=
streamMaxOffset`), so overrides never need their own gate: a mid-catch-up
  fold shows obligations whose outcomes sit in the next page, and acting on
  it would re-drive real vendor calls. Each wake-lane batch carries the highest
  contiguous offset the stream scanned, including filtered and ephemeral rows,
  so the final page checkpoints through the raw head and recovery always gets
  its reconciliation pass without a second journal read. (Older processors
  spell the same thing as a `processEventBatch` override with a hand-written
  at-head gate; the gate semantics are identical, and they should migrate to
  `reconcile` when touched.)

The reference implementations, in reading order:
`AgentProcessor.reconcile` (the canonical obligation reconciler: drive/settle
LLM obligations, then derive scheduling — plus a last-resort backstop) and
`CapabilityHostProcessor` (scripts — same shape, different settle policy).

## Two primitives, two guarantees

Every side effect in a `process*` hook must pick one of these deliberately:

| Primitive                   | Guarantee                                                                              | On eviction                                                     | Use for                                            |
| --------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `blockProcessorWhile(work)` | at-least-once: checkpoint held, crash ⇒ redelivery, idempotency keys dedupe the re-run | batch redelivered by the spine (lag is visible stream-side)     | **short** must-happen work: appends, forwards      |
| `runInBackground(work)`     | a **droppable attempt**: checkpoint advances, eviction loses the closure silently      | gone — no evidence, no retry, unless _you_ built the reconciler | attempts whose _outcome_ something else guarantees |

`blockProcessorWhile` is not for long work: it head-of-line-blocks every later
event — including the cancellation the user is frantically sending.

The question every `runInBackground` callsite must answer in a comment or by
obvious construction: **"what recovers the outcome if this attempt drops?"**
Legitimate answers:

- _"the reconciler, via journaled evidence"_ — the obligation pattern below;
- _"nothing — the outcome genuinely doesn't matter"_ — telemetry, best-effort
  UX touches (a Slack reaction; these must also be freshness-gated — see
  refold safety below).

A naked `runInBackground` around consequential work is the exact bug class
behind the 2026-06-10 and 2026-07-07 production wedges.

## The obligation pattern

For must-complete work that runs longer than a batch may block (LLM calls,
scripts), the pattern is **journaled evidence + droppable attempt +
reconciler**:

1. **Evidence**: a `…-requested` event opens the obligation; the fold tracks
   it (with everything needed to start an attempt from state alone — model,
   code, expiry). A `…-started` event marks that an attempt began, appended
   durably **before** the work body runs — and if that append FAILS, the body
   must not run and no completion may be appended: the obligation stays
   `requested`, the failure propagates (marking the keepalive window), and a
   later reconciliation retries the whole attempt. Release the live-set entry
   in a `finally` either way, or the reconciler skips the id for the rest of
   the incarnation. Terminal events (`…-completed`, a cancellation) close the
   obligation and delete it from the fold.
2. **Attempt**: `runInBackground`, registered in an in-memory live-set
   _synchronously, before any await_, so the same pass never classifies its
   own attempt as undriven.
3. **Reconciler**: at the end of _every_ batch, walk the fold's open
   obligations against the live-set:
   - `requested` + nobody driving + not expired → **start** (this is both the
     normal start and the lost-before-started recovery — indistinguishable on
     purpose, and neither depends on the requested event being in this batch);
   - `requested` + expired → **settle as expired failure** (see staleness);
   - `started` + nobody driving → the attempt died with its incarnation →
     **settle as orphaned failure**. Whether settling means fail-or-re-drive
     is a _domain decision_: LLM requests and scripts fail (they may have
     half-executed; the higher level re-derives); an idempotent announcement
     could re-drive. This is why the reconciler is hand-written per
     processor, not machinery.

Settlements reuse the normal completion path's **idempotency keys**, so a
race between a late attempt and the reconciler — or a full journal refold —
collapses to one durable outcome at the append dedup layer.

## Staleness: wake whenever, act only within the intent's horizon

Recovery can deliver an obligation arbitrarily late — a revival minutes after
a deploy, or days after a crash loop finally met its antidote. **Do not enact
side effects blindly**: check how old the intent is (and, for cross-checks,
how far your fold sits from the stream head) before starting anything.

- **`expiresAt` on the requested event.** The requester stamps it; the
  reconciler refuses to _start_ past it and settles the obligation as expired
  instead (_only-settle-past-expiry_). This is what makes late wakes safe by
  construction: an agent revived a week late reports a failure, it does not
  answer a week-old prompt. Every new obligation type should carry it
  (defaults derive from `createdAt` when raw appends omit it).
- **Vendor idempotency for dangerous effects.** For a payment-shaped effect,
  the obligation key must ride to the vendor (e.g. a Stripe idempotency key)
  so at-least-once attempts collapse server-side. Dangerous **and**
  non-idempotent at the vendor ⇒ short expiry, fail closed, escalate to a
  human-visible failure.
- **Hesitation windows.** For retractable intents, put deliberate wall-clock
  between evidence and attempt so invalidating events can land — the agent's
  debounce between `llm-request-scheduled` and `llm-request-requested` is
  this pattern (and its timer is a droppable attempt: losing it costs
  latency, never the request, because the settle logic re-derives it from
  the fold).

## Refold safety: the whole journal will be replayed at you

The checkpoint is a disposable CACHE of the fold. **Bump the processor
contract version whenever its state schema changes.** The production Durable
Object host keys internal snapshots by that version; a new version misses the
old checkpoint and refolds from offset 0. Matching-version state is trusted
because only that host writes it, avoiding a recursive schema parse and copy on
every cold activation. Browser and custom checkpoint stores still parse loaded
state and treat a schema mismatch as the same cache miss
(`StreamProcessor.#loadState`). That means `processEvent` runs again for every
historical event, with **event-time state**: at each event, `state` is the fold
up to that offset, not current truth.

Event-time state is therefore NOT a guard. `if (state.created) return` does
not protect a refold: the `created` fact folds _later_ in the replay, so the
vendor call re-fires against a repo that already exists — and the repo
processor's seeding force-pushes the seed commit over whatever the user has
committed since. That was a real latent bug; the same shape would have
re-added 👀 reactions to every historical Slack message (a rate-limit
crash-loop inside `blockProcessorWhile`, with reaction resurrection as the
user-visible symptom).

Every side effect in a `process*` hook must be one of exactly three shapes:

1. **An append with a stable idempotency key.** Safe by construction: the
   stream dedupes the replay. This is why the durable forwards (Slack
   router → thread stream, repo → PR-agent stream) need no other gate — a
   refold re-dials the appends and they all collapse.
2. **An obligation reconciled from the AT-HEAD fold** (the pattern above).
   Safe because the final fold has absorbed every journaled completion:
   requested-and-completed pairs cancel out _before_ the reconciler acts.
   `RepoProcessor.processEventBatch` is the minimal example — fold
   `createRequested`, reconcile `createRequested && !created` at head.
3. **An acknowledgement/cosmetic lane gated on FRESHNESS** — compare
   `event.createdAt` against an injected `now`. Acks mean "your message was
   just picked up"; they are only meaningful near arrival, so stale replays
   (and late wakes) skip them. The Slack 👀 ack and the assistant-status
   repaint are the references (`webhookAckIsFresh` in
   `integrations/utils.ts`); the status lane is additionally
   latest-fact-wins, painted at most once per at-head batch.

Vendor work that is **idempotent-by-overwrite** inside a durable lane
(re-downloading Slack-shared files to a per-event storage key) is acceptable:
wasteful on refold, never wrong.

One guarantee holds in both directions: **processors never see ephemeral
events** (`append({ ephemeral: true })` — LLM streaming chunks and other
transient signals). The wake lane drops them from delivery and catch-up reads
exclude them, so neither a live fold nor a refold ever contains one: you never
need to filter them out yourself, and you cannot fold or side-effect on one.
Corollary: anything your fold or reconciler depends on must NOT be appended
ephemeral — the durable truth is always its own event (chunks →
`output-added`).

### The refold test

Every processor whose `process*` hooks touch a vendor must have one. It is a
few lines, and it doubles as scenario 4 below:

1. Run the normal live flow against an in-memory stream, vendor fakes
   recording.
2. Advance the injected clock past the freshness horizon.
3. Construct a SECOND, fresh processor instance over the SAME stream and
   deliver the whole journal from offset 0 — that IS a refold.
4. Assert: the fresh instance's vendor fakes saw **zero** calls (make a
   dangerous fake THROW, so reaching it fails loudly), the journal gained
   **zero** events, and the refolded state equals the live instance's.

References: the "refold: …" tests in `slack-processors.test.ts` (agent
status/ack + router ack/forwards) and `pr-agent.test.ts` (repo creation).

## What the host gives you for free (and what it demands)

`createStreamProcessorHost` backs both primitives with a **keepalive**
(`stream-processor-keepalive.ts`): while any registered work is in flight, a
durable DO alarm sits ~10s ahead of it. An incarnation that dies owing work
gets its alarm fired in a fresh incarnation, which **revives** the host:

1. append one `events.iterate.com/stream-processor-host/revived` fact to the
   stream (journaled evidence; also cold-boots the stream DO, whose `woken`
   fan-out restores the spine's deliveries);
2. pull every hosted processor through its pending events (unfiltered, unlike
   wake-mode push) — the fact guarantees at least one batch, so **every
   reconciler runs**.

Recovery therefore has exactly one entrypoint — batch delivery — and the
journal narrates the whole episode: `…llm-request-requested` →
`…/revived` → `…llm-request-completed {failure: orphaned}` →
`…llm-request-scheduled`.

The keepalive is also a **crash-loop breaker**, because a DO must never stay
awake forever from a bug: every revival durably marks a counter _before_
doing anything and arms its retry along a backoff
(10s → 1m → 5m → 30m → 6h plateau, forever ≈ 4 wakes/day). The budget resets
only on a **quiet-clean confirmation** (a fire that finds all work settled
successfully) or a **version change** — the antidote deploy retries
immediately. Wedged work that never settles (a hung promise no deadline owns)
trips a busy-fire cap after ~15 minutes and decays into the same backoff.
Enforcement lives in DO KV _below_ the fold — deliberately: a poisoned fold
cannot be asked to fold its own pause fact. Journal facts about crash loops
(`error-occurred`, key `processor-host-crash-loop:<version>`) are evidence,
not enforcement.

What hosting code must do:

- **Wire `alarm()`** on every DO class that hosts processors:
  `alarm() { return this.#processorHost.handleAlarm(); }`. A host without it
  has no revival.
- **Share the alarm through slices** if the DO schedules its own work: state
  desires via `host.setAlarmSlice(name, atMs)`; tolerate early fires; re-arm
  inside your handler (see `SchedulerDurableObject`).
- **Worker-hosted processors** (push-lane subscribers with stream-owned
  cursors, e.g. the project worker) have no alarm and no keepalive: their
  recovery is the spine's ack-based redelivery, which only covers
  `blockProcessorWhile`-shaped work. They must not start droppable attempts
  whose outcome matters — route such obligations to a DO-hosted processor.

## Testing: every failure above is a few lines of plain node

The harness (`createProcessorHostHarness` in
`apps/os/src/domains/streams/test-helpers.ts`) boots the REAL host and REAL
processors over fake substrates: an in-memory journal, a fake
`DurableObjectState`, a mutable virtual clock, and eviction as an operator.

```ts
const h = createProcessorHostHarness({
  build: (host, ctx) => ({
    agent: host.add(
      (deps) =>
        new AgentProcessor({
          ...deps,
          now: () => ctx.clock.now,
          // incarnation 1 hangs (the request the deploy kills); incarnation 2 answers
          ai: {
            run: async () =>
              ctx.incarnation === 1 ? new Promise(() => {}) : { response: "recovered!" },
          },
        }),
    ),
  }),
});

await h.stream.append(userMessage("hello?"));
await h.stream.waitForEvent({ eventTypes: [llmRequestStarted], timeoutMs: 5000 });
h.crash(); // THE DEPLOY: memory dies; journal, checkpoints, alarm survive
await h.advance(15_000); // the alarm fires; the real revival pass runs
await h.stream.waitForEvent({ eventTypes: [outputAdded], timeoutMs: 5000 });
```

The rules that keep these tests honest:

- **Runtime state comes from lifecycle, never field injection.** An empty
  live-set IS "crashed mid-attempt" — produced by `h.crash()`. An in-flight
  attempt IS "vendor hasn't answered" — produced by a hanging vendor fake.
  Every state a test exercises is thereby a _reachable_ state, and the test
  doubles as the existence proof. If you cannot reach a state through the
  dials, that is the finding.
- **The journal is the assertion surface.** The doctrine forces every
  consequential outcome to be an event, so asserting on `h.stream.events` is
  complete. The only observables outside it: `h.store.alarm.at` (what's
  armed) and the keepalive KV record — the deliberately-below-the-fold layer.
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
`stream-processor-host.test.ts`):

1. eviction mid-attempt → revival settles it and the domain retries/reports;
2. eviction before any attempt → provably-never-ran work starts late (or
   expires);
3. expired obligation → settled without the vendor ever being dialed;
4. full-journal refold → completions dedupe, nothing re-executes (the refold
   test above — required for every processor that touches a vendor);
5. the crash-loop breaker engaging on your processor's poison shape;
6. a failed started-append → nothing runs, nothing settles, the live-set is
   released, and a later batch retries the whole attempt.

## Checklist for a new processor

- [ ] Every `runInBackground` answers "what recovers the outcome?"
- [ ] Obligations: requested/started/completed events; fold carries what an
      attempt needs; terminal events delete the entry.
- [ ] End-of-batch reconciler: start undriven fresh work, settle orphans and
      expired intent, idempotency keys shared with the normal path.
- [ ] `expiresAt` stamped by the requester; reconciler honors it (and the
      `createdAt + DEFAULT` fallback covers raw appends).
- [ ] A failed started-append never settles and never leaks the live-set.
- [ ] Injected `now` dep for anything clock-dependent.
- [ ] Every vendor side effect is one of the three refold-safe shapes:
      idempotency-keyed append, at-head fold reconciliation, or
      freshness-gated ack — never guarded by event-time state alone.
- [ ] The refold test: a fresh instance fed the full journal re-executes no
      vendor work, appends nothing new, and converges to the same state.
- [ ] Hosting DO wires `alarm()` (and alarm slices if it schedules).
- [ ] Harness scenarios 1–6 above.
