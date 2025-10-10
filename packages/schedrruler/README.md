# @iterate-com/schedrruler

Schedrruler is an experimental Durable Object that manages recurring jobs defined by RFC 5545 RRULE strings. It persists an append-only
history of lifecycle events and invocation results, tracks the next time each rule should run, and keeps only a single Durable Object alarm
armed for the earliest upcoming execution.

## Features

- **Append-only history** – every lifecycle change and invocation result is stored in a SQLite table for easy replay and auditing.
- **RRULE-driven scheduling** – recurring schedules are parsed with [`rrule`](https://github.com/jakubroztocil/rrule) so any standard
  `FREQ=...` rule works.
- **At-least-once delivery** – alarms advance after a successful run; failures are recorded and retried so no execution is silently
  dropped.
- **Manual invocations** – trigger a rule immediately by POSTing an `invoke` event with `mode: "manual"`.

## Endpoints

All HTTP methods are served by the Durable Object itself. The worker in [`worker.ts`](./worker.ts) simply instantiates the object and also
provides a tiny HTML console for quick experimentation.

- `POST /events` – accepts a single event or an array of events. Unsupported or invalid payloads are logged and ignored.
- `GET /events?limit=100` – returns the most recent persisted events in reverse chronological order.
- `GET /` – returns active rules with their cached next execution time.

## Testing

Run the Vitest suite with:

```bash
pnpm --filter @iterate-com/schedrruler test
```

The tests execute inside Cloudflare's workerd runtime via `@cloudflare/vitest-pool-workers`. Use `runDurableObjectAlarm(stub)` to flush
scheduled alarms during a test.
