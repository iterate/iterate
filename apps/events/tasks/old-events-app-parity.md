---
state: todo
priority: high
size: medium
dependsOn:
  - subscriptions.md
---

# Legacy events app parity

This task inventories functionality from the **previous** events app and contract (removed from the tree; use git history) that the **current** [`apps/events`](../) and [`apps/events-contract`](../../events-contract) should either:

- carry forward directly
- redesign but keep semantically
- explicitly decide to drop

The highest-priority parity work is the **public contract and data-model surface**. That is the part most likely to leak into tests, examples, and other apps.

## Source of truth to compare

Historical paths (no longer in the repo):

- Old contract: former `apps/events-contract/src/index.ts`
- Old router/runtime surface: former `apps/events/src/orpc/root.ts`
- Old browser client: former `apps/events/src/orpc/client.ts`
- Old UI behavior: former `apps/events/src/components/stream-inspector.tsx`
- Old runtime/test expectations: former `apps/events/runtime-smoke.test.ts`

## Already covered in the rewrite

These old ideas already exist in the current app, even if the exact implementation changed:

- append-only streams
- live stream reads
- stream metadata as an event (`STREAM_METADATA_UPDATED_TYPE`)
- implicit stream creation on first append
- a reduced per-stream state projection via `getState`
- discovery of child streams via `STREAM_CREATED_TYPE`

This task is about the remaining gaps.

## Contract and data-structure parity

- [ ] Bring back a first-class distinction between append input and stored event output. Old `events-contract` had `BaseEvent` / `EventStreamEventInput` for writes and `StoredEvent` / `EventStreamEvent` for persisted reads. `apps/events-contract` currently exposes `EventInput` and `Event`, but the public surface is thinner and less reusable.
- [ ] Decide whether `version` should still be part of the public event model. Old `events-contract` accepted `version` on append input and returned it on stored events. The current contract currently omits it.
- [ ] Decide whether trace metadata should still be part of the public event model. Old `StoredEvent` / `EventStreamEvent` included `trace: { traceId, spanId, parentSpanId }`. The current contract currently has no trace field at all.
- [ ] Restore a richer stream summary shape or explicitly retire it. Old `listStreams` returned `EventStreamSummary` with `path`, `createdAt`, `eventCount`, `lastEventCreatedAt`, and `metadata`. The current app only returns `{ path, createdAt }`, which loses sidebar-ready counts, recency, and metadata.
- [ ] Port or replace the old typed-event helper surface. Old `events-contract` exported `typedEvent(...)` plus reusable control-event payload types. The current contract has constants and payload schemas, but not the same helper ergonomics.
- [ ] Carry over parse helpers for control events where they still make sense. Old contract exported `parsePushSubscriptionCallbackAddedPayload` and `parseStreamMetadataUpdatedPayload`. This app should either offer equivalent helpers or make the intended parsing pattern explicit in docs/tests.
- [ ] Review whether `EventsAppEnv`-style public env/schema helpers still matter. Old `events-contract` exported env parsing for app consumers/tests. The app currently keeps env shape local.

## Subscription parity

The legacy app had real public subscription vocabulary, even though the implementation model is changing.

- [ ] Preserve the old semantic surface for registering subscriptions. Old router exposed `registerSubscription`, backed by `PushSubscriptionCallbackAddedPayload` and `PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE`.
- [ ] Preserve the old semantic surface for acknowledging delivery offsets. Old router exposed `ackOffset(path, subscriptionSlug, offset)`.
- [ ] Fold the old payload shapes into the new design in `tasks/subscriptions.md` instead of dropping them by accident. Important old shapes include:
- [ ] `CallbackURL`
- [ ] `PushSubscriptionRetrySchedule`
- [ ] `PushSubscriptionRetryPolicy`
- [ ] `PushSubscriptionCallbackAddedPayload`
- [ ] Decide whether JSONata filter/transform support remains part of the contract. Old payloads supported `jsonataFilter` and `jsonataTransform`.
- [ ] Decide whether transport kinds from the old contract should survive verbatim or map into the new tagged-union design. Old values were `webhook`, `webhook-with-ack`, `websocket`, and `websocket-with-ack`.
- [ ] Decide whether `sendHistoricEventsFromOffset` remains part of subscription registration.

## API/runtime parity

- [ ] Add `firehose` back, or explicitly document that it is intentionally removed. Old app exposed a cross-stream live iterator at `firehose`, had a dedicated `/firehose` page, and tested it in `runtime-smoke.test.ts`.
- [ ] Reintroduce optional WebSocket transport if it is still part of the product story. Old app exposed `/orpc/ws`, shipped `createStreamsWebSocketClient()`, and let the UI switch between WebSocket and SSE/live iterator behavior.
- [ ] Decide whether `append` response semantics should stay different. Old `append` returned `204` and no body. The current app returns `{ created, events }`. If the change is intentional, document it and update examples/specs accordingly.
- [ ] Revisit `listStreams` implementation behavior. Old runtime listed actual stream summaries from storage. The current app reconstructs discovery from root-stream `STREAM_CREATED` events, which is elegant but does not recreate counts, recency, or metadata summaries.
- [ ] Check whether old path/URL compatibility matters for existing consumers. Old contract used `/firehose`, `/streams/{+path}`, `/streams/{+path}/subscriptions`, `/streams/{+path}/subscriptions/{subscriptionSlug}/ack`, and `/orpc/ws`.

## UI parity from the old app

- [ ] Decide whether the old firehose page should exist in this app.
- [ ] Decide whether the old transport selector should exist in this app.
- [ ] Restore or replace the old sidebar summary affordances that depended on `EventStreamSummary`: event counts, last-event recency, and metadata-aware search.
- [ ] Decide whether the old "single inspector with stream + firehose modes" should survive, or whether the new split `streams` UI is the intentional replacement.

## Tests to carry forward

- [ ] Copy the old API-surface assertions from the former `apps/events/runtime-smoke.test.ts` into appropriate e2e coverage here.
- [ ] Add explicit parity tests for any restored contract fields such as `version`, `trace`, richer stream summaries, or subscription payload parsing.
- [ ] If `firehose` returns, add end-to-end coverage for cross-stream live delivery.
- [ ] If WebSocket transport returns, add end-to-end coverage for `/orpc/ws` behavior.

## Explicit non-goals

These are legacy implementation details from the previous `apps/events` that should not automatically be treated as parity requirements:

- the Effect-based runtime in `apps/events/effect-stream-manager/*`
- the Node/SQLite server shape from the old app
- the old Cloudflare worker fallback that threw "Streams are not available in the Cloudflare Worker runtime."

Those are implementation details of the old app, not product requirements. The parity target is the **behavior and contract surface**, not the old architecture.
