# Don't pin streams: research + design for wake-channel subscriptions

Researched 2026-08-03. Question: always-on ESP32 devices (and browser tabs)
must be able to stay subscribed to a stream without pinning the Stream
Durable Object (~$4.11/month per always-pinned DO). Kenton Varda has said
Workers RPC will eventually be hibernatable; until it is, can the stream RPC
target sever the Workers-RPC leg after inactivity and fall back to a
hibernatable WebSocket that wakes the subscriber when a new event arrives?

Short answer: yes, and the shape falls out of seams that already exist. The
capnweb socket already terminates at the stateless `os` worker, the worker
already terminates the callback leg instead of forwarding it to the client,
and the Stream DO already has idle teardown + re-dial machinery for hosted
connections. The missing pieces are: (1) extend idle teardown to session
connections that have a wake socket, (2) a greenfield `fetch` upgrade handler
on `StreamDurableObject` that accepts a hibernatable wake socket, (3) a
worker-side relay that re-dials `openConnection({ replayAfterOffset })` when
the wake socket fires. The client protocol does not change.

Naming note: an earlier draft called idled-with-wake-socket connections
"parked". That word is taken — `stream/subscription-parked` is an existing
durable fact meaning a durable subscription exhausted its retries
(quarantine), itx-session "parks" generations on terminal auth failure, and
parked also describes 503'd worker routes and broken-with-expiry tests. No
new state noun: a connection simply closes with the existing reason
`"idle"`, and the new artifact is **the wake socket**.

---

## 1. The evidence: Kenton Varda's stated plan

The architecture Jonas remembered is real, public, and repeatedly stated.
Tracking issues are open with no implementation as of 2026-08-03.

**capnweb #36 "WebSocket Hibernation" (OPEN)** —
<https://github.com/cloudflare/capnweb/issues/36>

- 2025-09-23: "At this time, it does not [support hibernation]. But this is
  definitely something we want to fix!"
- 2025-09-25 (the canonical statement): "I don't think the solution is for
  Cap'n Web itself to try to support hibernation, but rather for us to extend
  the way hibernation works in the Workers Runtime, so that RPC stubs are
  hibernatable. What you'd do then is use Cap'n Web between a browser and a
  stateless worker, which in turn uses Workers built-in RPC from there to the
  DO. Workers RPC would then need to support hibernating RpcTargets and
  storing stubs through hibernation."
- 2025-11-24 (precise pinning semantics): "Holding a DO stub does not prevent
  hibernation. … It's only while calls are active that it won't be able to
  hibernate. Or if you hold stubs pointing at functions or RpcTarget objects
  in the DO's isolate."
- 2026-03-11 (the three-part long-term design): terminate Cap'n Web in a
  Worker, not a DO; DOs create/return stubs "marked in such a way that the
  system knows how to recreate them after hibernation"; DOs "store outbound
  RPC stubs into a space that survives hibernation, e.g. to maintain a list
  of current subscriber callbacks."

**workerd #6087 "Support for Hibernatable RPC Targets" (OPEN, filed
2026-02-16)** — <https://github.com/cloudflare/workerd/issues/6087>

- Kenton, 2026-02-25: "Yes, this is something I plan to work on, perhaps next
  quarter. It's a big project, though." (That quarter has passed; no PRs, no
  compat flag, no changelog entry through July 2026.)

**capnweb reconnection: none.** capnweb #58 closed without a feature;
`onRpcBroken()` is the entire disconnect story. Kenton on HN (2025-09-22,
<https://news.ycombinator.com/item?id=45336098>): session state lives and
dies with the transport; "It should be possible to reconnect and reconstruct"
capabilities at the application layer. So a hibernatable channel cannot carry
a capnweb session; it must be a dumb wake/delivery channel plus app-level
resume — which our `replayAfterOffset` already is.

Adjacent shipped work: workerd PR #5733 (compat flag `rpc_params_dup_stubs`,
Dec 2025) fixed stub lifetimes on exactly the capnweb→stateless-worker→DO
conversion; workerd #4864 (hibernation for *outbound* WebSockets) remains
open ("deep architectural changes"). A community fork (SamJB123) hibernates
capnweb sessions via `serializeAttachment` + protocol change; Kenton called
it "a cool hack, though a bit different from what I intended as the long-term
approach" — not a foundation to build on.

## 2. Platform facts that bound the design

All confirmed against current docs (pricing, lifecycle, WebSockets guide,
state API pages on developers.cloudflare.com).

- **Duration billing**: 0.125 GB × wall-clock × $12.50/M GB-s ⇒ one DO pinned
  24/7 ≈ **$4.11/month** marginal (400k GB-s/month included on paid ≈ 1.2
  pinned DOs). "Durable Objects that are idle and eligible for hibernation
  are not billed for duration, even before the runtime has hibernated them."
- **What blocks hibernation**: in-flight requests/events, `setTimeout`/
  `setInterval`, standard-API WebSockets (`ws.accept()`), outbound TCP/WS
  (since 2026-06-19 these hold the DO up to 15 min, billed), and any live
  RpcTarget/function stub into or out of the DO (RPC lifecycle doc: passed
  stubs extend the execution context until disposed). A plain
  `DurableObjectStub` does *not* pin.
- **Hibernatable WebSockets**: `ctx.acceptWebSocket(ws, tags)` (≤10 tags,
  ≤256 chars each; 32k sockets/DO), `webSocketMessage/Close/Error` class
  handlers, `serializeAttachment` (≤16 KiB, survives hibernation),
  `getWebSockets(tag)`, `setWebSocketAutoResponse` (ping/pong answered
  **without waking or billing**). Incoming WS messages billed 20:1 as
  requests; outgoing sends free. The DO cannot spontaneously send while
  hibernated — but any wake (append RPC, alarm, WS message, WS close) lets it
  `getWebSockets().send()`.
- **Upgrade routing**: a 101 + `webSocket` cannot cross an RPC method call —
  only real `fetch()` on a stub tunnels an upgrade (documented in-tree at
  `worker-runner.ts:147-153`, `worker-fetch-dispatch.ts:15-25`). Hibernation
  works fine when the upgrade was forwarded via `stub.fetch()`.
- **Stateless Workers**: bill requests + CPU only — "No charge or limit for
  duration." Holding a WebSocket open costs nothing while idle. The
  connection is non-durable (isolate eviction, redeploys) and the client owns
  reconnect — which itx sessions already do invisibly. When the client
  disconnects, the worker's execution context is canceled immediately and
  everything it held (stubs, socket client ends) is released (RPC lifecycle
  doc; Kenton in capnweb #110).
- **Alarms** wake hibernated DOs (at-least-once, retries with backoff);
  alarm invocations bill as requests.

## 3. Where our code stands today

Topology (post worker-split-revert): one `os-<env>` script hosts the
dashboard, the `/api` capnweb termination, and every DO class, same-script.

```
device / browser
  └─ ONE capnweb WebSocket → wss://…/api          itx-session.ts:386,421 / firmware voicelab_stream.c
      └─ stateless os worker fetch handler         worker.ts:286 (newWorkersWebSocketRpcResponse)
          └─ …session.projects.get(slug).streams.get(path) → StreamRpcTarget   rpc-targets.ts:1180/:554
              └─ env.STREAM.getByName(name)        rpc-targets.ts:592  ← the Workers-RPC hop
                  └─ StreamDurableObject           stream-durable-object.ts:388
```

- `StreamRpcTarget.openConnection` (`rpc-targets.ts:950`) **already
  terminates the callback leg at the worker**: it retains the client's
  `processEventBatch` (`retainProcessEventBatch`,
  `retained-event-callbacks.ts:36`) and hands the DO a worker-local
  forwarding closure (`rpc-targets.ts:994-998`). The client leg and the DO
  leg are already decoupled — severing the DO leg is invisible to the client.
- The Stream DO's `StreamConnections` pump (`stream-event-sender.ts:1971`,
  `while (open)` at `:1975`) retains that worker closure for the connection's
  life. That retained stub is the pin.
- **Idle teardown exists but only for hosted connections.**
  `#hostedConnectionKeys()` filters `kind === "hosted"`
  (`stream-event-sender.ts:1871-1875`); with zero hosted connections the idle
  deadline is cleared entirely (`:1832-1836`). Default window 5 min
  (`STREAM_IDLE_TEARDOWN_MS`, `stream-durable-object.ts:1700-1704`). Hosted
  re-dial after idle is driven by the next real append via the
  `#hostedIdledAtOffset` gate (`stream-event-sender.ts:505-509`), and every
  cold boot appends `stream/woken` whose fan-out restores deliveries
  (`stream-durable-object.ts:593-598`).
- **Session connections (browsers, devices, the voicelab bridge) have no
  idle teardown at all** — an open tab or an always-on device pins its Stream
  DO for the session's life. This is the exact "outbound-only by design;
  decide outbound-vs-inbound later" deferral in
  `apps/os/tasks/do-duration-leak/DECISION_LOG.md:256`, and the hibernatable
  transport was Option 3 in `ALTERNATIVES.md:50-58` ("Revisit if we want idle
  billing → 0").
- **Idle teardown already fought the self-wake loop.** `runIdleTeardownNow`
  advances settled connections' cursors *through its own just-appended
  `connection-closed` facts* (`stream-event-sender.ts:1861-1865`), with a
  comment naming the exact `close → wake → open → idle-close` loop it
  prevents. Any new wake path must preserve this property.
- **No hibernation API usage anywhere in the repo** (zero grep hits for
  `acceptWebSocket` etc. across worktrees), and `StreamDurableObject` has no
  `fetch` handler at all — the wake socket is greenfield and collides with
  nothing.
- DO-hosted processors (agents, repos, …) are *not* part of this problem:
  `wakeStreamProcessor` dials them by DO name, the wake call itself boots
  them, and idle teardown + keepalive already bound their pinning.

### What one idle connected device pins today

Production kit shape (c-capabilities, dual socket): **no Stream DO**, but
per project: the CapabilityHost DO (holds `.dup()`ed device stubs for live
mounts, `live-capability.ts:57-70`) and the KitVoiceWorker
StatefulWorkerDurableObject (terminates `/pcm` with non-hibernatable
`server.accept()`, `config-worker/worker.ts:360-364`), plus two free
stateless-worker sockets.

Voicelab/streams shape (PR #2376, and any "device subscribes to a
conversation stream" future): the **Stream DO is pinned indefinitely** by the
session connection, plus the bridge's StatefulWorkerDurableObject in detached
mode (`ctx.waitUntil` anchor, `voice-agent.ts:1713-1720`).

## 4. Design: idle teardown for session connections, backed by a wake socket

Steady state after the change — client protocol unchanged:

```
device / browser ── capnweb WS ──> os worker (stateless, $0 idle)
                                     │  RPC leg: only while events flow   ──> Stream DO (pinned)
                                     │
                                     └─ wake socket: env.STREAM.getByName(n).fetch(upgrade)
                                          └─> StreamDurableObject.fetch → ctx.acceptWebSocket
                                              (DO hibernated, $0 idle)
```

**Subscribe** (`openConnection` in the worker relay) opens both legs: the
normal RPC connection for replay + live delivery, and in parallel a wake
socket to the same DO via the stub's real `fetch()` (same-script, satisfies
the no-101-over-RPC rule). The wake socket is tagged with the
`connectionKey`; its `serializeAttachment` carries `{ connectionKey,
expectedStreamId, eventTypes/filter spec, deliveredThroughOffset,
wakeSentAtOffset }`.

**Idle close**: extend `runIdleTeardownNow` (`stream-event-sender.ts:1841`)
to also close idle *session* connections that have a live wake socket.
Closing the RPC connection disposes the retained callback — the DO's last
pin. The DO stamps its own delivered-through cursor into the wake socket's
attachment, advanced **through the just-appended `connection-closed` facts**
(the existing loop-breaker at `:1861-1865`, reused). With only hibernatable
sockets left, the DO hibernates ~10 s later and bills nothing.

**Wake**: an append necessarily runs inside the DO (it is an inbound call),
so the DO is already awake exactly when there is news — no alarm needed. In
`#reconcileCommittedState` (`stream-durable-object.ts:1038`), after sends:
for each wake socket whose subscriber **would consume** one of the
just-committed events (filter-aware — see loop breakers) and whose
`deliveredThroughOffset` is behind, send one frame
`{ type: "wake", replayAfter: deliveredThroughOffset }` (outgoing sends are
free) and record `wakeSentAtOffset` so repeated appends don't re-spam a
relay that hasn't re-dialed yet.

**Resume**: the relay (whose wake-socket client end lives inside the same
worker invocation the capnweb session keeps alive — free) receives the frame
and re-dials `openConnection({ replayAfterOffset })` from the delivered
cursor it tracked from batch `scannedThroughOffset`s. Catch-up comes from the
durable event log, so at-most-once wake frames are sufficient — delivery
guarantees stay where they already live, in batch delivery. Duplicate
delivery across the seam is possible (session callbacks are fire-and-forget)
and is handled the same way it is today: client-side offset dedupe
(`replayAfterOffset`/`maxReplayOffsetGap` in the browser store, offset
tracking in firmware).

Two details the implementation surfaced beyond the sketch above:

- **The idle frame.** Closing the RPC connection releases the DO's retained
  callback, but the *relay* still holds its `StreamConnectionHandle` stub — a
  live reference into the DO's isolate that blocks hibernation all by itself
  (exactly Kenton's "stubs pointing at RpcTarget objects in the DO's
  isolate"). So idle teardown also sends `{"type":"idle"}` on the wake
  socket, and the relay disposes its handle stub on receipt. The handle the
  *client* holds is relay-local on purpose, so its `ping()` reflects the
  logical subscription (true while dormant; while live it probes the DO leg).
- **Unstamped sockets are wake-eligible.** A wake socket whose connection is
  absent but whose attachment has no dormancy stamp means the RPC leg died
  without the idle protocol — DO eviction mid-live, a delivery-failure close.
  Its cursor is unknown, so any qualifying domain append wakes it and the
  relay re-dials from its own exact cursor. The wake path thereby doubles as
  eviction recovery for session subscribers — better than today, where only
  the client-side ping watchdog notices a dead connection.

### Loop breakers

The feared loop: idle-close appends `connection-closed` → append bumps
`maxOffset` → wake predicate fires → relay re-dials → connection delivers
the closed fact → idles → close appends → repeat. Three layers prevent it:

1. **Cursor stamped past self-generated facts** (exists): the teardown
   already advances the cursor through its own `connection-closed` appends;
   the attachment stamp inherits that. The close facts can never be "news"
   for the connection they closed.
2. **The wake predicate skips stream lifecycle events** (new): `stream/woken`
   and `connection-opened/closed` do not trigger wake frames unless the
   subscriber's filter explicitly requests those types. Without this, every
   cold boot of the DO (any read appends `stream/woken`) would resurrect
   every unfiltered subscriber for a full idle window — not infinite (each
   cycle needs an external touch) but a resurrection storm that re-pins the
   DO 5 minutes per touch per subscriber. Precedent: the #1518 re-dial gate
   excluded exactly the self-undoing `subscriber-disconnected` event; today's
   hosted gate is offset-only because a redundant hosted wake is a cheap RPC,
   which is not true here. Deferred lifecycle facts are not lost — the next
   real wake replays them from the stamped cursor.
3. **One wake per idle period** (new): `wakeSentAtOffset` suppresses further
   frames until the relay re-dials or the socket closes, so a dead relay is
   never spammed and a wake can never race its own re-dial into a cycle.

A regression test asserts the quiescent fixpoint directly: idle-close, then
observe zero wake frames and no re-dial; touch the stream with a read, assert
`stream/woken` wakes no filtered subscriber; append one domain event, assert
exactly one wake frame, one re-dial, one delivery, and re-idle.

### Presence: the wake socket is the presence lease

Requirement (Jonas): a browser/device must stay "present" while its real
connection is up, and presence must drop only when that connection is
severed — and this must not move presence logic out of the Stream DO.

The wake socket gives this transitively, with the DO remaining the sole
authority:

- Lifetime chain: client capnweb WS ⇔ worker execution context ⇔ wake-socket
  client end. When the client disconnects, the worker's execution context is
  canceled immediately (documented; Kenton in capnweb #110), which closes the
  wake socket, which delivers `webSocketClose` **to the DO** (a
  hibernation-waking event). The DO records the departure durably. There is
  no path where the wake socket outlives the client's connection.
- Presence reads stay DO-side: `ctx.getWebSockets(tag)` + attachments
  enumerate present subscribers even while hibernated (a presence query
  briefly wakes the DO like any read). The stream panel already renders
  asleep rows (`stream-view-header.tsx:102`); `ConnectionRuntimeState` grows
  a wake-socket-backed entry kind.
- Audit semantics: `connection-closed reason:"idle"` no longer means
  "subscriber left" — it means the delivery lane went dormant. Departure is
  the `webSocketClose`-driven fact. Presence consumers key on the latter.
- What the relay does: opens the socket, echoes `replayAfter`, re-dials.
  Idle policy, wake predicate, filter matching, cursor bookkeeping, and
  presence all stay in the DO/sender where they live today. The relay is
  *less* stateful than the current one (which already retains the forwarding
  callback for the session's life).
- Known blip: a worker redeploy/isolate eviction kills the execution context,
  so presence drops for the seconds until the client's invisible reconnect
  re-establishes both legs. Presence UIs should debounce departures by a few
  seconds (they already tolerate reconnect generations).

### Why relay-side (not device-side) wake sockets

Jonas's original sketch had the *device* hold the parallel hibernatable
socket. Putting it in the worker relay instead dominates:

- Zero client changes — firmware, browser store, voicelab bridge all keep
  their single capnweb socket. Browsers get unpinned for free (every open
  dashboard tab today pins a Stream DO with no idle window — fixing that
  fleet-wide is probably worth more than the device fleet).
- The device keeps ONE TLS socket (ESP32 RAM: each TLS connection ≈ 40+ KB).
- Auth stays inside the trust boundary (internal header, same
  `x-iterate-worker-dispatch` precedent) instead of a bearer-in-query-param
  device socket.

A device-held wake socket becomes interesting only for a future
deep-sleep/battery mode where the device *drops* the capnweb session and
keeps a minimal socket; the DO-side machinery built here (tagged hibernatable
sockets + wake frames) is exactly reusable for that, with query-param bearer
auth per the `apps/streams-example-app/src/worker.ts:92-98` precedent.

### Delivering events over the wake socket?

Possible — the DO could push whole event batches as WS frames and skip the
re-dial. Deliberately deferred: it re-implements the pump's ack/retry/
watchdog semantics (`reportDeliveryResult`, in-flight watchdogs) on a second
transport, and saves only one same-script RPC dial per activity burst.
Wake-only keeps exactly-once-ish delivery where it already lives. Revisit if
wake→re-dial latency or dial volume ever shows up in metrics; the frame
format should leave room (`{type:"wake"}` today, `{type:"events", …}` later).

### Explicitly out of scope (but real, and adjacent)

1. **CapabilityHost live mounts** pin that DO by holding duped device stubs
   in memory (`live-capability.ts:57-70`) — Kenton's future "store outbound
   RPC stubs through hibernation" is precisely this; until then an always-on
   device mounting a live capability pins the CapabilityHost DO. A wake-shaped
   rework (device re-mounts on wake) is a separate design.
2. **KitVoiceWorker `/pcm`** uses `server.accept()` and pins its
   StatefulWorkerDurableObject per project. Whether userspace
   `IterateDurableObject` facets can reach `ctx.acceptWebSocket` through the
   platform host is an open question worth its own spike.
3. **liveState subscriptions** (`LiveStateRelayRpcTarget`,
   `rpc-targets.ts:7615`) pin the same way session connections do; the same
   wake-socket relay pattern applies but touches the live-state engine's diff
   protocol. Until that follow-up, v1 unpins the raw event lane (browser
   store, activity tail, command palette, devices) but a tab holding a
   liveState subscription still pins.

### Exit strategy

When hibernatable RPC ships (workerd #6087), the wake-socket layer is
deleted: `openConnection` callbacks become hibernation-surviving stubs and
the socket becomes redundant. Everything here is additive around the existing
connection state machine — no protocol breaks on the way in, a clean break on
the way out (no backcompat shims per house rules).

## 5. Minimal implementation (v1, ~300 lines + tests)

Four touch points, no wrangler/config changes (same-script stub `fetch`;
hibernation handlers are DO class methods):

1. **`StreamDurableObject.fetch`** (greenfield, ~100 lines): validate the
   internal dispatch header, `WebSocketPair`, `ctx.acceptWebSocket(server,
   ["wake", connectionKey])`, write the attachment, set
   `setWebSocketAutoResponse` ping/pong, return 101. Plus
   `webSocketClose`/`webSocketError` (append the departure fact, nothing
   else) and a no-op-for-now `webSocketMessage`.
2. **`StreamConnections`** (~40 lines): include wake-socket-backed session
   connections in the idle-candidate set (today's filter:
   `stream-event-sender.ts:1871-1875`); at teardown stamp the attachment
   cursor after the close-appends (reuse the settled-cursor block at
   `:1861-1865`).
3. **Wake step** in `#reconcileCommittedState` (~60 lines): after sends,
   match just-committed events against each wake socket's filter spec
   (skip lifecycle types), send `{type:"wake", replayAfter}`, record
   `wakeSentAtOffset`.
4. **`StreamRpcTarget.openConnection` relay** (~80 lines): open the wake
   socket via `this[STREAM_DURABLE_OBJECT_STUB].fetch(upgrade)` alongside the
   RPC leg, pass the wake-socket identity into `openConnection` so the DO
   ties socket↔connection; on wake frame, re-dial with
   `replayAfterOffset: frame.replayAfter` and splice the new connection into
   the same retained client forward.

Not touched in v1: browser store, firmware, voicelab bridge, liveState,
capability host, KitVoiceWorker.

## 6. Proof

"Hibernated" is not directly observable, so the proof ladder targets its
observable consequences: evictability, `stream/woken` on re-touch, and the
billing counters.

1. **Workerd e2e** (extend `stream-connections-and-subscriptions.e2e.test.ts`
   — the hosted idle/eviction cycle at `:1915` is the template, with
   `STREAM_IDLE_TEARDOWN_MS` shrunk): open a session connection with wake
   socket; deliver an append; pass the idle window; assert
   `connection-closed reason:"idle"` **while the client's capnweb session
   stays open**; append from a second client; assert the subscriber receives
   the new event with no client-side re-subscribe, offsets contiguous after
   dedupe, and audit shows the wake-provenance re-open.
2. **Eviction realism**: between idle and the next append, force-evict with
   the 2026-06 `evictDurableObject` vitest helper (keeping websockets).
   Constructor re-runs, `stream/woken` appends, attachment survives, the wake
   frame still carries the right `replayAfter`. This is the strongest local
   proxy for billing eligibility: a DO that can be evicted mid-idle and still
   wake its subscriber *is* in the hibernation-eligible state.
3. **Quiescence/loop regression** (the fixpoint test from §4): after
   idle-close, zero wake frames, no re-dial, no further appends; an unrelated
   read (`at()`) must not wake filtered subscribers; one domain append
   produces exactly one wake→re-dial→deliver→re-idle cycle.
4. **Eligibility introspection**: a test-only DO verb reporting live
   session/hosted connection counts, retained callbacks, pending deliveries,
   and armed alarm slices — asserted all-zero after teardown (guards against
   a future stray timer/stub silently re-pinning).
5. **Preview + billing counters** (the recipe that proved #1518): deploy to a
   preview slot, connect several browser tabs + a simulated device, leave
   idle 1–2 h, then (a) `pnpm probe:do-duration` must be clean (it flags any
   os-* DO invocation with >1 h wallclock), and (b) CF GraphQL
   `durableObjectsPeriodicGroups` activeTime ≈ zero outside append bursts,
   `durableObjectsInvocationsAdaptiveGroups` wallTime p99 for the stream DO
   in minutes (≤ idle window + delivery), not hours. Then append via CLI and
   watch the idle tab receive it live.
6. **Presence check**: while idled, presence query still lists the
   subscriber (from `getWebSockets`); kill the tab; `webSocketClose` wakes
   the DO; presence clears and the departure fact is on the stream.

## 7. Cost model

| shape | Stream-DO duration $/device-month (idle) |
| --- | --- |
| today, voicelab/session subscription | ~$4.11 (DO pinned 24/7; shared streams amortize across devices) |
| after idle teardown + wake socket | ~$0 — DO hibernated except append bursts; wake frames are free outgoing sends; idle sockets answer pings via auto-response without waking |
| worker side | unchanged ≈ $0 (CPU-only billing on both legs) |

Browser tabs on the raw event lane get the same reduction with zero client
work, which also removes the standing "dashboards pin stream DOs" tax that
#1518's hosted-only scope never covered (liveState lane follows later).

## References

- capnweb #36 <https://github.com/cloudflare/capnweb/issues/36> (quotes above);
  #58 (reconnect, closed), #110 (stub lifetimes through the stateless hop),
  #84 (dup of 36)
- workerd #6087 <https://github.com/cloudflare/workerd/issues/6087>;
  #4864 (outbound WS hibernation); PR #5733 (`rpc_params_dup_stubs`)
- HN: <https://news.ycombinator.com/item?id=45336098>,
  <https://news.ycombinator.com/item?id=45334797>,
  <https://news.ycombinator.com/item?id=38893425>
- Cloudflare docs: durable-objects platform/pricing, concepts lifecycle,
  best-practices/websockets, best-practices/rules-of-durable-objects,
  api/state, api/alarms; workers platform/pricing, runtime-apis/rpc/lifecycle
- In-tree: `apps/os/src/domains/streams/{stream-durable-object,stream-event-sender,retained-event-callbacks}.ts`,
  `apps/os/src/rpc-targets.ts`, `apps/os/src/worker.ts`,
  `apps/os/tasks/do-duration-leak/{DECISION_LOG,ALTERNATIVES}.md`,
  `apps/os/docs/stream-event-connections-and-subscriptions.md`
