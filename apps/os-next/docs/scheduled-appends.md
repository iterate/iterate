# Scheduled appends

A userspace facet can ask its context to append durable events in the future. The context shares
its one native alarm between schedules, subscription delivery and idle cleanup. The facet consumes
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
  allowed. The delivery self-wake breaker does not suppress explicitly scheduled work.
- Each alarm processes at most 32 due definitions, ordered by deadline then defining offset.
  The alarm coordinator reconciles once against the final batch state and other requested deadlines.
  Replacement or cancellation can leave one obsolete early wake, which rechecks durable state.
  Cold startup restores the stored physical alarm before appending wake events, so startup delivery
  bookkeeping cannot postpone the alarm that woke the context.

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
  versioned cancellation, processor intent, pause/resume, validation, disconnection past idle cleanup,
  two facet instances sharing a local key, recurring events, idempotent receipts after completion, and cancellation using inspection rows.
- `e2e/support/scheduled-append-facet.ts`: complete userspace sources with no alarm handler or native
  alarm storage. `start(job, when)` supports both deadlines and intervals; `finish(receipt)` cancels.
- `__workers-tests__/scheduled-appends.test.ts`: eviction, duplicate alarms, paused recovery,
  atomic refusal, bounded batches, coalesced intervals, parked interval failures, post-commit effect
  failures, and preservation of existing physical alarms during cold startup.
- `src/stream/scheduled-appends.test.ts`: replay, deadline reconstruction, breaker independence,
  relative timestamp anchoring, interval replacement, recurrence identity, validation and transactional limits.

```sh
pnpm --dir apps/os-next test scheduled-appends
pnpm --dir apps/os-next e2e e2e/scheduled-appends.e2e.test.ts
```

The isolated `preview_2` API/MCP deployment uses `os-next-preview-2.iterate-dev-preview.workers.dev`,
its own D1/KV/DO state and the `project-worker/preview_2` Doppler config. It has no project-host
routes. Deploy with `pnpm --dir apps/os-next run deploy --env preview_2`.
