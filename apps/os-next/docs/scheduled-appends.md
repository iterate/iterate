# Scheduled appends

A userspace facet cannot define a native Durable Object alarm. It can instead ask its context to
append a durable batch at or after a deadline. The context multiplexes these deadlines with
subscription recovery and idle cleanup on its one platform alarm. A processor consumes the result
through its ordinary event subscription, including after its facet is evicted and rebuilt.

```ts
const itx = await this.env.ITX.get();
try {
  const [definition] = await itx.schedules.set({
    key: "deadline:invoice-123",
    when: { at: "2030-01-01T09:00:00Z" },
    events: [
      { type: "invoice/reminder-due", payload: { invoiceId: "123" } },
      { type: "invoice/reminder-audit", payload: { invoiceId: "123" } },
    ],
  });
  // If work finishes first, cancel only this definition (a replacement owns a new offset).
  await itx.schedules.cancel("deadline:invoice-123", definition.offset);
} finally {
  itx[Symbol.dispose]();
}
```

`set` appends `events.iterate.com/stream/append-scheduled` with the input as its payload. A processor
can emit that event directly, using its normal `append` and a stable idempotency key:

```ts
processEvent({ event, append, blockProcessorWhile }) {
  if (event?.type !== "invoice/opened") return;
  blockProcessorWhile(() => append({
    type: "events.iterate.com/stream/append-scheduled",
    idempotencyKey: this.idempotencyKey("reminder", event),
    payload: {
      key: `invoice:${event.payload.invoiceId}`,
      when: { at: new Date(Date.parse(event.createdAt) + 60_000).toISOString() },
      events: [{ type: "invoice/reminder-due", payload: { invoiceId: event.payload.invoiceId } }],
    },
  }));
}
```

The processor must include the scheduling event in its contract's `emits`. Anchor relative delays
to the triggering event's `createdAt`, so retrying processing uses the same definition and deadline.
A schedule can be appended in the same transaction as any other business events. `set` itself is
an upsert, not an idempotent request: each call replaces the key. Use a keyed raw event when request
retries must retain the original definition.

## Contract

- One-shot, same-context batches only. To target another context, schedule through `itx.cd(path)`.
  Intervals, cron and arbitrary callbacks are outside this MVP.
- `when.at` is an ISO instant with a timezone. Past instants are due immediately; execution can be
  late but never intentionally early. Offsets and `createdAt` are assigned at the actual append.
- `events` contains 1–100 durable event bodies (`type`, optional JSON `payload` and `metadata`).
  Identity, source, explicit offsets and ephemeral flags are not accepted inside a definition.
  Nested scheduling control events are refused. A definition is limited to 64 KiB in serialized JS
  characters, with at most 100 retained pending/failed definitions per context.
- `get(key)` returns the current definition or null. `list()` returns all pending/failed definitions.
  The defining event's offset is `scheduledAtOffset`.
- `cancel(key, ifScheduledAtOffset?)` appends `…/append-schedule-cancelled`. Omit the offset to cancel
  whatever currently owns the key. Cancellation is allowed while the stream is paused.
- The whole occurrence and `…/append-schedule-completed` commit in one SQLite transaction. Duplicate
  alarm delivery cannot append it again. The payload events carry `source.schedule` with the key,
  defining offset and intended time, plus the definition's provenance. Downstream external effects
  still require the consumer's own idempotency.
- Pause retains due work without repeatedly arming its deadline; resume rearms it. Normal delivery
  recovery may still have its own bounded alarms. The delivery self-wake breaker cannot suppress
  explicit scheduled work.
- A refused occurrence commits no prefix. It records `…/append-schedule-failed` and stays inspectable
  with a `failure` containing the error and failure offset. Replace or cancel it explicitly. A
  failure to persist the failure itself throws to Cloudflare's bounded alarm retry mechanism.
- Each alarm processes at most 32 due definitions in deadline/defining-offset order, then rearms for
  remaining work. Completed/cancelled definitions leave the projection; their history stays in the log.
  Replacement or cancellation can leave one already-armed early wake, which rechecks durable state.

## Executable examples and verification

- `e2e/scheduled-appends.e2e.test.ts`: a real userspace facet schedules and consumes a two-event timeout;
  independent keyed deadlines, cancellation on completion, and stale cancellation after replacement.
- `e2e/support/scheduled-append-facet.ts`: the complete facet source used by those examples. It has no
  alarm handler and never accesses native alarm storage.
- `__workers-tests__/scheduled-appends.test.ts`: quiesce/evict/fire, duplicate delivery, paused recovery,
  and an injected transaction failure alongside an independent healthy schedule.
- `src/stream/scheduled-appends.test.ts`: pure replay, deadline preservation after reconstruction,
  breaker independence, validation, capacity and transaction rollback.

```sh
pnpm --dir apps/os-next e2e e2e/scheduled-appends.e2e.test.ts
pnpm --dir apps/os-next test scheduled-appends
```

The isolated `preview_2` deployment uses `os-next-preview-2.iterate-dev-preview.workers.dev`, its own
D1/KV/DO state and the `project-worker/preview_2` Doppler config. It serves the API and MCP on
workers.dev; it has no project-host routes. Deploy with `pnpm --dir apps/os-next run deploy --env preview_2`.
