# Scheduled appends

A userspace facet can ask its context to append durable events in the future. The context shares
its one native alarm between schedules, subscription delivery and hosted processors' claims. The facet consumes
scheduled events through its ordinary processor, including after disconnection and eviction.

```ts
const itx = await this.env.ITX.get();
try {
  const receipt = await itx.schedules.set({
    key: [this.ctx.props.name, "invoice-123"],
    when: { afterMs: 30_000 },
    events: [
      { type: "invoice/reminder-due", payload: { invoiceId: "123", attempt: 1 } },
      { type: "invoice/reminder-audit", payload: { invoiceId: "123", attempt: 1 } },
    ],
  });
  // Save this plain { key, scheduledAtOffset } receipt with the operation's state.
  // If work finishes first, cancel this definition; a replacement owns a new offset.
  await itx.schedules.cancel(receipt);
} finally {
  itx[Symbol.dispose](); // Disconnecting leaves pending schedules intact.
}
```

## API

- `set({ key, when, events }, { idempotencyKey? }?)` creates or replaces a schedule and returns
  `{ key, scheduledAtOffset }`. Without an idempotency key, each call replaces the definition.
  With one, an identical request returns the original receipt even after completion or cancellation.
- `key` is a string or `[scope, localKey]`. Facets can use their instance name as the scope;
  instances of the same class then have independent timers. Pairs normalize to a JSON string in
  the log and receipt. Scope is naming, not access control. The normalized key is at most 200 characters.
- `when` has exactly one field: `{ at: "2030-01-01T09:00:00Z" }`, `{ afterMs: 30_000 }`, or
  `{ everyMs: 60_000 }`. Relative delays resolve against the durable definition's `createdAt`,
  so replay and idempotent requests retain the deadline. Delays are integer milliseconds from
  zero to 365 days; intervals are from one second to 365 days. Absolute instants require a timezone.
- `cancel(receipt)` cancels that version only; an inspection row from `get` or `list` also works. `cancel(key)` cancels whichever definition currently
  owns the key. Receipts belong to the context where they were created.
- `get(key)` returns the current definition or null. `list()` returns pending and failed definitions.
  Each row includes `nextAt`, the next intended occurrence time, and `scheduledAtOffset`.
- Schedules target their own context. To schedule in another context, use `itx.cd(path).schedules`.

For recurring work, the first tick is one interval after definition. The cadence remains anchored
there. Missed ticks **coalesce**: after a gap the context appends one occurrence for the outstanding
`nextAt`, then advances to the first cadence tick after the completion time. There is no catch-up
burst, cron parser, automatic retry or backoff. Cancel the receipt to stop the interval.

A processor can emit the scheduling event directly, in the same append transaction as business
facts. Include the scheduling event in its contract's `emits`:

```ts
processEvent({ event, append, blockProcessorWhile }) {
  if (event?.type !== "invoice/opened") return;
  blockProcessorWhile(() => append({
    type: "events.iterate.com/stream/append-scheduled",
    idempotencyKey: this.idempotencyKey("reminder", event),
    payload: {
      key: `invoice:${event.payload.invoiceId}`,
      when: { afterMs: 60_000 },
      events: [{ type: "invoice/reminder-due", payload: { invoiceId: event.payload.invoiceId } }],
    },
  }));
}
```

Here the delay starts when the scheduling intent commits. For a deadline relative to an earlier
business event, use `at: new Date(Date.parse(event.createdAt) + delayMs).toISOString()` instead.

## Delivery and failure semantics

- Execution can be late but never intentionally early. Past deadlines are immediately eligible.
  Payload events receive their offsets and `createdAt` when they actually append.
- The batch and `…/append-schedule-completed` commit atomically. For an interval, that same
  transaction advances `nextAt`. A duplicate alarm cannot repeat a committed occurrence.
  `source.schedule` identifies it by key, defining offset and intended `at`; `definedBy` records
  the definition's processor/principal. Downstream external effects retain their own idempotency needs.
- Cancellation cannot retract an event already appended, including one still waiting for its
  processor. Include the operation's generation or attempt in timeout payloads; the reducer should
  ignore a timeout when that operation has finished or its generation has changed.
- A refused batch commits no prefix. It records `…/append-schedule-failed` and stays inspectable
  with its error and failure offset. Intervals also stop on failure. Replace or cancel explicitly.
  Failure to persist the failure itself throws to the platform's existing bounded alarm recovery.
- Pause holds scheduled work without repeatedly arming it. Resume makes overdue work eligible;
  intervals coalesce the paused gap. Setting a definition is refused while paused, cancellation is
  allowed.
- Each alarm processes at most 32 due definitions, ordered by deadline then defining offset, and
  arms the next deadline once, when the pass completes (see below). A replacement or cancellation
  moves the alarm in its own commit.

## The one alarm

A context has one native alarm, and only a DURABLE OBLIGATION wants it — something a fresh
incarnation would find and owe again: a schedule, or a claim ("come back by T") held for a cursor
row or a hosted processor. None is stored as an alarm request: each source answers "when next?"
from state it already keeps, and `AlarmCoordinator` (`src/alarm-coordinator.ts`) arms the earliest
answer or deletes the alarm when there is none. Reconciliation runs after every commit, every claim
and every delivery change. Pins — a borrowed rpc stub, the library's open capnweb socket, the two
things that keep an actor resident on the edge — are memory, and memory releases them: a 30 s timer
after the pin's last use returns the stubs and closes the sockets (`#pinUsed`). Nothing in memory
is ever a reason to wake.

| Source                | Its deadline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled appends     | the earliest pending `nextAt` in core state (none while paused or when every definition is parked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Subscription delivery | per cursor row (a target that, through the rules, resolves to neither a facet nor a lent rpc stub — decided statically, never by evaluating it): EXACTLY the time its persisted cursor carries — written the instant its loop starts on a row behind the durable mark, inside the commit's own hook ("an attempt begins: come back by now + 20 s", the attempt counted; fifteen without an ack or a failure halt the row), written by the retry ladder as the rung, cleared by the ack, spent when the loop finds nothing owed or a target nothing resolves; a halted row owes nothing |
| Hosted processors     | per facet row: the claim its engine holds while a `runInBackground` attempt is in flight (`processors.claim`, a kv row: "revive me by T", 20 s out); the pass spends a due claim and calls the facet's `revive()` — catch up, run the at-head pass — and an attempt still in flight claims again, later each time (40 s, 80 s, … 30 min), so a hung attempt costs a few wakes an hour and a settled one releases the claim                                                                                                                                                             |

A wake makes no loop: `stream/woken` is a durable event like any other, and every `*` subscription
receives it (`consumesEvent`, the one consumes rule, has no carve-out). What keeps it from looping is
that delivering it creates no reason to wake again: the config row's delivery is claimed only while
owed and acked at once; a request — a loaded worker's `env.ITX` loopback included — claims
nothing. The alarm handler records the wake itself
(`stream/woken { reason: "alarm" }`, inside its pass — workerd hides a firing alarm from `getAlarm()`
for the whole run, so no constructor can tell; every other door records `"request"`), and its
delivery acks within the pass, so an alarm wake that finds nothing else owed writes no alarm at all.
A facet is not a pin. On the edge a live facet does not keep an actor resident — it hibernates within
seconds like any other, and the facet dies with it — so nothing arms an alarm for a facet: such an
alarm could only construct the next incarnation, whose wake record would materialize the facet again,
a wake per quiet period. A `*` processor facet therefore costs a wake nothing beyond its own
materialization. Only a borrowed rpc stub or an open capnweb socket (measured: both keep the actor
resident; an HTTP client does not) is ever released, by a 30 s timer after its last use — no alarm.
Where the runtime does keep a facet-hosting actor resident (workerd's harness) a test releases the
facets too, through the DO-only door (`releasePins`).

One hold keeps the alarm from being moved under a handler: nothing is written while `alarm()` runs —
its alarm stays stored, so a pass that throws is retried by the runtime (2s·2ⁿ, six tries), and a
completed pass sets the next deadline once. The alarm read at construction is only the dedupe seed:
every reason is derived again by the constructor's first reconcile — a due schedule or claim derives
the same time (no write). No past delivery claim leaves a pass: a pass joins and awaits every loop
it finds running, and a row an unreadable event stops is halted. There is no clamp (the
runtime clamps a past time to now and refuses one at or before the epoch, which schedule validation
rejects) and no keep-earlier rule; every `setAlarm` is a billed write, so the only dedupe is "the
wanted time is what we last wrote".

Every alarm pass is traced as ephemeral `events.iterate.com/stream/trace/alarm` events whose
payload is an `AlarmTrace` (`src/iterate-context-durable-object.ts`): `alarm-fired` with what was
armed and every deadline the pass found (each source's, with the claiming delivery rows and
processors), `alarm-pass` with what it armed next or `alarm-abandoned` with what it threw — plus
the durable head and what is pinned. Only a pass traces:
a reconcile outside one consumes no offset. `waitForEvent({ type })`
sees a trace live; `itx.readEvents(afterOffset, limit, { includeEphemeral: true })` reads it back
afterwards, merged in offset order with the durable rows — the stream keeps the current
incarnation's ephemerals of every kind (live-state deltas, rpc-stub presence, traces) in a ring of
`APP_CONFIG_RECENT_EPHEMERALS_BUDGET_CHARS` serialized characters, 1 MiB by default. The page's
proof stays the log's: `scannedThroughOffset` never names an ephemeral, and an ephemeral past the
durable mark comes back on every at-head read until a durable takes the head or the ring evicts it.
A trace is never subscription input and never activity, so observing a context cannot keep it
awake. The durable `stream/woken { incarnation, reason }` says what woke each incarnation:
`"alarm"` when the alarm handler was the first door to open, `"request"` otherwise.

## Bounds

A definition contains 1–100 durable event bodies (`type`, optional JSON `payload` and `metadata`),
with no explicit identity, source, offset or ephemeral flag. Nested scheduling and runtime lifecycle
controls are refused. Each definition is limited to 65,536 serialized JS characters, with at most
100 pending/failed definitions and 1,048,576 serialized characters in the definition projection per
context. Capacity is checked when definitions are added or replaced; interval ticks skip the redundant budget scan.
Failure diagnostics have a separate 2,000-character cap. Completed one-shots and cancelled
schedules leave the projection; history remains in the log.

## Executable examples

- `e2e/scheduled-appends.e2e.test.ts`: eleven deployed tests covering facet timeout batches, replacement,
  versioned cancellation, processor intent, pause/resume, validation, disconnection past the pins' release,
  two facet instances sharing a local key, recurring events, idempotent receipts after completion, and cancellation using inspection rows.
- `e2e/support/scheduled-append-facet.ts`: complete userspace sources with no alarm handler or native
  alarm storage. `start(job, when)` supports both deadlines and intervals; `finish(receipt)` cancels.
- `__workers-tests__/scheduled-appends.test.ts`: eviction, duplicate alarms, paused recovery,
  atomic refusal, bounded batches, coalesced intervals, parked interval failures, post-commit effect
  failures (the abandoned pass leaves its alarm stored), and preservation of existing physical
  alarms during cold startup. `__workers-tests__/alarm-quiesce.test.ts`: a bare probe leaves no
  alarm; an observed pass yields one ephemeral trace and a ring holding the whole pass.
- `src/stream/scheduled-appends.test.ts`: replay, deadline reconstruction, the pass holding its
  alarm, relative timestamp anchoring, interval replacement, recurrence identity, validation and
  transactional limits. `src/alarm-coordinator.test.ts`: the earliest deadline, the dedupe seed, the
  one hold, a pass that throws. `src/stream/subscription-delivery.test.ts`: the loop's claim on the
  alarm (`deadlines()`) — behind vs caught up, a call in flight, a facet row never, the claim written
  before a call surviving an eviction — and the wake record acked without a loop.

```sh
pnpm --dir apps/os-next test scheduled-appends
pnpm --dir apps/os-next e2e e2e/scheduled-appends.e2e.test.ts
```

The isolated `preview_2` API/MCP deployment uses `os-next-preview-2.iterate-dev-preview.workers.dev`,
its own D1/KV/DO state and the `project-worker/preview_2` Doppler config. It has no project-host
routes. Deploy with `pnpm --dir apps/os-next run deploy --env preview_2`.
