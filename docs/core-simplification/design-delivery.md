# Delivery kernel proof of concept

This design narrows the kernel while keeping append-only contexts, reads, low-latency ephemerals, Cap'n Web clients, hosted processors, processor authoring, and the React hooks built on live subscriptions.

The context stops being a durable delivery broker for arbitrary capabilities. It stores events and wakes consumers. Any consumer needing acknowledgement owns its offset, retry policy, and dead letters. That is already how processors and live clients work.

Breaking API changes are acceptable for this proof of concept.

## Core contract

A context has only two consumer kinds.

| Kind          | Registration                                      | Notification                    | Progress and recovery                 |
| ------------- | ------------------------------------------------- | ------------------------------- | ------------------------------------- |
| live provider | pager-backed Cap'n Web capability, session-scoped | best-effort event batch hint    | provider reads from its own offset    |
| processor     | hosted processor facet, durable                   | serialized advance notification | processor checkpoint and log catch-up |

There is no third general subscription target whose cursor, retry ladder, alarm, or per-event state the context owns.

The new API is:

```ts
watch({ name?, consumes?, onEvents: (events, range) => void }): Disposable
processors.enable({ name, className, source, consumes? })
processors.disable(name)
readEvents(afterOffset, limit, { includeEphemeral? })
```

Watch replaces the live-callback form of subscribe. It always registers a live provider key. The old general subscribe with an expression target, afterOffset, and ordered is removed. Processor authoring remains durable but does not pretend to be a generic subscription target.

The React event-log and live-state clients already have this shape: they pass a callback, receive batches and ranges, and seed or repair through readEvents ([event-log.ts:187](../../packages/iterate/src/client/event-log.ts#L187), [live-state.ts:178](../../packages/iterate/src/client/live-state.ts#L178)). Their one API call changes from subscribe to watch. Their ordering and gap-heal algorithm stays unchanged.

## Why this removes a state machine

SubscriptionDelivery is 1,962 lines because it chooses three incompatible delivery guarantees after configuring a target expression.

1. A facet or RPC stub owns progress, determined syntactically before the target is evaluated ([core-processor.ts:183](../../apps/os/src/stream/core-processor.ts#L183)).
2. A live RPC stub receives an unacknowledged push. It may be dropped under memory pressure or while offline, then repairs by read ([subscription-delivery.ts:710](../../apps/os/src/stream/subscription-delivery.ts#L710)).
3. Any other expression gets a durable ordered cursor or fan-out records, watchdogs, retry ladders, pause probes, halt facts, dead letters, and alarm claims ([subscription-delivery.ts:1022](../../apps/os/src/stream/subscription-delivery.ts#L1022)).

The third mode produces two stream tables, several special control facts, alarm coupling, and most of the state-transition test suite. It is a background execution service hidden behind subscriptions.

The new post-commit path is only:

```text
append
  -> reduce durable configuration
  -> notify live provider keys: best effort
  -> notify processor facets: serialized
```

A provider key is an opaque pager identity, never an expression to rediscover. A processor is an authored durable program with an explicit checkpoint. The durable event log is the only recovery source.

## Exact minimal source change

### Replace Subscription with Watch and ProcessorRegistration

Replace Subscription in [core-processor.ts:269](../../apps/os/src/stream/core-processor.ts#L269) with:

```ts
type Watch = {
  providerKey: string;
  consumes?: string[];
  configuredAtOffset: number;
};

type ProcessorRegistration = {
  name: string;
  consumes?: string[];
  hostedFacet: HostedFacet;
  configuredAtOffset: number;
};
```

A watch-configured event may only name a provider key from a pager attachment. This is the current atomic live-subscribe flow ([iterate-context.ts:450](../../apps/os/src/iterate-context.ts#L450)). The last pager close removes watches naming that key through the existing dead-key census ([iterate-context-durable-object.ts:401](../../apps/os/src/iterate-context-durable-object.ts#L401)).

ProcessorRegistration is durable and only comes from processors.enable. It does not expose a target expression, afterOffset, ordered, halted, or resumed.

Delete:

- targetOwnsProgress and targetIsWebhook;
- afterOffset, ordered, halted, and resumed from core state;
- subscription-delivery-resumed, subscription-delivery-halted, and subscription-delivery-failed kernel records;
- the subscription list view that joins cursor and fan-out state.

The UI receives active watches from watches.list and durable processors from processors.list. Its refresh predicate changes from subscription events to processor configuration events.

### Make RpcStubDirectory the provider directory

Do not add another delivery transport. Rename the role of RpcStubDirectory to LiveProviderDirectory. Retain its implementation-critical behavior:

- hibernatable attachment and rehydration ([rpc-stubs.ts:379](../../apps/os/src/context/rpc-stubs.ts#L379));
- page-on-demand with one shared cold page ([rpc-stubs.ts:397](../../apps/os/src/context/rpc-stubs.ts#L397));
- return borrowed stubs before hibernation ([rpc-stubs.ts:255](../../apps/os/src/context/rpc-stubs.ts#L255));
- client liveness, relay retry, and coded offline result ([rpc-stub-relay.ts:126](../../apps/os/src/context/rpc-stub-relay.ts#L126)).

The provider convention is only:

```ts
notify(events: StreamEvent[], range: ScannedRange): Promise<void>
```

The directory invokes it with its existing generic stub walker. This is not merely a wrapper method. It is how the only live transport becomes the single owner of availability, backpressure, pager recovery, and offline classification.

The directory has one bounded coalescing queue per provider key:

```ts
type PendingHint = { events: StreamEvent[]; after: number; through: number };
```

Later commits fold into the pending hint. If the global hint budget is exceeded, discard old events, move after, and log live-provider.hint-dropped. The range gap is the consumer's signal to read. There is no retry, cursor, alarm, or durable queue.

Idle providers remain cheap: page once and call directly. Busy providers coalesce rather than grow parallel calls or an unbounded queue.

### Keep a small processor notifier, not a subscription engine

FacetHost already owns hosted-facet lifecycle, checkpointing, and restart. Give it:

```ts
notifyProcessors(events: StreamEvent[], range: ScannedRange): void
```

For each matching processor it queues one serialized processEventBatch call. On configuration it materializes and catches up. If a call times out or is interrupted, the next hosted incarnation catches up from the log.

Retain only the current facet-push queue, its bounded memory code ([subscription-delivery.ts:564](../../apps/os/src/stream/subscription-delivery.ts#L564)), and its read-your-writes barrier ([subscription-delivery.ts:662](../../apps/os/src/stream/subscription-delivery.ts#L662)). Move them beside FacetHost. They no longer resolve a user expression, inspect an RPC brand, create an alarm claim, or persist delivery rows.

A processor still calls arbitrary capabilities: webhook, agent, voice agent, sibling context, or provided Cap'n Web capability. If that effect needs retries or a dead letter, processor code owns the policy with its checkpoint and durable state.

### Simplify post-commit and alarms

The current post-commit callback starts SubscriptionDelivery on every batch ([iterate-context-durable-object.ts:545](../../apps/os/src/iterate-context-durable-object.ts#L545)). Replace it with:

```ts
onCommit(events, after, through) {
  liveProviders.notifyWatches(coreState.watches, events, { after, through })
  facetHost.notifyProcessors(coreState.processors, events, { after, through })
}
```

Remove SubscriptionDelivery deadlines, owedCause, and deliverEveryCursorSubscription ([subscription-delivery.ts:364](../../apps/os/src/stream/subscription-delivery.ts#L364), [subscription-delivery.ts:634](../../apps/os/src/stream/subscription-delivery.ts#L634)), plus their Durable Object alarm callers. The alarm then represents real durable obligations only: schedules, processor claims, and runs.

## What moves to user space

The deleted feature is not call a webhook or process an event exactly once. It is the kernel selecting a retry policy for an arbitrary expression.

| Existing use                    | User-space replacement                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| ordered append or worker method | processor with checkpoint calls target after reducing event                                       |
| unordered webhook fan-out       | processor records one work item per source event and controls concurrency, retry, and dead letter |
| halt and resume delivery ladder | processor records failed work and provides its own operator retry action                          |
| static expression target        | processor source/configuration invokes the capability                                             |

This preserves expressive power. A processor has an event stream, durable state, capability execution, and a checkpoint. It is more expressive than one hard-coded cursor policy because it can supply an idempotency key, batch, rate-limit, or use a third-party queue.

An SDK helper restores convenience without putting policy back in apps/os:

```ts
webhookProcessor({ consumes?, send, retry? }): Processor
```

## Required proof cases

| Invariant                                                 | Proof                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| An idle live provider does not keep the context resident. | Pager attached and no borrowed stub means dormant transport state. Notify once and return borrowed stubs.       |
| A live provider has bounded memory.                       | Hold notify, append above budget, assert one coalesced hint and a range gap.                                    |
| A dropped/offline hint loses no durable event.            | Disconnect during append, reconnect and read from the consumer offset, compare durable offsets.                 |
| Ephemerals remain low-latency best effort.                | Watch an ephemeral type; receive it in the same incarnation and verify no write or eviction recovery guarantee. |
| A processor catches up after interruption.                | Enable it, hang/restart delivery, verify its checkpoint reaches durable head once.                              |
| Processor reads remain read-your-writes.                  | Preserve the facet push-barrier test.                                                                           |
| A watch creates no alarm.                                 | Watch and append, then inspect the alarm sources. Only schedule, run, and processor claims remain.              |
| Session end removes its watch.                            | Close its pager, assert watcher removal, then verify later commits make no call.                                |

Keep e2e platform pins for hibernatable socket attachment, deploy-reset redial, and client liveness. Remove core cursor/fan-out tests; recreate those only in processor packages that intentionally choose their retry semantics.

## Files and deletion target

| File                                          | Change                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apps/os/src/stream/subscription-delivery.ts   | Delete cursor and fan-out engines, expression resolver, and alarm API. Move the processor queue to facet-host. Delete this file or reduce it below 250 lines.                                      |
| apps/os/src/stream/stream.ts                  | Delete subscription_cursors and subscription_deliveries schema, methods, and types: roughly 130 lines.                                                                                             |
| apps/os/src/stream/core-processor.ts          | Split and reduce Subscription, remove inference and halt/resume reduction: roughly 180 to 260 lines.                                                                                               |
| apps/os/src/iterate-context-durable-object.ts | Remove delivery deadlines, owed causes, alarm branches, and view joins: roughly 100 to 180 lines.                                                                                                  |
| apps/os/src/iterate-context.ts                | Replace general subscribe with live-only watch: roughly 50 to 90 lines.                                                                                                                            |
| rpc-stubs and relay                           | Rename/document as provider transport and add bounded notification queue. Initial net change is small.                                                                                             |
| tests                                         | Replace delivery-machine tests with the proof matrix. Direct subscription/provider tests currently exceed 9,000 lines; a 2,500 to 4,000 line reduction is plausible while retaining platform pins. |

The production-code target for this slice is 1,500 to 2,100 lines removed. Reliable work becomes an authored processor; live observation uses the one pager protocol.

## Migration boundary

For the proof of concept, bump the core contract and declare existing generic subscription rows unsupported. That avoids retaining the old delivery engine as compatibility code.

For production adoption, run a one-off conversion before enabling the reducer:

1. convert hosted facet rows to ProcessorRegistration;
2. convert live pager rows to Watch;
3. export each cursor/fan-out row as a generated processor skeleton with its last cursor and work records for review;
4. refuse deployment if unconverted durable delivery state remains.

Do not retain a runtime dual mode. It would preserve the state machine this design removes.

## Rejected alternatives

A tagged target abstraction while retaining cursors improves naming but keeps the kernel as durable broker, including tables, alarm claims, and nearly all code. It is an intermediate refactor, not the requested reduction.

A fake common RPC protocol for facets and browsers confuses their persistence models. They share range and repair semantics, but a processor needs checkpointed execution and a browser needs a hibernatable session provider.

Making a pager reliably deliver and retry recreates the cursor engine under another name and prevents idle hibernation.
