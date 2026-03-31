---
state: done
priority: high
size: medium
dependsOn:
  - subscriptions.md
---

# Subscription scheduler cleanup

This task is a follow-up to the current webhook subscription implementation.

The goal is not to change product behavior. The goal is to make the code easier
to read, reduce exported/internal surface area, cut duplication, and explain the
important Durable Object fences where a reader will actually need them.

## Summary

The current implementation works and the local network suite is green, but it
still has too much internal machinery in the shared contract, too much important
setup ahead of the main `StreamDurableObject` class, and too much duplicated
delivery-failure construction in `stream.ts`.

This cleanup should leave us with:

- a smaller public contract
- a clearer `stream.ts` with the core architecture visible near the top
- fewer exports that exist only for tests
- less duplicated e2e schema/helper code
- stronger race coverage

## Implementation changes

### 1. Shrink the shared contract

Keep these in `apps/events-contract/src/index.ts`:

- subscription event type constants
- `SubscriptionSetPayload`
- `SubscriptionRemovedPayload`

Move these out of the shared contract and into `apps/events/src/durable-objects/stream.ts`:

- `SubscriptionDeliverySucceededPayload`
- `SubscriptionDeliveryFailedPayload`
- `SubscriptionCursorUpdatedPayload`
- local cursor/error schemas that only exist to support those payloads

Rationale:

- `deliveryRevision`
- `observedLastOffset`
- `reason: "caught-up"`

are internal DO/reducer mechanics, not stable external API.

### 2. Reorder and explain `stream.ts`

Keep the implementation in `apps/events/src/durable-objects/stream.ts`, but
restructure the file so the main thing is at the top.

Required shape:

1. short file docstring stating the two key invariants:
   - raw history and SSE include internal subscription bookkeeping events
   - the server-managed webhook delivery loop must never deliver those events
2. `StreamDurableObject` class
3. reducer and state helpers
4. tiny utility helpers at the bottom

Inside the class, add short comments at the exact fences that matter:

- above `alarm()`:
  - alarm work is awaited
  - Cloudflare alarm retries are only for unexpected alarm-pass failure
  - link to first-party DO alarms docs
- above the reducer branches for delivery outcomes:
  - `deliveryRevision` rejects stale in-flight outcomes after rewind/remove
  - `observedLastOffset` re-arms delivery if the stream advanced during the attempt
- above the caught-up path:
  - `subscription.cursor-updated(reason: "caught-up")` exists so quiescing is
    event-sourced instead of hidden mutable state

Do not add large abstract commentary blocks elsewhere. Put the fence where the
reader hits it.

### 3. Cut duplication inside delivery handling

Refactor `deliverSubscriptionEvent()` inside `stream.ts` so it does not build
two near-identical `subscription.delivery-failed` events.

Add one tiny local helper at the bottom of the file:

- `makeDeliveryFailedEvent(...)`

It should own:

- slug
- delivery revision
- delivered offset
- observed last offset
- status/body/message
- retry count
- resulting cursor snapshot

Keep the success path inline.

This is the only new helper that should be introduced for code-size reasons.

### 4. Reduce exports and test-only surface

Keep only these exports from `stream.ts` for unit tests:

- `createEmptyStreamState`
- `reduceStreamState`
- `isInternalSubscriptionEventType`

Make these file-local again:

- `getRetryDelayMs`
- `computeNextRetryAt`
- `getNextAlarmAt`
- `getDeliverableEvents`

Update the unit tests so they no longer depend on those tiny exports directly.
Test them indirectly through reducer behavior or network behavior.

### 5. Simplify e2e helpers

Keep `apps/events/e2e/helpers.ts`, but reduce its scope.

Required changes:

- stop mirroring the full reduced-state schema there
- parse only the minimum JSON slices each helper actually needs
- keep `createEventsE2eFixture()` for app/client/path/event helpers
- keep `useWebhookSink()` for webhook capture
- keep `collectAsyncIterableUntilIdle()`

Do not split this into more files unless that clearly reduces code. The goal is
less drift and less duplicated schema, not a new helper tree.

### 6. Add the missing race tests

Add these network e2e tests:

- `subscription.removed` during an in-flight delivery:
  - first webhook request starts and is held open
  - `subscription.removed` is appended
  - the held request is released
  - final reduced state has no subscription entry
  - no stale outcome resurrects or mutates the removed subscription

- hung or timed-out subscriber does not block a healthy subscriber:
  - one subscription points at a sink that never resolves or times out
  - another subscription points at a healthy sink
  - both become due
  - the healthy sink still receives its delivery
  - the unhealthy sink records a normal failure path and retry scheduling

- explicit loop-filter assertion for `subscription.cursor-updated`:
  - verify this newest internal event type is also never delivered to webhook consumers

Keep these in the existing `subscriptions.e2e.test.ts` / `subscriptions.edge-cases.e2e.test.ts`
files unless a new file would obviously be clearer.

## Acceptance criteria

- `apps/events-contract` no longer exports internal delivery outcome/cursor payload schemas
- `stream.ts` still owns the implementation, but the core architecture is visible at the top
- `deliverSubscriptionEvent()` is shorter and no longer duplicates failure event construction
- test-only exports from `stream.ts` are reduced to the minimum
- `apps/events/e2e/helpers.ts` no longer duplicates the full reduced-state schema
- the three new race/loop tests exist and pass locally

## Verification

Run all of these after the cleanup:

- `pnpm --filter @iterate-com/events typecheck`
- `pnpm --filter @iterate-com/events test`
- local worker in tmux per `apps/events/e2e/AGENTS.md`
- `cd apps/events && EVENTS_BASE_URL=http://127.0.0.1:<port> pnpm vitest run --dir e2e/vitest`

## Notes

This cleanup should stay behavior-preserving. If any product semantics need to
change while implementing it, that should be discussed separately instead of
being bundled into the readability pass.
