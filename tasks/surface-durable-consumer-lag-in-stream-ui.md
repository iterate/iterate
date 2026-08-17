---
state: todo
priority: high
size: small
dependsOn: []
tags: [os, streams, observability, ui]
---

# Surface durable consumer lag while a stream is open

## Problem

The Stream state sheet already polls `stream.runtimeState()` once per second
while open. It shows each durable subscription—including
`itx.integrations.posthog.processEventBatch()`—with its acknowledged offset,
`maxOffset - ackedOffset` lag, retry state, last error, and parked offset.

That health is hidden until an operator opens the sheet. Merely opening a
stream does not fetch or persistently surface durable-consumer health, so a
PostHog delivery that is behind, retrying, or parked can coexist with a
healthy-looking stream header.

## Minimal change

While a stream page is open, fetch the same authoritative runtime state at a
bounded cadence and surface one compact header warning:

- amber for persistent or growing non-zero durable lag;
- red for an active retry, last delivery error, or parked subscription;
- show the subscription label and `+N events` behind (add oldest-undelivered
  age if the runtime contract can provide it without a second data path); and
- clicking the warning opens Stream state focused on the affected subscriber.

Do not invent a second lag calculation or analytics store. Reuse
`runtime.subscriptions`, where lag already means `maxOffset - ackedOffset`, and
make query failure visible rather than presenting stale state as healthy.

## Acceptance

- A caught-up durable subscription adds no warning.
- Brief in-flight lag does not flicker as an incident; persistent/growing lag
  does.
- Retry, parked, and last-error states are visible without opening Stream
  state first.
- The first-party PostHog subscription is named intelligibly in the warning.
- Clicking the warning focuses the corresponding Stream state row.
- Tests cover caught-up, transient lag, persistent lag, retry/error, parked,
  and runtime-query failure states.

## Existing path to reuse

- `apps/os/src/components/stream-state-panel.tsx`
- `apps/os/src/components/stream-view-header.tsx`
- `apps/os/src/components/project-stream-view.tsx`
- `apps/os/src/domains/streams/stream-event-sender.ts`
