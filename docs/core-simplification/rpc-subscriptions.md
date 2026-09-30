# RPC providers and subscriptions

## Current direction

An Iterate context keeps one durable event log and exposes capabilities through normal `itx.*` names. A session-owned capability is lent through the existing `RpcStubDirectory`: a hibernatable pager socket records the capability's key and small metadata, and a call pages the session only when the stub is not currently borrowed. The relay owns redial, lending, explicit disposal, and disconnected outcomes.

`provide(stub)` and callback `subscribe` use that same mechanism. The pager attachment is live state. It may describe a provided name, a fetch route, or a callback subscription, but it does not append a durable configuration row. A live attachment shadows a durable row of the same name while its socket is attached. On detach, reset, or failed redial, the durable row is visible again. Socket attachments survive Durable Object hibernation; borrowed stubs do not.

This keeps the durable log for durable facts and the pager for session lifetime. It avoids installing a second registry, a second naming vocabulary, or a configuration event merely to describe a socket that can disappear.

## What is shared

The existing pager and relay are the shared transport for a provided capability and a live callback.

- `RpcStubDirectory` accepts the WebSocket pager, restores its attachment after hibernation, pages a lender on demand, and returns borrowed stubs when residency releases them. It also makes reconnect replacement and detach visible through the existing RPC-stub presence events.
- `rpc-stub-relay.ts` holds the session leg, dials the pager, re-dials after a lost Durable Object leg, and supplies a new borrowed stub for a page. Its offline and disposal behavior remains the single place that handles the Cap'n Web session boundary.
- `iterate-context.ts` builds a live attachment for `provide(stub)` and callback `subscribe`. Expression and `null` provides retain their existing session-scoped rewrite-rule behavior; only a live provision avoids a durable rewrite row.
- `iterate-context-durable-object.ts` overlays current attachments on durable rewrite rules, fetch routes, and subscription rows before it resolves or describes a context. The attachment version participates in the existing snapshot/lease validity path, so a route assembled before an attach or detach is retried rather than served as a stale grant.

The attachment is validated before the socket is accepted. Its serialized form is bounded by the Durable Object WebSocket attachment limit, and the fetch-route payload is normalized with the same route parser as a durable route. A route targets the public provided name; it never exposes `itx.builtins` through a route target.

## Authority and lifetime

Live attachment metadata is untrusted at the HTTP pager boundary. The directory validates its object shape, canonical provided name, subscription key, route shape, and complete encoded attachment size before accepting a socket. A replacement socket gets a new attachment identity; the old socket cannot detach or re-point the replacement.

Loaded code still has to pass the existing app-wall checks before its pager is opened. The preflight validates the proposed rewrite/subscription configuration without appending it, applies the existing jail-lifting and platform-write guards, then resolves the corresponding `itx.append(...)` under the original caller. This preserves a mask on `itx.append` and the reservation of `itx.config` for publication. It must not trust a caller header supplied by an arbitrary fetch request.

| State                                                 | Held where             | After hibernation                   | After socket detach                 |
| ----------------------------------------------------- | ---------------------- | ----------------------------------- | ----------------------------------- |
| Durable rewrite, route, or subscription configuration | context log/core state | remains                             | remains                             |
| Live provided name, route, or callback                | pager attachment       | reconstructed from accepted sockets | disappears, revealing durable state |
| Borrowed client RPC stub                              | in-memory directory    | returned; later call pages again    | returned or failed                  |

## Delivery

Live callbacks are projected into the same subscription view used by the delivery path. They use the existing bounded, ordered/coalesced live push queue rather than spawning one callback transport call for every commit. A missing live callback is an expected best-effort loss: the client can read the event log and repair its own view.

Durable subscription progress, retry, terminal recording, and delivery ownership stay with the SDK runner and its private native bridge. The context validates the configured row and provides bounded reads/calls; it does not introduce a general durable target scheduler for pager attachments. The bridge rechecks configuration, range, generation, and caller authority before it invokes a configured target. Those checks are the proof boundary for a durable delivery, not pager metadata.

## Evidence to retain

The focused checks in this slice cover protocol and lifecycle facts rather than a claim of complete parity:

- pager codec rejection and round-trip of a live fetch-route attachment;
- relay paging, replacement, borrow/return, and hibernation bounds;
- durable binding restored after live detach, reset, hibernation, and redial;
- concurrent/replacement pager identity behavior;
- live fetch-route validation and route restoration;
- loaded-code refusal for `itx.config` and for a jailed `itx.append`, before pager acceptance and without a durable configuration write.

The historical first design, including the proposed renamed directory, tagged target categories, and a separate publish protocol, is preserved in [archived-rpc-subscriptions-first-design.md](archived-rpc-subscriptions-first-design.md). It is not the current recommendation.
