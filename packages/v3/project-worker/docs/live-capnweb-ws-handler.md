# R3b — a LIVE capnweb-provided fetch handler that serves WebSockets

## The problem

A client provides a **live capability** whose value is a mini web server —
`{ fetch }` — over a Cap'n Web session. That `fetch` upgrades WebSockets: on an
`upgrade: websocket` request it returns `new Response(null, { status: 101,
webSocket })`. Someone then reaches the capability by **naming the mount** (an
app host that forwards `itx.wsbackend.fetch(req)`, or the fetch lane
`/cap?cap=["wsbackend"]`), expecting a real WebSocket to the provider.

Today this fails. The clean-room punts with a `501` ("needs a frame bridge
(deferred)"); apps/os's quarantined test walks one hop further and hits the
runtime error verbatim:

```
DataCloneError: Could not serialize object of type "WebSocket"
```

The question this doc answers (Jonas): **at what level do WE fix this — an
application-level frame bridge, our capnweb fork, or workerd — and can our
capnweb fork make it easier?** Short answer up front: **fix it in the fork**, it
is a small, purely fork-side change (no workerd compat flag), and it turns a
hand-rolled per-frame bridge into "carry a stream pair one hop further and
materialize once." Details and the one load-bearing spike are below.

---

## Why it fails today — the exact hops

### The two-channel rule

workerd grants protocol semantics (a real 101 upgrade) to **exactly one place**:
the distinguished `fetch` handler on a real object (WorkerEntrypoint / DurableObject /
facet), reached through a real stub. Everything else — the itx capability tree,
dotted paths, `invokeCapability` — is a Workers-RPC overlay whose arguments and
results are **serialized**, and a live `WebSocket` is the one value workerd's RPC
serializer refuses (`apps/os/src/domains/workers/worker-fetch-dispatch.ts:12-36`,
`isWebSocketUpgradeRequest` at `:53-55`; the model in full:
`apps/os/docs/dynamic-worker-dispatch.md:8-37`).

Plain `Request`/`Response` copies serialize fine over RPC (that is why non-upgrade
HTTP through a live capability works — asserted at
`apps/os/e2e/vitest/live-capability-websocket.e2e.test.ts:84-86`, a 426). Only the
socket cannot cross.

### The clean-room live-provider chain (where R3b actually lands)

1. A device/Node provider dials `wss://…/api?ctx=prj_X`. The capnweb session
   terminates in the **stateless project worker (the RELAY)** against
   `ProjectSession` — the one capnweb entrypoint, a hard rule
   (`packages/v3/project-worker/src/worker.ts:52-56`).
2. The provider calls `itx.provide("itx.wsbackend", { fetch })`. The `{ fetch }` object is a
   **capnweb stub the relay holds for the session**, lent to the `itx.rpcStubs` built-in under
   `itx.wsbackend`; the relay opens a stub pager WebSocket to the context DO, which records
   only a transport id — no stub, so the DO still hibernates (the don't-pin transport,
   `BUILD-LOG.md` Increment 18). The mount itself is the ordinary table row
   `itx.wsbackend ⇒ itx.rpcStubs.get('itx.wsbackend')` — pure data, never the socket.
3. An eyeball hits an app host that upgrades. The edge sets `x-itx-cap` and
   forwards to the host DO (`worker.ts:60-65`); `ItxDurableObject.fetch` sees
   `x-itx-cap` and calls `#fetchCapability("wsbackend", request)`
   (`itx-durable-object.ts:141-147`, method at `:473`).
4. `#fetchCapability` finds no local `web`/`stateful` mount, only a live-cap stub,
   and **returns 501**:

```ts
// itx-durable-object.ts:488-493
// A live capnweb provider: a 101 can't cross capnweb, so a WS to a device needs a frame bridge (deferred).
if (this.#capabilityStub(callPath))
  return new Response(`fetch to a live provider "${callPath}" needs a frame bridge (deferred)\n`, {
    status: 501,
  });
```

So the clean-room never even reaches the DataCloneError — it declines first
(BUILD-LOG Increment 16, `:334-337`: "A live capnweb provider (external device) is
explicitly 501 for now").

### Where the socket materializes, and the next hop that refuses it

To actually serve the provider, the DO must reach the provider's `fetch`, which
lives behind the capnweb session **in the relay**, reachable only via the Pager
wake → a Workers-RPC **Invoker** leg (`Invoker.invoke(path, args):
Promise<unknown>`, `core/hibernatable-stub.ts:25-27`, `:81-88`). Trace it:

- The relay's Invoker calls `provider.fetch(request)` over the capnweb session to
  the device. The device returns `Response(null,{status:101, webSocket})`.
- capnweb **serializes the socket as a `{ readable, writable }` stream pair across
  the session** — `webSocketToStreams` accepts the socket, attaches listeners, and
  starts piping the readable eagerly
  (`~/src/github.com/iterate/capnweb/src/serialize.ts:516-535`; the wrapper at
  `websocket-streams.ts:82-150`; the dedupe/ownership guard
  `getHookForWebSocket` at `core.ts:951`).
- Back in the **relay**, capnweb **deserializes and materializes a real
  `WebSocketPair`** — because `typeof WebSocketPair !== "undefined"` on workerd —
  then pumps it to/from the tunneled streams:

```ts
// serialize.ts:1064-1094 (deserialize) → makeUpgradeResponse
// websocket-streams.ts:359-372
export function makeUpgradeResponse(readable, writableHook, init): Response {
  let socket = new TunneledWebSocket(readable, writableHook);
  if (typeof WebSocketPair !== "undefined") {
    // <-- the workerd branch
    let pair = new WebSocketPair();
    pumpNativeSocket(pair[1], socket); // pump: websocket-streams.ts:381-398
    return new Response(null, { ...init, status: 101, webSocket: pair[0] });
  } else {
    let response = new Response(null, init); // <-- the non-workerd branch: TunneledWebSocket, status 200
    Object.defineProperty(response, "webSocket", { value: socket, configurable: true });
    return response;
  }
}
```

- The relay now holds a `Response` carrying a **real `WebSocketPair` end** and must
  **return it to the DO over the Invoker Workers-RPC leg** — and _that_ is the hop
  workerd refuses: `Could not serialize object of type "WebSocket"`.

apps/os hits the identical wall in a differently-shaped mesh: the socket
materializes at the OS capability-host isolate (the capnweb session endpoint), and
the refused hop is the Workers-RPC **return** of the `invokeCapability` result to
the calling dynamic worker (`LiveWsApp`). That is exactly what the quarantined
boundary probe pins:

```ts
// apps/os/e2e/vitest/live-capability-websocket.e2e.test.ts:99-103
// The capnweb session leg tunnels the socket (stream pair); the first
// internal workerd RPC hop after materialization refuses it.
expect(outcome).toContain('Could not serialize object of type "WebSocket"');
```

The provider under test is a genuine upgrading fetch handler
(`nodeWebSocketFetchHandler`, `:259-271`, minting an in-memory socket-pair shim
because Node has no `WebSocketPair`), and the app is the one a user would naturally
write — forward to the capability (`FORWARDING_APP_SOURCE`, `:50-61`).

**One-line diagnosis:** the villain is the **early materialization** at
`makeUpgradeResponse` (`websocket-streams.ts:363-366`). A stream pair _can_ cross a
Workers-RPC hop (workerd RPC serializes `ReadableStream`/`WritableStream`
natively); a materialized `WebSocket` cannot. capnweb materializes at the session
endpoint, one hop too early, so the socket dies on the very next internal hop
toward the fetch-lane exit.

### Why it's quarantined (and a constraint on any fix)

The boundary probe is `test.skip`, not just failing, because the damaged capnweb
session **cancels the shared OS isolate** after the expected error, turning one
apparent pass into a synchronized `1006` close storm across the parallel Vitest
suite (`tasks/quarantined-live-capability-websocket-e2e.md:11-16`, causal trace
`:27-31`). **Any fix must fail closed** — close every stream/stub, never cancel the
serving isolate (exit criteria `:65-74`).

### What the fork already changed vs upstream

The WebSocket-over-RPC support is **not in upstream cloudflare/capnweb `main`** —
`src/websocket-streams.ts` is **absent on `origin/main`** and
`getHookForWebSocket` has zero hits there. It is Jonas's own feature
(`codex/websocket-serialization`, commit `f6cd686` — the exact SHA pinned in
`apps/os/src/domains/capability-host/live-capability.ts:47-50`), published as
`@iterate-com/capnweb@0.10.0` (iterate/capnweb `main`, commit `dd78944` "Add
support for sending WebSockets over RPC…"). `websocket-streams.ts` is **byte-identical**
between the two checkouts. Upstream tracks the same idea but hasn't shipped it:
capnweb #187 "Support serializing/deserializing Response objects with a websocket"
(OPEN). So the fork already owns this code path end to end — **we can change it.**

---

## The solution space, at three levels

### Level 1 — application-level frame bridge (no capnweb change)

**What it is.** Terminate the eyeball's 101 natively where it's addressable — the
`ItxDurableObject` (it already mints an ingress-echo `WebSocketPair`,
`itx-durable-object.ts:171-175`) — and shuttle **raw frames** between that socket
and the provider, without ever crossing an RPC hop with a materialized socket.

**How the frames move.** The provider socket materializes fine **inside the relay
isolate** that holds the capnweb session (as a `TunneledWebSocket`/`WebSocketPair`
end — it never leaves that isolate). The DO holds the eyeball socket. They are in
different isolates, so the DO ↔ relay bridge rides the Pager/Invoker leg as
**paired callback stubs**: DO `webSocketMessage` → `invoker.invoke(["sendFrame"],
[data])` → relay writes the provider socket; provider-socket message → a callback
stub the relay was handed → DO → `eyeball.send`. Functions chain through every RPC
hop, which is exactly the "determined userspace can bridge a socket by hand"
pattern the doc already describes (`dynamic-worker-dispatch.md:189-195`).

**Does the provider need to speak a framing protocol?** **No** — this is the good
news. Because the fork's tunnel already turns the provider's returned socket into a
usable socket **in the relay**, the bridge logic lives in the relay's live-cap
handler, not in the provider. The provider stays a plain `{ fetch }` that returns a 101. So it _can_ close the quarantined test (which insists on a plain upgrading
`fetch` handler).

**What carries backpressure/close.** Nothing, for free — you hand-roll it. Close is
a callback (`{code,reason}`); backpressure means bounding your own in-flight
callbacks. This is the part the quarantine warns about: a naive bridge that leaks
stubs or lets a broken session escape is exactly what cancels the isolate.

**Cost.** Every frame is a Workers-RPC round trip (DO ↔ relay) **plus** a capnweb
hop (relay ↔ device) — two hops per frame, no native flow control, close/error
plumbing by hand, `dup()` discipline on the callbacks a session holds (RPC params are released
on return — `live-capability.ts:25-37`). Highest ongoing complexity and latency;
closes the test but is the thing the quarantine explicitly fears.

### Level 2 — capnweb-fork level (recommended)

**What it is.** Stop materializing the `WebSocketPair` at the session endpoint.
Keep the socket in `{ readable, writable }` **stream-pair form** — which _does_
serialize across internal Workers-RPC hops — and materialize a real `WebSocketPair`
**only at the fetch-lane exit** that returns the 101 to the eyeball. This is the
"missing piece" the doc already names (`dynamic-worker-dispatch.md:27-37`,
`:189-195`).

**Which fork functions change.** Only the **deserialize/materialize** side:

- `serialize.ts:1064-1094` unconditionally calls `makeUpgradeResponse`, and
  `makeUpgradeResponse` (`websocket-streams.ts:359-372`) unconditionally
  materializes on workerd (the `:363-366` branch). Add a **deserialize option** —
  e.g. `newWebSocketRpcSession(transport, localMain, { deferUpgradeMaterialization:
true })` — that makes an upgrade Response deserialize to a Response whose
  `webSocket` is a **plain `{ readable, writable }`** (the real `ReadableStream`
  plus `streamImpl.createWritableStreamFromHook(writableHook)`), i.e. force the
  non-workerd path even when `WebSocketPair` is defined.
- Export a companion `materializeUpgrade({ readable, writable }, init): Response`
  that IS the existing `WebSocketPair` + `pumpNativeSocket` branch
  (`websocket-streams.ts:363-366`, `:381-398`), callable by application code at the
  exit hop.

**Who uses them.** The clean-room relay, when servicing a live-cap fetch, requests
the deferred form and returns the **whole `response.webSocket` pair object** over
the Invoker leg (byte streams serialize over Workers RPC; destructuring to
`{ readable, writable }` would drop the shipped pair's `init` field and with it the
negotiated subprotocol — see Status below). The DO's `#fetchCapability` — replacing
the `501` at `itx-durable-object.ts:488-493` — calls `materializeUpgrade(...)` and
returns the 101. One materialization, at the boundary, native stream backpressure,
no per-frame RPC.

**Is deferred materialization feasible under workerd's rules? Compat flag needed?**
Feasible, and **purely fork-side — no workerd compat flag.** The whole point is
that we now move only what workerd RPC _already_ serializes (streams), never a
socket. The fork's non-workerd branch already produces exactly this shape today;
we're making it selectable on workerd.

**The one real risk** is lifetime, not serializability — see the spike below.

### Level 3 — workerd level (the eventual native fix, not for now)

**What it is.** Make a materialized `WebSocket` (or a `Response` carrying one)
serializable across a **Workers-RPC** hop between isolates. If workerd's own RPC
serializer learned to carry `Response.webSocket`, the socket would simply flow
through the internal mesh and none of levels 1–2 would be needed. Related open
upstream work: **workerd #6087** "Support for Hibernatable RPC Targets in Workers
Runtime (Enable `capnweb` hibernation within Durable Objects)" and **capnweb #36**
"WebSocket Hibernation" (both OPEN), plus capnweb #187 (serialize Response+websocket
— the fork already did this at the capnweb layer, but not at the workerd-RPC layer).

**Why it doesn't help now.** Out of our control, no committed timeline, and it's a
runtime serializer change (the hardest kind to land). We should not block R3b on it.
Level 2 is forward-compatible: if workerd later carries the socket natively, the
`materializeUpgrade` exit hop becomes a no-op and the deferred option can be dropped.

---

## Recommendation

**Fix it at the fork (Level 2).** It is the minimal change that closes both
quarantined cases, it is native-feeling (native stream flow control, one
materialization at the boundary), and it is **purely fork-side** — no workerd flag,
because we only ever move a stream pair, which workerd RPC already serializes. It
also collapses Level 1's hand-rolled per-frame bridge into "carry the pair one hop
further," removing exactly the leak-prone machinery the quarantine warns about.

**Concrete minimal change:**

1. **Fork** (`@iterate-com/capnweb`): ✅ **shipped** (fork PR #7) — the
   `deferUpgradeMaterialization` session option delivers `Response.webSocket` as an
   opaque `DeferredWebSocketUpgrade` `{ readable, writable, init }` byte pair, and
   `materializeUpgrade(pair, init?)` rebuilds the real upgrade Response at the exit
   hop. No protocol change (the wire format is unchanged — this only chooses what
   the receiver builds). See **Status** below for the contract details that differ
   from this sketch.
2. **Clean-room relay** (`worker.ts` live-cap path / `core/itx-surface.ts`): when a
   live-cap `fetch` returns an upgrade, hand the **whole `response.webSocket` pair
   object** back over the Invoker leg (`hibernatable-stub.ts:81-88`) rather than a
   socket — not a destructured `{ readable, writable }`, which drops `init` — and
   keep the delivering Response referenced (undisposed) while the tunnel lives.
3. **Clean-room DO** (`itx-durable-object.ts:488-493`): replace the `501` with
   `materializeUpgrade(pair)` and return the 101 — the fetch-lane exit. Detect a
   deferred upgrade via `response.webSocket != null`, never via `status === 101`:
   the deferred Response's own status is 200 (constructed Responses can't be 1xx).
4. **apps/os**: the deferred-materialize option **plus a `materializeUpgrade()`
   call at its exit hop** (the dynamic worker returning the 101) flips its
   quarantined `test.skip` → passing; then remove the boundary probe (or invert it)
   per `tasks/quarantined-live-capability-websocket-e2e.md:60-63`.

**Use Level 1 only as a fallback** if we must ship without touching the fork; it
closes the test but keeps the per-frame bridge and its failure modes. **Don't wait
on Level 3.**

---

## Status: shipped in the fork (2026-08-18)

The fork side is done: `@iterate-com/capnweb` PR #7 (branch
`defer-upgrade-materialization`, a normal single-commit PR against `main` — the
v0.11.1 rebase PR #6 has landed, with main now on upstream `2de5871`), reviewed
with two staged multi-agent adversarial passes. The contract differs from the
Level 2 sketch above in ways the integration must respect:

- **The pair is byte-oriented, not the tunnel's value streams.** This doc's
  premise that "streams serialize across Workers RPC" turned out to be true only
  for **byte** streams: a value-chunk `ReadableStream` fails across a native hop
  with `TypeError: This ReadableStream did not return bytes`, and string writes
  into the proxied writable are refused. So the pair carries the tunnel's
  text/binary/close frames in an internal length-prefixed framing spoken only by
  the deferring session and `materializeUpgrade()` — invisible to us, but it means
  the pair is **opaque**: never construct, parse, or partially consume it.
- **Deferral is the default on Workers — the relay needs no option at all.** A
  tunneled upgrade received over a capnweb session on workerd arrives as the
  pair unless the session explicitly sets `deferUpgradeMaterialization: false`
  (which an endpoint would only do to serve the socket itself). Node/browser
  receivers keep getting a usable socket by default. So the edge-side change
  for R3b is zero lines: the relay session is created with no options.
- **The pair is `{ readable, writable, init }`** (`DeferredWebSocketUpgrade`).
  `init` carries the provider's upgrade headers (e.g. the negotiated
  `Sec-WebSocket-Protocol`) as plain data, so forwarding the **whole object**
  preserves them; `materializeUpgrade(pair)` puts them on the real 101 (verified
  down to a raw-socket RFC 6455 handshake — workerd/kj recomputes/drops reserved
  handshake headers, so replaying provider headers is safe). An explicit `init`
  argument to `materializeUpgrade` replaces `pair.init` wholesale.
- **Detect deferred upgrades via `response.webSocket != null`.** The deferred
  Response's own status is 200; and never forward the Response itself across a
  native hop (its `webSocket` property is a JS expando that silently vanishes).
- **Lifetime (spike 2, resolved):** no dup/claim call is needed. The pair's inner
  ends are owned by the delivering capnweb payload for the tunnel's whole life;
  an awaited call **result** is not auto-disposed, so the relay just keeps the
  delivering Response referenced (undisposed) while the tunnel lives — it lives
  until the session ends otherwise, and the session's lifetime is the provider
  connection's anyway. A pair received in call **params** cannot be kept past the
  call. `materializeUpgrade` consumes the pair (locks both streams synchronously;
  a second call throws). For per-tunnel reclamation before session end, wrap the
  pair's streams in observing pass-throughs before forwarding, or tie retention to
  the Invoker/Pager connection. (Do not add a Promise field to the pair for this —
  workerd RPC would await it during serialization.)
- **Operational note:** a live materialized tunnel keeps its DO resident — the
  pump is in-memory listeners, not the hibernatable-WebSocket API. Hibernation
  applies to _parked_ capabilities, not DOs actively serving tunnels.
- **Flow control:** capnweb stream acks fire as the pair is _read_, so an
  unconsumed or in-transit pair keeps the device throttled to the flow-control
  window (~256 KiB initial) — relay memory is window-bounded (asserted by test).

---

## Open spikes — all four resolved on the fork side

**Known (corrected):**

- **Byte** streams serialize across Workers RPC — value-chunk streams and
  materialized `WebSocket`s do not. (Empirically probed; this reshaped Level 2
  into the framed byte pair described under Status.)
- The fork owns `websocket-streams.ts` end to end (absent upstream) — we can change
  it without a workerd change.
- The provider can stay a plain `{ fetch }` in every level — no framing protocol
  imposed on the client. (Held: the framing is entirely receiver-side.)

**Spike resolutions** (evidence: the fork's `websocket-tunnel.test.ts` and
`workerd.test.ts` on the PR #7 branch):

1. **The writableHook across one more RPC hop (was load-bearing).** ✅ Proven with
   the framed byte pair: the pair crosses a real service-binding hop in a call
   _param_ and in a _return payload_ (the exact relay → DO shape), echoes through
   the full path, and close propagation is asserted at the origin through both
   boundaries. No thin-`send`/`close` fallback needed.
2. **Claim/lifetime before the Invoker call returns.** ✅ Resolved without a
   dup/claim affordance — see Status: capnweb result payloads are not
   auto-released; retention = keep the delivering Response referenced. The fork's
   return-path test models exactly this contract.
3. **Close/backpressure across the extra boundary.** ✅ Close: in-band close
   records round-trip across the native hop in both directions with codes and
   reasons intact; abnormal death surfaces as error + close 1006. Backpressure:
   consumption-coupled acks keep the sender window-bounded until materialization
   (asserted by a deterministic test); after materialization the endpoint behaves
   like the non-deferred one (a slow eyeball is absorbed by the native socket's
   send buffer, as on a direct WebSocket).
4. **Fail-closed under the quarantine's bar.** ✅ Fork side: malformed frames,
   oversized frames (128 MiB cap enforced on both encode and decode sides),
   truncation at end-of-stream, and RPC-session death all tear the tunnel down
   (abort the sender's socket / error + close 1006) rather than leaving anything
   half-open, and the serving session survives tunnel teardowns (later tests keep
   running on the same session). The **25-consecutive-parallel-run exit criterion
   remains apps/os's to prove** when the quarantined e2e is re-enabled.
