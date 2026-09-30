# RPC providers and subscriptions: simplification audit

**Scope.** This is an audit of main at `cfd8a1d36`, limited to the event subscription delivery loop and the pager-backed live RPC-provider mechanism. It makes no code changes. `caller-passing` (`87e8e5574`, PR #3442 worktree) changes caller propagation and wake metadata only; it does not alter the provider/subscription transport seam described here.

## Conclusion

There are three delivery policies mixed into one 1,962-line class:

| Consumer contract                                         | Current implementation                                  | Durable state really needed                     |
| --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| A live provider receives a hint and repairs with `read`   | special `RpcStubHandle` branch in the subscription loop | hibernatable pager attachment; no stream cursor |
| A hosted facet owns a checkpoint and repairs from the log | special `FacetHandle` branch                            | facet checkpoint; no stream cursor              |
| A normal endpoint must acknowledge delivery               | cursor and fan-out engines                              | cursor / per-event record plus alarm claim      |

The first two have the same progress contract, while only the first is implemented as a reusable transport abstraction. The strongest safe reduction is to make the pager-backed live-provider protocol the explicit abstraction for all session-owned live targets, and make the subscription loop select a small delivery policy rather than inspect a concrete `RpcStubHandle`.

This does **not** argue for removing durable cursor delivery or fan-out. Those are the mechanism that preserves at-least-once delivery to arbitrary endpoints. It argues that the live path should stop re-implementing a second provider state machine in `SubscriptionDelivery`.

## Evidence: the same live-provider contract exists twice

The pager directory is already a hibernatable, lazily materialized provider registry.

- A stable opaque key is attached to a hibernatable WebSocket and rehydrates from its attachment: `RpcStubDirectory` stores no durable transport object ([rpc-stubs.ts:146](../../apps/os/src/context/rpc-stubs.ts#L146), [379-394](../../apps/os/src/context/rpc-stubs.ts#L379)).
- A call first borrows the provider, pages it if absent, and maps a missing or timed-out provider to `RPC_STUB_OFFLINE` ([220-253](../../apps/os/src/context/rpc-stubs.ts#L220), [397-443](../../apps/os/src/context/rpc-stubs.ts#L397)). Concurrent cold calls share the same page promise ([397-435](../../apps/os/src/context/rpc-stubs.ts#L397)).
- Borrowed transport is returned on the residency release, allowing the DO to hibernate ([255-265](../../apps/os/src/context/rpc-stubs.ts#L255)); the relay holds the session copy and supplies a fresh Workers RPC leg per page ([48-51](../../apps/os/src/context/rpc-stub-relay.ts#L48), [244-264](../../apps/os/src/context/rpc-stub-relay.ts#L244)).
- The relay already handles the hard conditions a subscription should not duplicate: redial after reset/drop, idempotent relend, client liveness probing, and coded offline outcomes ([126-175](../../apps/os/src/context/rpc-stub-relay.ts#L126), [236-270](../../apps/os/src/context/rpc-stub-relay.ts#L236), [312-390](../../apps/os/src/context/rpc-stub-relay.ts#L312)).

The subscription loop separately recognizes the same contract by runtime brand. `targetOwnsProgress` identifies both facets and RPC stubs only from rewrite-rule shape ([core-processor.ts:183-193](../../apps/os/src/stream/core-processor.ts#L183)); then `#pushEventBatch` branches on `head instanceof RpcStubHandle`, serializes the batch, applies a second delivery-owned memory budget, invokes the target, and treats `RPC_STUB_OFFLINE` as expected loss/recover-by-read ([subscription-delivery.ts:710-813](../../apps/os/src/stream/subscription-delivery.ts#L710)).

That branch is an implicit `LiveProvider.publish(events, range)` protocol. It is not represented in types, so its three core rules are scattered:

1. A live subscriber owns progress and has no stream cursor ([core-processor.ts:183-193](../../apps/os/src/stream/core-processor.ts#L183)).
2. Delivery is a best-effort hint, not an acknowledgement ([subscription-delivery.ts:727-758](../../apps/os/src/stream/subscription-delivery.ts#L727)).
3. `RPC_STUB_OFFLINE` means repair by log read rather than retry or halt ([subscription-delivery.ts:727-755](../../apps/os/src/stream/subscription-delivery.ts#L727)).

`ordered: false` and `afterOffset` also disappear for a live target ([core-processor.ts:276-284](../../apps/os/src/stream/core-processor.ts#L276)). That is a sign that `Subscription` currently exposes delivery-policy fields that are inapplicable to one of its target categories.

## Proposed layering

Introduce a narrow internal protocol; this is intentionally not a new public surface.

```ts
type DeliveryTarget =
  | { kind: "live"; publish(events: StreamEvent[], range: ScannedRange): Promise<void> }
  | { kind: "checkpointed"; push(events: StreamEvent[], range: ScannedRange): Promise<void> }
  | { kind: "acknowledged"; deliver(events: StreamEvent[], range: ScannedRange): Promise<void> };
```

The expression resolver should classify the _resolved head_ once into this protocol. The pager directory supplies the `live` adapter: it owns all borrow/page/return/reconnect/offline details. The facet host supplies the `checkpointed` adapter. Plain callable expressions become `acknowledged`. `SubscriptionDelivery` then has three small policy drivers:

1. **Live hint.** Reserve bounded notification memory, invoke `publish`, and discard an `OFFLINE` notification. There is no delivery cursor and no alarm.
2. **Checkpointed push.** Serialize pushes; on a dropped or timed-out push, request the facet's existing log catch-up. There is no delivery cursor.
3. **Acknowledged delivery.** Retain the current ordered-cursor and explicit fan-out implementations, because their durable acknowledgement is their product feature.

The existing `EvaluatedTargetHead` almost supplies this seam: it already memoizes the evaluated head, expiry, route, a batch call, and an event call ([subscription-delivery.ts:219-234](../../apps/os/src/stream/subscription-delivery.ts#L219), [931-999](../../apps/os/src/stream/subscription-delivery.ts#L931)). Replace `head` plus `call`/`deliverEvent` with the tagged target above. This removes the `instanceof RpcStubHandle` check and makes `targetOwnsProgress` a target classification, not rewrite syntax recognition.

The pager attach already atomically carries the events that establish the provider's route ([rpc-stubs.ts:269-321](../../apps/os/src/context/rpc-stubs.ts#L269)). Subscriptions should use the same attachment/reconnect path as `provide`: the attachment installs/refreshes the row, the socket's lifecycle establishes live availability, and the directory's close census removes the route. This is precisely the requested “subscription is the same live provider RPC stub mechanism” model.

### Staged implementation

1. Extract `LiveProvider` and `CheckpointedConsumer` adapters without moving behavior. Keep the existing pager wire format and `RpcStubHandle` public behavior. Make `#evaluateItxExpressionTargetHead` return a tagged target.
2. Replace the live `instanceof` branch with `kind === "live"`; move the serialized-char reservation/drop metric into a single `publishLiveHint` helper. Preserve its metric name during the migration.
3. Move rule-shape classification behind the adapter factory. Delete `targetOwnsProgress` only after all callers use the factory; keep `rowsPushingFacet` as a facet-only read-your-writes query.
4. Only then consider splitting `SubscriptionDelivery` into `LiveHints`, `CheckpointedPushes`, and `AckedDeliveries`. Do not combine this with a change to alarm/retry semantics.

This order makes each change reviewable and preserves the existing WebSocket upgrade workaround (`fetch-upgrade.ts`) within the pager adapter.

## Concrete defects and correctness risks

### High confidence: provider identity is inferred twice from different facts

`targetOwnsProgress` decides policy from a static rewrite-rule walk ([core-processor.ts:189-193](../../apps/os/src/stream/core-processor.ts#L189)); the actual delivery resolves the head asynchronously and decides live-ness from `instanceof RpcStubHandle` ([subscription-delivery.ts:721-758](../../apps/os/src/stream/subscription-delivery.ts#L721)). A rule can change between those decisions. The loop contains cleanup for a cursor which becomes “owns-progress” ([479-489](../../apps/os/src/stream/subscription-delivery.ts#L479)), but no single invariant says which policy wins for the current target. A tagged resolved target makes the transition explicit: a policy change either clears the obsolete cursor before publishing, or never publishes.

**Preserved capability:** dynamic rewrites and a subscription before its provider exists. **Test:** reconfigure a rule from plain callable to live provider and back while a cursor batch is in flight; assert exactly one authoritative delivery policy and no stale alarm claim.

### High confidence: live push delivery cannot be independently observed or reused

The live branch logs `delivery.push.dropped` for both budget loss and an uncoded call rejection ([733-755](../../apps/os/src/stream/subscription-delivery.ts#L733)). Its provider-specific page timeout is logged elsewhere as `rpc-stub-page-timed-out` ([407-423](../../apps/os/src/context/rpc-stubs.ts#L407)). The outcome therefore has two owners and no typed result: a new live capability must learn that `RPC_STUB_OFFLINE` is benign by copying the subscription loop's private convention.

Have `publish` return a small outcome such as `{ delivered: true } | { delivered: false, reason: "offline" | "over-budget" }`. The subscription layer emits its single notification metric from that result, while the pager layer keeps transport telemetry. This avoids suppressing genuine application errors while retaining low-latency fire-and-forget behavior.

**Preserved capability:** page timeout remains bounded at ten seconds and a subscriber repairs by read. **Test:** provider unavailable during a commit; assert no cursor/alarm is created, a single hint-loss result is reported, and the next `read` recovers the durable events.

### Medium confidence: the pager's attachment payload couples transport lifetime to arbitrary event size

`appendEvents` is URI-encoded JSON in a WebSocket upgrade header ([rpc-stubs.ts:112-126](../../apps/os/src/context/rpc-stubs.ts#L112), [202-213](../../apps/os/src/context/rpc-stub-relay.ts#L202)). A subscription configuration row is small today, but the transport protocol accepts arbitrary `StreamEventInput[]`. Header limits are materially lower and less explicit than the stream's 8 MiB event ceiling. A configuration evolution that adds a large expression or metadata can fail as an opaque HTTP upgrade problem, outside `Stream.append` validation.

Keep the atomic semantic, but make the attachment contain a compact operation identifier and write/validate configuration through a dedicated ordinary request before opening the pager; or hard-cap and validate the encoded attachment at the protocol boundary with a coded `INVALID_INPUT`. The latter is the smallest safe first change.

**Preserved capability:** one logical provide/subscribe operation either has both a pager and its naming route or neither. **Test:** boundary-sized and over-limit attachment tests, including paused-stream refusal, and reconnect replaying the compact attachment idempotently.

### Medium confidence: “one pager per key” is only eventually true

The directory accepts a new socket, appends its events, and only then closes other same-key sockets ([289-320](../../apps/os/src/context/rpc-stubs.ts#L289)). The comment correctly notes concurrency. Until the scan/drop completes, several live relays can be attached; their route-setting events have already committed. This is recoverable because the newest socket wins, but it creates unnecessary route churn and makes session replacement rules part of a transport race.

Store a monotonically increasing attachment generation in the socket attachment and in the naming event. Only the current generation may publish or remove the provider route. This is naturally part of a general `LiveProviderRegistry`, and makes reconnect/reprovide a compare-and-swap instead of “append then clean up”.

**Preserved capability:** reconnect wins without a transient detached event. **Test:** two concurrent attaches at one key; only the winner can deliver and disposing the loser cannot unconfigure the winner.

## What should remain separate

Do not try to force these into the live-provider mechanism:

- Ordered cursor delivery claims an alarm _before_ a call and persists an acknowledgement after it. The claim/ladder is essential to at-least-once behavior across eviction ([subscription-delivery.ts:1077-1111](../../apps/os/src/stream/subscription-delivery.ts#L1077), [1226-1293](../../apps/os/src/stream/subscription-delivery.ts#L1226)).
- Unordered fan-out needs a durable record for every admitted event, per-event retry/dead-letter, bounded parallel slots, and the wedged-incarnation escape hatch ([subscription-delivery.ts:1307-1357](../../apps/os/src/stream/subscription-delivery.ts#L1307), [1619-1673](../../apps/os/src/stream/subscription-delivery.ts#L1619)).
- Facet catch-up is not a generic live transport operation: it is a checkpoint repair bound to the facet host ([subscription-delivery.ts:534-564](../../apps/os/src/stream/subscription-delivery.ts#L534)).

Trying to unify these persistence modes would erase the important distinction: live hints may be lost; acknowledged external delivery may not.

## Test consolidation

The subscription/provider area has at least 9,371 test lines across the directly relevant unit, worker, and e2e files. That is not itself evidence of bad coverage, but the grouping mirrors implementation modules rather than the contracts above:

- `subscription-delivery.test.ts`: 2,459 lines;
- `rpc-stub-relay.test.ts`: 692 lines and `rpc-stubs.test.ts`: 192 lines;
- pager worker tests: 633 lines;
- RPC stub e2e tests: 1,134 lines; cursor delivery e2e: 677 lines.

Retain a compact contract matrix and remove tests that repeat the same transport transition through both an internal fake and a deployed route.

| Contract                                                    | One unit test                 | One worker/e2e test               |
| ----------------------------------------------------------- | ----------------------------- | --------------------------------- |
| page once for concurrent cold calls; return when idle       | directory                     | deployed pager plus real session  |
| reconnect replaces transport without detach                 | relay/directory state machine | one reconnect e2e                 |
| offline live notification is dropped and recovered by read  | live-hint driver              | one end-to-end subscription       |
| checkpointed push catches up after timeout                  | facet driver                  | existing residency/facet slow row |
| cursor/fan-out survive eviction and honor retry/dead-letter | delivery driver               | cursor delivery e2e               |

Keep separate regression tests only where a Cloudflare runtime behavior is being pinned (for example silent close/reset or hibernatable socket attachment). The e2e names and comments should identify that platform fact, rather than restate each unit state transition.

## Estimated reduction

This is a directional estimate, not a deletion promise. The direct files are 3,000 production lines (`subscription-delivery.ts` 1,962, `rpc-stubs.ts` 606, `rpc-stub-relay.ts` 432). Merely tagging the existing live target will remove little. Once pager attachment owns provider routing, the likely reductions are:

- 120–220 lines from the RPC-specific branch, duplicate live-target comments, and static rule-policy checks in `subscription-delivery.ts`;
- 80–150 lines by consolidating provider lifecycle/wake/census glue around a registry generation;
- 400–900 test lines by reducing duplicate state-machine assertions while retaining the contract matrix above.

The larger 15–20k-line goal requires similar cuts in other core subsystems. This seam is valuable because it turns a concrete capability (RPC stubs) into the one reusable live-provider primitive without weakening the durable paths.
