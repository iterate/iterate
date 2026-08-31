# Answering WebSocket upgrades from non-workerd capnweb providers

**The sender-side dual of [live-capnweb-ws-handler.md](live-capnweb-ws-handler.md).** That doc
solved the RECEIVE side (carry a provider's tunneled socket past the capnweb session endpoint —
fork PR #7, and independently the platform's dedicated upgrade leg). This one solves the SEND
side: a provider that is NOT on workerd — a Node CLI (`iterate tunnel bla 3000`), a browser, an
ESP32 speaking the wire protocol — cannot today _answer_ a fetch with a WebSocket upgrade,
because the only spelling anyone knows is the workerd one and non-workerd runtimes refuse it.

**The answer up front:** this is an **API-blessing gap, not a capability gap** — and that is
_measured_, not inferred. The fork's serializer already accepts any `Response` carrying a
`webSocket` own-property (it deliberately never serializes status for upgrades), already
duck-types the socket (`send`/`close`/`addEventListener`, `accept` optional), and its own Node CI
already ships `ws`-package client sockets this way. On 2026-08-31 we ran the exact
`iterate tunnel` scenario — Node capnweb provider, undici client socket to a localhost WS echo
server, eyeball WebSocket through `/cap` — with the fork's test-only spelling on **published
0.12.0**, zero fork changes: **101 + echo + clean close, fully green** (the clean close also
needed a one-line platform close-echo fix, landed as part of this work).

The recommended minimal patch is therefore two small sender-edge exports on the fork —
**`upgradeWebSocketResponse(socket, init?)`** and a **pure-JS `WebSocketPair`** — no wire change,
no serializer change, no receiver change, wire-compatible with every published fork version.

---

## 1. The problem, concretely

Two `test.fails` pin it (both layered so the failing hop is named by data, not guessed):

- **`__tests__/failing-tunnel-proxy.test.ts`** — the tunnel CLI. The upgrade Request reaches the
  Node provider through every hop (green), the provider opens a client WebSocket to
  localhost (green — Node ships a WS _client_), and only the _answer_ cannot be spelled:

  ```
  blocker: WebSocketPair is undefined in Node
  blocker: RangeError: init["status"] must be in the range of 200 to 599, inclusive.
  ```

- **`__tests__/failing-ws-fetch-capability.test.ts`** — the device/ESP32 shape. Same two
  blockers, plus the positive pins that request forwarding and error propagation through the
  whole live lane are green, and that the _platform_ half (carrying a genuine live-capability
  101 relay → DO → eyeball) is proven green with a workerd provider
  (`__workers-tests__/ws-fetch-live-101.test.ts`).

Both provider attempts use the workerd spelling:

```js
const pair = new WebSocketPair(); // undefined in Node
return new Response(null, { status: 101, webSocket: pair[0] }); // undici: 101 refused, webSocket dropped
```

## 2. What is already true in the fork (published 0.12.0) — the measured facts

Everything below is verified against `iterate/capnweb` branch `rebase-0.12` (≈ published
`@iterate-com/capnweb@0.12.0`), file:line cites included because they carry the design:

1. **Classification is prototype-exact but property-blind.** `typeForRpc` says "response" for
   anything whose prototype is literally `Response.prototype` (`src/core.ts:127-128`) — undici's
   `Response` passes — and the devaluator reads `webSocket` as a **plain own-property**
   (`src/serialize.ts:490`). An `Object.defineProperty` expando is indistinguishable from
   workerd's native property.
2. **Status is deliberately never serialized for upgrades.** `src/serialize.ts:498-503`: "An
   upgrade implies status 101, so we don't serialize status at all in that case." So the
   sender-side Response does **not** need to be a 101 — a plain 200 `new Response(null)` works.
3. **The socket is duck-typed.** `webSocketToStreams` (`src/websocket-streams.ts:82-150`)
   accepts the private `WebSocketLike` interface (`:33-40`): `send`, `close`,
   `addEventListener`, optional `accept?.()`, optional `binaryType`. Nothing requires a workerd
   `WebSocket`. Frames start flowing **at serialization time** — the readable half is shipped as
   a pipe (`Exporter.createPipe`, `src/rpc.ts:719-738`) that begins pumping immediately, before
   the receiver knows it's coming. Close travels in-band as a final `{close: {code, reason}}`
   chunk.
4. **The fork's own Node tests already do this.** `__tests__/websocket-tunnel.test.ts:14-19`
   defines `responseWithWebSocket(socket)` = `new Response(null)` +
   `Object.defineProperty(response, "webSocket", { value: socket })` — with the comment "we
   attach the (non-standard) `webSocket` property the same way the Workers runtime does" — and
   `openEcho` (`:73-74`) attaches a live `ws`-package _client_ socket dialed at a localhost
   server: **literally the `iterate tunnel` proxy shape, green in fork CI today.**
5. **The receive side needs nothing.** The platform's relay (workerd, 0.12.0) materializes the
   tunneled socket as a native `WebSocketPair` half (`makeUpgradeResponse`,
   `src/websocket-streams.ts:359-372`), which satisfies the platform's `ProviderSocket` contract
   (`src/core/fetch-capabilities.ts:173-181` — `addEventListener` message/close, `send`,
   `close`, optional `accept` called LAST) exactly; the dedicated upgrade leg carries it to the
   DO and the DO mints the eyeball pair. All proven green.

**The experiment (2026-08-31).** A scratch harness test ran the full tunnel scenario with
spelling (4): Node capnweb provider on `/api`, undici client socket to a local hand-rolled
RFC 6455 echo server, plain Node eyeball WebSocket on
`/cap?ctx=…&cap=itx.bla`. Result on published 0.12.0: `{"opened":true,"echo":
"local-echo:hello-through-tunnel","closeCode":1000}` — fully green. The clean close surfaced one
**real platform bug** (not a fork bug): `handleWebSocketClose` closed only the _peer_, never
echo-closing the initiating socket, and workerd's hibernatable API does not auto-complete a
peer-initiated close handshake — the initiator hung until timeout. Fixed in
`fetch-capabilities.ts` (commit `1a402e4e3`); `ws-fetch-live-101` had never caught it because it
closes the eyeball without asserting the close event returns.

## 3. Kenton's recorded guidance

All of it, sourced. He has reviewed exactly this feature area twice on our fork PR #1 and owns
the upstream slot it fills.

- **No new positional wire elements.** On PR #1's protocol change he wrote: "Don't add a fourth
  parameter. Instead, add a `webSocket` property to `init`."
  ([iterate/capnweb#1, r3352791694](https://github.com/iterate/capnweb/pull/1#discussion_r3352791694))
- **Build on streams; frames must flow at serialization time.** He suggested representing the
  socket as a `ReadableStream`/`WritableStream` pair to "reduce the complexity considerably"
  rather than a parallel tunnel type, and rejected the listener-as-RPC approach because the
  receiver would need "a full network round trip … to start actually receiving messages" —
  frames should stream "even before the other end knows they are coming."
  ([r3352806937](https://github.com/iterate/capnweb/pull/1#discussion_r3352806937)) Both points
  are what the fork implements today.
- **He reserved the slot himself.** The `init.webSocket` carve-out is Kenton's own protocol.md
  text (upstream commit `e0d2f1d`, PR #135): not supported "though that may change if
  `WebSocket` gains support for serialization" — still verbatim on upstream `main`. Filling the
  reserved slot with his suggested representation _is_ the anticipated evolution
  (upstream tracks it as capnweb#187, open).
- **Flow control is non-negotiable.** He rejected a community streams PR for doing RPC-per-read
  (~40 KB/s at 100 ms RTT arithmetic —
  [capnweb#94](https://github.com/cloudflare/capnweb/pull/94#issuecomment-3468353576)) and
  shipped his own eager-pipe design
  ([#132](https://github.com/cloudflare/capnweb/pull/132), fixed 256 KiB windows at first;
  adaptive BDP windows landed in a follow-up, on upstream `main` today). A tunneled upgrade
  riding the stream pair inherits all of this; any bespoke frame channel would have to re-earn
  it.
- **Runtime concerns stay in the runtime.** His long-term topology: capnweb terminates in a
  stateless worker; DOs see only Workers RPC; hibernatable/restorable stubs come from workerd
  ([capnweb#36](https://github.com/cloudflare/capnweb/issues/36#issuecomment-3334955335), and
  the 2026-03-11 follow-up). The fork patch should stay a pure serialization feature and grow
  no session-lifetime machinery.
- **Sockets over workerd JS RPC are a TODO, not a refusal.** On the DataCloneError he wrote
  that it's "an unfinished TODO for RPC" and "Using `fetch()` is the appropriate work-around
  until then" ([workerd#2319](https://github.com/cloudflare/workerd/issues/2319#issuecomment-2186994442))
  — i.e. the fetch-shaped upgrade answer is the sanctioned pattern in the meantime.
- **Nothing in his record argues against a client-side answer primitive.** If anything the
  stream-pair representation he asked for is exactly what makes the answer constructible
  off-workerd: a provider needs two streams and the `init.webSocket` marker, never
  `WebSocketPair` or a 101 constructor.

## 4. The design space

### Option 0 — do nothing; document the expando spelling (userland)

Ship no fork change; the tunnel CLI writes `Object.defineProperty(new Response(null),
"webSocket", { value: socket })` itself.

- **Pros:** zero LOC; measured working today.
- **Cons:** the spelling is test-only and unblessed — it depends on three serializer behaviors
  (property read, status suppression, duck-typing) that nothing public promises; every consumer
  rediscovers the subtleties (the `accept()` timing, the frames-dropped-between-open-and-
  serialization window for `accept`-less sockets, `webSocket`+body = TypeError); and the
  endpoint case (device/ESP32-style, where the provider _is_ the server and has no underlying
  socket) still has no pair to attach — everyone hand-rolls a buffered crosswired pair, which
  is exactly the subtle part.
- **Verdict:** unacceptable as the end state; fine as the interim it already is.

### Option A — bless the spelling + ship a pure-JS pair (RECOMMENDED)

Two exports from the fork, sender-edge only:

```ts
/** The blessed way to ANSWER a fetch with a WebSocket upgrade, on any runtime. On workerd this
 *  is `new Response(null, { ...init, status: 101, webSocket: socket })`; elsewhere it is a
 *  status-200 Response carrying `webSocket` as an own-property — equivalent on the wire, since
 *  an upgrade's status is never serialized. `init.headers` (e.g. a negotiated
 *  Sec-WebSocket-Protocol) rides along. */
export function upgradeWebSocketResponse(socket: WebSocketLike, init?: ResponseInit): Response;

/** A pure-JS WebSocketPair with workerd semantics: two crosswired socket halves, born OPEN
 *  (no "open" event ever fires), each buffering inbound messages until its `accept()` is
 *  called. Use it when the provider IS the endpoint (no underlying socket to pass through). */
export class WebSocketPair { 0: WebSocket-like; 1: WebSocket-like }
```

- The **passthrough case** (tunnel CLI) becomes one call — capnweb's `webSocketToStreams` _is_
  the bridge (message pumping both ways, in-band close records, reserved-close-code handling,
  receiver-cancel → local close):

  ```js
  const local = new WebSocket(`ws://127.0.0.1:3000${url.pathname}${url.search}`);
  await new Promise((res, rej) => {
    local.addEventListener("open", res, { once: true });
    local.addEventListener("error", () => rej(new Error("local dial failed")), { once: true });
  });
  return upgradeWebSocketResponse(local);
  ```

- The **endpoint case** (device / ESP32-in-JS / CLI-terminated) becomes the workerd idiom,
  verbatim:

  ```js
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].addEventListener("message", (e) => pair[1].send(`device-echo:${e.data}`));
  return upgradeWebSocketResponse(pair[0]);
  ```

- **Pros:** smallest possible surface that closes both pinned scenarios; zero wire change (a
  0.10/0.12 receiver can't tell the difference); zero receiver/serializer change; satisfies
  every Kenton constraint by construction (socket in `init.webSocket`'s reserved slot, existing
  stream serialization, frames flow at serialization); the pair shim doubles as the fix for the
  passthrough hello-drop race (wrap a speak-first server's socket at open, hand `pair[0]` to
  the response); workerd code and non-workerd code become _the same code_.
- **Cons:** ~2 new public names on a fork whose discipline is to stay small; the pair shim's
  buffer-until-accept semantics must be exactly workerd-faithful or subtle bugs follow (that is
  precisely why it should be written once, in the fork, next to `TunneledWebSocket` which
  already implements 90% of the shape).
- **LOC:** helper ~10–15; pair ~60–80 (largely reusing `TunneledWebSocket`'s buffering); tests
  ~150 (echo, buffer-until-accept, close both directions, the one-send rule, session battery
  over a pair-backed tunnel).

### Option B — make `DeferredWebSocketUpgrade` constructible (the "dual of PR #7")

Superficially symmetric: PR #7 lets a receiver _carry_ the pair form, so let a sender
_construct_ it.

- **Cons (fatal):** the byte-framed pair exists solely to cross **workerd-RPC hops on the
  receive side**; on the capnweb wire the tunnel rides _value_ streams, so the devaluator would
  need a new branch that **decodes** the app's byte framing back into value chunks — machinery
  that encodes-then-decodes for nothing. It would also promote a deliberately internal framing
  into public API, against its own documented contract ("the encoding is a contract between two
  versions of this library, not an API"). And `webSocketToStreams` requires a `WebSocketLike`
  (`addEventListener` etc.) — a stream pair physically doesn't fit the sender door.
- **Verdict:** rejected. The symmetry is at the _edge_ (a socket-like thing), not at the
  framing.

### Option C — a full client-side `WebSocket` polyfill / WHATWG surface

Ship a complete WebSocket implementation (URL constructor, protocols, bufferedAmount, …) so
"anything socket-shaped" works everywhere.

- **Cons:** massive surface for zero additional capability — the serializer duck-types already,
  so real sockets (undici, `ws`, browser) pass through untouched; only the _pair_ is missing.
  Freezes semantics the platform doesn't need and Kenton's fork-discipline instinct would
  reject.
- **Verdict:** rejected; Option A's pair is the 10% that's actually absent.

### Option D — wait for workerd to carry sockets over JS RPC

- **Cons:** timeline explicitly unowned ("I've been known to fail to get to the things I want
  to get to", workerd#2319) — and **it doesn't even solve this problem**: workerd-native socket
  serialization removes internal-hop restrictions on _workerd_, but a Node CLI or an ESP32
  still needs a way to answer an upgrade over the _capnweb wire_. The sender primitive stays
  necessary in every future.
- **Verdict:** rejected as a blocker; keep championing it for the platform's fence delete-day
  (it deletes the upgrade leg, not this primitive).

### Also considered: exporting a `bridge(a, b)` frame-shuttle helper

Rejected as fork surface: with `upgradeWebSocketResponse` accepting a raw connected socket, the
common tunnel case has **no bridge at all** (capnweb is the bridge), and the residual wiring
(pair ⇄ second socket, ~8 lines) embeds app policy — close-code mapping, error wording — that
the fork shouldn't freeze. Our own no-framework doctrine, applied to the fork.

## 5. The recommended patch, precisely

**Where:** `iterate/capnweb`, branch `rebase-0.12` (NOT the PR #7 branch — it sits on stale
pre-0.12 `main` and would strand the feature behind PR #7's own rebase). Own small PR;
changeset `minor` (new API, no behavior change) → publishable as the next `@iterate-com/capnweb`.

**What:**

1. `upgradeWebSocketResponse(socket, init?)` in `src/websocket-streams.ts`, exported from
   `src/index.ts`. Implementation mirrors the two existing receiver branches of
   `makeUpgradeResponse` (`:359-372`): workerd → native init spelling; elsewhere →
   `new Response(null, init)` + `defineProperty`. Throws if `init` carries a body-bearing
   status/body (the serializer's `webSocket`+body TypeError, surfaced early with a good
   message).
2. `WebSocketPair` (pure JS) in `src/websocket-streams.ts`, exported. Two crosswired
   `WebSocketLike` halves with workerd-faithful semantics: born OPEN; `accept()` starts
   delivery and replays buffered messages **asynchronously** (never synchronously inside
   `accept`); `send` before the peer's accept buffers unboundedly (workerd behavior);
   `close(code?, reason?)` delivers a close event to the peer once, both halves then CLOSED;
   `addEventListener`/`removeEventListener`/`on*` accessors matching `TunneledWebSocket`'s
   surface. On workerd the export should simply alias the native `WebSocketPair` so there is
   exactly one behavior per platform.
3. Docs: a short "Answering upgrades" section in the fork README/protocol notes, stating the
   status-suppression rule and the one-send rule ("A WebSocket can only be sent over RPC
   once"), and blessing the two postures for passthrough sockets:
   - _await-open, then answer_ (recommended default; a dial failure surfaces as a non-101
     error answer; note the hello-drop window for servers that speak first), or
   - _wrap in `WebSocketPair` at open_ (covers speak-first servers: the pair buffers).

**What explicitly does NOT change:** the wire (protocol.md already specifies the form), the
serializer, the receive path, `TunneledWebSocket`, PR #7's branch, and the platform.

**Version plumbing after publish:** bump `packages/v3/project-worker` (`capnweb:
npm:@iterate-com/capnweb@^0.12.0` → the new version) and — for the real CLI home —
`packages/iterate/package.json`, which today pins `^0.10.0` (as do apps/os and the rest of the
monorepo; they can follow independently, the wire is compatible throughout).

## 6. Acceptance criteria

1. `failing-tunnel-proxy.test.ts`'s `test.fails` flips green by swapping the provider's upgrade
   branch to the one-call answer (§4 Option A's first snippet). Its two green layers and the
   probe's blocker assertions get retired/rewritten to pin the blessed API instead.
2. `failing-ws-fetch-capability.test.ts`'s `test.fails` flips green with the pair-shim device
   (§4's second snippet); its layer-3 probe rewrites to assert the blessed path.
3. **Zero platform changes** beyond the already-landed close-echo fix — verified against the
   relay contract: `dialLiveCapabilityFetch` reads only `response.webSocket` truthiness (never
   status), touches only the `ProviderSocket` surface, and calls `accept?.()` last; a
   0.12-line workerd receiver materializes a native pair half that satisfies all of it (proven
   by the experiment and by `ws-fetch-live-101`).
4. Fork-side: the session battery runs over a `WebSocketPair`-backed tunneled socket; close
   codes/reasons round-trip both directions; the one-send rule throws synchronously.
5. A **speak-first** localhost server fixture (sends a hello frame immediately on connect)
   tunnels without frame loss via the wrap-in-`WebSocketPair`-at-open posture — the exact race
   the pair shim is sold as fixing (§5.3); without this fixture the promise ships untested (both
   pinned scenarios use speak-second echo servers).

## 7. The ESP32 / C-client view (why this is wire-complete)

The primitive adds **nothing to the wire**, so a firmware client implements upgrade-answering by
emitting already-specified message forms (fork `protocol.md:218-222`):

- Resolve the pipelined `fetch()` with `["response", null, init]` where `init.webSocket =
{"readable": ["readable", <importId>], "writable": <writable expr>}` — body `null`, **no
  status** (the upgrade implies it).
- Outbound frames: send `["pipe"]` to mint the readable's import id, then pump messages as
  ordinary stream writes — text frames as strings, binary as `["bytes", base64]` — flowing
  immediately, no round trip (Kenton's rule, free of charge).
- Inbound frames arrive as writes on the exported writable end. Closure is the in-band final
  chunk `{"close": {"code", "reason"}}`; end-without-close reads as 1005; stream abort is
  socket failure. Flow control comes from the stream windows.

The JS primitive is merely the convenience constructor for JS runtimes; the fork's
session-battery-over-tunneled-socket test already proves the tunneled socket is
transport-equivalent end to end.

## 8. Adjacent facts worth deciding deliberately (not part of this patch)

- **PR #7 is orthogonal but colliding.** It flips the **workerd receiver default** to the
  deferred pair form. If the platform ever adopts a release containing it, the relay's
  `response.webSocket` stops being a socket and `dialLiveCapabilityFetch`'s `wire()` throws.
  Either pass `{ deferUpgradeMaterialization: false }` where the `/api` session is created
  (`src/worker.ts` — the relay genuinely is the endpoint under today's architecture), or adopt
  PR #7's intended integration: forward the pair over the Invoker Workers-RPC leg and
  `materializeUpgrade()` in the DO, which would replace the fenced upgrade-leg mechanism — **but
  at a measured cost the fence exists to avoid**: `materializeUpgrade` pumps via in-memory
  listeners, so the DO stays resident for every open tunnel and open upgrades no longer survive
  eviction, whereas today's leg + eyeball sockets are both hibernatable (the dead end was
  measured — `ws-fetch-live-101.test.ts`'s header records that stream-passthrough pins the DO
  non-evictable, and the sibling doc's operational note says the same of a materialized tunnel).
  So the PR #7 path is a hibernation regression, not a pure deletion; the fence's true delete-day
  remains workerd carrying sockets over plain RPC. The sender primitive is independent of all of
  this and needed in every world.
- **The publish requires Jonas** (npm web-OTP, as with 0.12.0).
- **Upstreaming:** upstream `main` has no websocket-streams at all (capnweb#187 open), so the
  primitive upstreams only as part of the whole WS-over-RPC feature — whose wire shape already
  matches Kenton's recorded guidance and fills the slot he reserved. When that conversation
  happens, this spec's §3 is the evidence file.
