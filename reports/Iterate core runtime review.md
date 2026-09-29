# Simplify Iterate around durable context facts

Iterate should treat a context as a durable event/log declaration and an ephemeral evaluated surface, rather than as a large privileged object. Cloudflare’s model makes this necessary: Dynamic Worker identity is declarative rather than isolate-based, RPC targets require scoped ownership, and hibernation retains WebSockets/attachments but not arbitrary JS references. The evidence supports one compact kernel with durable log, resolver/jail, durable delivery, live pager, and target activation. It does not support replacing durable delivery with RPC callbacks or deleting targeted platform workarounds.

## Cloudflare makes reconstruction a normal operation

Dynamic Worker `get(id)` may reuse a warm isolate but offers no same-isolate guarantee, and its callback can run again; code for an id must stay identical ([Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)). A Durable Object facet is a named child with isolated storage; abort invalidates old stubs while preserving its database, and delete removes its database ([Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)). These contracts make a versioned `codeId` and exported target declaration the durable identity. A Worker Loader cache or a returned stub is only an activation optimisation.

Durable Objects provide input/output gates for normal storage operations. Cloudflare warns against broad `blockConcurrencyWhile` use, since it serializes requests and external I/O ([Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)). Iterate’s narrowly pinned abort/start region is justified by its observed facet reset fault; broad lifecycle orchestration is not. The redesign should put the narrow platform invariant behind one facet transition, then retain ordinary concurrency elsewhere.

Each object has one at-least-once alarm; constructors run before alarm delivery after wake and alarm failures receive native retries ([Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)). This supports an `AlarmSource` coordinator, not multiple ad hoc scheduler loops. Alarm-watch remains a separate runtime guard until its bounded telemetry criterion is satisfied.

## RPC is a live handle, never durable subscription state

Workers RPC distinguishes copied values from remote `RpcTarget` references. Stubs and values containing them need disposal, and RPC can extend execution lifetime ([RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/), [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)). That confirms the #3442 direction of narrow `using itx = this.getItx()` scopes. A live provider may accelerate a context call or a subscription notification, but its handle cannot be durable state.

Hibernatable WebSockets remain connected while the DO leaves memory; their structured-clone attachments survive only while the socket is open, are capped at 16,384 bytes, and should hold compact selectors rather than business data ([WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). The open workerd hibernatable-RPC report says active Cap'n Web/RPC state pins the isolate and cannot itself be persisted ([workerd #6087](https://github.com/cloudflare/workerd/issues/6087)). This is consistent with Iterate’s pager design: store a durable registration/cursor, page a live handle when available, drop it on failure, and recover durable events by offset.

The right internal common interface is therefore `offer(batch) -> accepted | offline | backpressured`, backed by the pager for live providers and subscriptions. Ordered cursor delivery, fan-out, and facet checkpoints remain separate durable adapters because they have different acknowledgement and retry commitments. The relay’s current indefinitely probing pending call needs a deadline or explicit streaming lease; liveness probes alone cannot bound residency.

## A declarative surface replaces a universal built-in object

Cloudflare has no generic reflection API for a loaded Worker’s exported RPC types. Dynamic Worker code itself already declares its compatibility date, modules, bindings, and outbound capability ([Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)). Iterate should add owned `TargetDeclaration` and `CapabilityDescriptor` metadata: target export/code id, trusted or untrusted, stateful or stateless, placement/admission/lifetime, prose, and optional input/output type reference. `unknown` type is valid.

The descriptor catalogue derives physical binding construction, public expression names, resolver placement, jail admission, optional TypeScript declarations, and a human/model-readable effective surface. It must describe results after inheritance, rewrites, masks, grants, and live availability. It must not serialize `RpcTarget`s, secrets, fetchers, stubs, or functions. A cached ancestor surface is sound when invalidated by a declaration/rule epoch; a jail stops inheritance and permits only explicit grants.

This design directly represents both axes that matter: a trusted entrypoint/DO receives selected platform bindings while untrusted code receives only filtered `itx`; a stateful target is activated as a facet/DO and a stateless target as a Worker entrypoint. It keeps the vanilla Cap'n Web client and processor/React authoring model above the declaration layer.

## Platform limits define the retained invariants

Failed Durable Object calls can leave a stub broken; retries require a fresh stub and should occur only for idempotent retryable operations, never overload errors ([DO error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)). `ctx.abort()` immediately resets execution, so no subsequent code can record a completion marker; its alarm retry semantics require explicit intent ([DO state API](https://developers.cloudflare.com/durable-objects/api/state/), [2026 abort changelog](https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/)). These are reasons to retain narrow explicit recovery paths and observable outcomes.

Dynamic Workers share a DO I/O context and have a collective in-flight limit ([Dynamic Worker limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/)). Iterate should bound birth/quiet facet restart fan-out. Cloudflare documents no exact hibernation timing or Cap'n Web resume guarantee, so timers belong to bounded liveness/recovery, never correctness. The final rewrite needs deployed verification on its pinned compatibility date and no new unexplained Cloudflare log errors.

## Conclusion

The research changes the proposed simplification from a generic cleanup into a durable/ephemeral separation. Persist declarations, offsets, leases, and events; reconstruct bindings and target instances; scope and dispose RPC; use live paging only as a best-effort accelerator; retain durable acknowledgement engines where they are the product guarantee. That is the smallest design that respects Cloudflare’s runtime contracts while preserving Iterate’s existing capabilities.
