# @iterate-com/schedrruler

Schedrruler is an experimental Durable Object that manages scheduling **directives**—instructions describing when a method should run.
Each directive can be powered by an RFC 5545 RRULE, a cron expression, or a one-off "once" timestamp. The object persists an append-only
history of lifecycle events and invocation results, tracks the next time each directive should run, and keeps only a single Durable Object alarm
armed for the earliest upcoming execution.

## Features

- **Append-only history** – every lifecycle change and invocation result is stored in a SQLite table for easy replay and auditing.
- **Pluggable instructions** – directives understand RRULE strings, cron expressions (via [`cron-parser`](https://github.com/harrisiirak/cron-parser)),
  and single-fire "once" timestamps. Additional instruction kinds can be added without changing the persistence model.
- **At-least-once delivery** – alarms advance after a successful run; failures are recorded and retried so no execution is silently
  dropped.
- **Manual invocations** – trigger a directive immediately by POSTing an `invoke` event with `mode: "manual"`.

## Endpoints

All HTTP methods are served by the Durable Object itself. The worker in [`worker.ts`](./worker.ts) simply instantiates the object and also
provides a tiny HTML console for quick experimentation.

- `POST /events` – accepts a single event or an array of events. Unsupported or invalid payloads (including directives with unparseable instructions)
  are logged and ignored.
- `GET /events?limit=100` – returns the most recent persisted events in reverse chronological order.
- `GET /` – returns active directives with their cached next execution time and raw instruction payload.

## Testing

Run the Vitest suite with:

```bash
pnpm --filter @iterate-com/schedrruler test
```

The tests execute inside Cloudflare's workerd runtime via `@cloudflare/vitest-pool-workers`. Use `runDurableObjectAlarm(stub)` to flush
scheduled alarms during a test.
