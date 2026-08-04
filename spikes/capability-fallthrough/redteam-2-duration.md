# Red-team 2 — CONNECTION LIFETIME, DURATION & HIBERNATION

Adversarial review of the "everything is a capability host" design (`capability-host.mjs`,
`graph.mjs`, `gateway.mjs`; design doc §2a/§2c/§2d/§4). Domain: **TIME** — what a live
capnweb provider (Pi / browser / CLI) holding a WebSocket for hours-to-days costs, breaks,
and leaks. Verdict up front: **the design's headline case — "a Raspberry Pi that dialed OUT
and holds a long-lived bidirectional capnweb WebSocket session, possibly for days" — is the
single worst thing you can ask this stack to do.** It is a 24/7 billing meter that cannot be
turned off, on an isolate that cannot hibernate, with a session whose state cannot survive
the eviction that Cloudflare will eventually force on it, over a socket with no dead-peer
detection. Every one of those four clauses is proven below from source.

## The load-bearing facts (all verified in this repo / CF docs)

- **capnweb accepts WebSockets with `server.accept()`, NOT the Hibernation API.**
  `newWorkersWebSocketRpcResponse` → `server.accept()` (`dist/index.js:2648`); the tunneled
  path also uses `native.accept()` (`:1250`). A repo-wide grep for
  `acceptWebSocket|setWebSocketAutoResponse|serializeAttachment|webSocketMessage|hibernat`
  across **all** capnweb dist builds returns **zero hits**. capnweb is structurally unaware
  that the Hibernation API exists.
- **capnweb has no heartbeat, ping, or idle timer.** Zero `setInterval` in the entire dist;
  the only `setTimeout` is HTTP-batch scheduling (`:2745`). The session read loop
  (`readLoop`, `:2492`) is just `await Promise.race([transport.receive(), cancel])` forever.
  `WebSocketTransport` (`:2653`) only reacts to `close`/`error` events — it never _sends_
  anything to probe liveness. No ping/pong control-frame handling anywhere.
- **CF: hibernation requires `state.acceptWebSocket()` + `webSocketMessage/Close/Error`
  handlers.** "Unlike `ws.accept()`, `state.acceptWebSocket(ws)` allows the Durable Object to
  be hibernated." Ping/pong does not interrupt hibernation; control frames don't call
  `webSocketMessage`. (CF: Durable Objects → WebSockets.)
- **CF billing:** "Durable Objects are billed for compute duration (wall-clock time) while
  the Durable Object is actively running **or is idle in memory but unable to hibernate**."
  A hibernated DO with an open socket accrues **no** duration. A non-hibernatable in-memory
  DO is billed **wall-clock, continuously**. Rate: **$12.50 / million GB-s**, 400,000 GB-s/mo
  free (paid). (CF: DO pricing.)
- **CF: a stateless Worker treats an entire WebSocket session as ONE request for CPU limits**
  (capnweb README:501, echoing CF). Workers paid CPU cap = **5 min** (default 30s). A DO
  resets available CPU to 30s on _each_ incoming request/message, but **">30s of compute
  between incoming requests → heightened chance the DO is evicted and reset."** (CF: Workers
  limits; DO limits.)
- **capnweb GC "does not work well"** (README:427); the only sanctioned strategies are
  _explicit disposal_ or _short-lived sessions_ (README:439). No `FinalizationRegistry`
  (README:441). Import/export tables are plain arrays (`imports=[]`, `exports=[]`,
  `:2171-2173`); freed slots are `delete`d (`:2247`, `:2460`), IDs are monotonic
  (`nextExportId--` `:2176`; imports via `imports.length` push).
- **The design pins on purpose.** `provide()` stores `cap.dup()` **for the mount's lifetime**
  (`capability-host.mjs:54`); `resolve()` returns a fresh `cap.dup()` on **every** call
  (`:68`). A live mount is, by construction, a retained stub — i.e. a held import entry — i.e.
  a pinned session. There is no TTL, no disposal, nowhere.

---

## Ranked failure theories

### 1. The always-on duration meter — a connected-but-idle Pi bills 24/7 forever

**Mechanism.** A live mount is a `dup()`'d stub retained in the host DO's `#caps` map
(`capability-host.mjs:54`). Retaining the stub holds an import-table entry, which holds the
capnweb session, whose `readLoop` promise is perpetually pending. The socket was `accept()`'d,
not `acceptWebSocket()`'d, so the DO **cannot hibernate**. Per CF, a DO "idle in memory but
unable to hibernate" is billed wall-clock **continuously** — even with zero traffic.
**Trigger.** Any live provider that stays connected. The Pi/HA case (§2d) is _designed_ to
stay connected for days.
**Evidence.** `server.accept()` `:2648`; no hibernation symbols anywhere; CF pricing quote
above; `provide` dup-and-hold `:54`.
**Severity.** Catastrophic at fleet scale. Wall-clock GB-s is charged per DO-in-memory. One
always-connected device pinning one 128 MB-class DO at, say, an effective 64 MB resident =
0.0625 GB × 86,400 s/day ≈ **5,400 GB-s/day/device**. The 400k GB-s/mo free tier is exhausted
by **~2.5 devices running all month**. 10,000 always-on devices ≈ **54M GB-s/day** ≈
1.6B GB-s/mo ≈ **~$20k/mo in pure idle duration**, before a single message is sent. This is
the "storage ≈ 0, billed on routing" promise of §2d inverted: with capnweb you are billed on
**residency**, and residency is 100%.
**Cheap experiment.** Deploy the `HostDO`, open one capnweb WS from a Node client, send
nothing for 20 min, poll DO analytics (`wall_time`/GB-s) via GraphQL. Confirm the meter runs
flat with zero messages. (~30 min.)
**Mitigation.** Adopt the Hibernation API — **impossible without re-architecting capnweb**
(theory 3). Cheaper interim: don't hold live provider sockets in a DO at all; hold a _name_
(fork 9 "C"), redial on demand. Cost: live push (a Pi emitting every 1-2s) stops being "live"
— you lose the whole point of a persistent provider, and redial latency + auth cost per read.

### 2. No hibernation is _possible_ even if you wanted it — the transport forecloses it

**Mechanism.** Hibernation is gated on `state.acceptWebSocket()` plus `webSocketMessage`/
`webSocketClose`/`webSocketError` handler methods on the DO. capnweb's WS server helper calls
`server.accept()` and drives everything through an in-isolate `readLoop` + `addEventListener`
(`:2668-2681`). There is no seam to hand the socket to the DO runtime; the session _is_ the
event listeners. So even a design that wanted "idle Pi sleeps the DO" cannot get there with
this transport.
**Trigger.** Structural — true for every capnweb WS session, always.
**Evidence.** `:2638-2648` (`newWorkersWebSocketRpcResponse`); zero `acceptWebSocket` in dist.
**Severity.** High — it removes the _only_ CF-blessed escape from theory 1.
**Cheap experiment.** Grep (done). Or attempt to wrap: call `state.acceptWebSocket(server)`
then hand `server` to `new WebSocketTransport(server)` — observe that capnweb's
`addEventListener("message")` never fires because hibernation-accepted sockets deliver via
`webSocketMessage`, not events. (~1 h.)
**Mitigation.** Fork capnweb to add a hibernation transport (see theory 3 for why that is
deep, not shallow). Cost: a capnweb fork you now own + maintain.

### 3. Even a hibernation-capable transport would corrupt the session — capnweb state is unserializable in-memory-only protocol state

**Mechanism.** Hibernation "resets in-memory state" and "re-runs the `constructor`" on wake.
capnweb's entire session lives in isolate heap: `exports`/`imports` arrays, `reverseExports`
Map (`:2171-2173`), pending promise resolvers, `onBrokenCallbacks`, and every stub `Proxy`
with its captured closures. None of it is written to `serializeAttachment`/DO storage; there
is no rehydrate path. A DO that hibernated and woke would run `constructor`, find **empty**
tables, and every in-flight import/export ID from the peer would resolve to "no such entry on
exports table" (`:1864`, `:1896`, `:1906`) — the session is dead but the peer thinks it's
alive. So hibernation isn't merely unsupported; enabling it naively would **silently break
correctness**.
**Trigger.** Any hibernate→wake cycle on a DO carrying a capnweb session.
**Evidence.** CF: "In-memory state is reset… `constructor` runs" on wake; capnweb tables are
plain in-memory fields with `delete`-based freeing and no persistence hooks (grep: no
`serializeAttachment`/`storage` in dist).
**Severity.** High — this is _the_ reason "just make it hibernatable" is not a config flag.
It is why §2c's "the connection pins unless it's a hibernatable WebSocket" is optimistic: the
pinning session and the hibernatable-WS provider are **mutually exclusive transports**, not a
knob.
**Cheap experiment.** Build the fork from theory 2, force `state.abort()`/eviction mid-session
(or `DEBUG` evict), send a call from the peer, observe "no such entry on exports table". (~½ d.)
**Mitigation.** A hibernation-native provider protocol that persists a minimal resumable state
(subscription cursor + mount id) to DO storage and treats each wake as a _fresh_ short session
— i.e. **stop using capnweb for the durable leg** and use the append/subscribe contract (§2c
tiers) over hibernatable WS with app-level resume. Cost: a second transport; the "one
RpcTarget graph, two transports" elegance (§4) does not extend to the hibernating leg.

### 4. Cloudflare _forces_ eviction on a long session → all mounts on that DO die at once

**Mechanism.** CF: ">30s of compute between incoming network requests → heightened chance the
DO is evicted and reset." A capnweb DO doing real work (a big `JSON.parse` + `Devaluator`
walk on a fat payload, `:2504-2508`) can burn CPU between a peer's messages. Independently,
platform maintenance/rebalancing evicts DOs on its own schedule. Because the design funnels
**all** live providers of a project (or, per the task, "a single Durable Object") through
**one** DO, a single eviction drops **every** mounted Pi/browser/CLI session simultaneously,
and — theory 3 — none of them can resume; each peer must notice brokenness and full-redial.
**Trigger.** CPU spike between messages, platform rebalance, deploy, or OOM (theory 7).
**Evidence.** CF DO limits (evict/reset quote); single-DO framing in the design + §0.
**Severity.** High — correlated fleet-wide disconnect, not an isolated blip. "Possibly for
days" is contradicted: CF gives no multi-day residency guarantee to a non-hibernating DO.
**Cheap experiment.** Hold N capnweb sessions to one `HostDO`; call `this.ctx.abort()` (or a
CPU-burn loop >30s between messages) and watch all N peers get `onRpcBroken` at once. (~2 h.)
**Mitigation.** Shard live providers across many DOs (one holder DO per provider, §2a's
"holder DO"), so eviction blast radius = 1 device. Cost: N DOs = N residency meters (theory 1
multiplied), and you lose the "single capability host DO" simplicity the design is built on.

### 5. Silent half-open socket — a "days-long" session is mostly a lie without app pings

**Mechanism.** capnweb never sends a keepalive. A Pi behind home NAT, a laptop that slept, a
Wi-Fi handoff, or a stateful middlebox with an idle timeout will drop the TCP/WS silently — no
FIN, no `close` event. capnweb's `readLoop` stays parked in `transport.receive()`
(`:2498`) and `WebSocketTransport` only errors on an actual `close`/`error` event (`:2676`).
The DO believes the mount is live and keeps `dup()`'d stubs in `#caps`; the Pi believes it's
connected. **Both ends bill and hold resources for a corpse.** Detection happens only when
someone finally _calls_ the mount and the transport eventually rejects — which could be hours
later, or never for a rarely-used capability.
**Trigger.** Any NAT/idle-timeout/sleep/network-partition on a quiet session — i.e. routine.
**Evidence.** No `setInterval`/ping in dist; `readLoop` `:2492`; `WebSocketTransport`
`:2676-2681` reacts only to events; README:398 "ping/pong control frames are not forwarded".
**Severity.** High for correctness + medium for cost. Resolution (fork 9) that "reads the
mount fresh each time" will hand callers a **stale live stub** that hangs until the OS-level
socket timeout, then throws. Users see multi-minute hangs, not clean failures.
**Cheap experiment.** Open a capnweb WS, `iptables -j DROP` the peer (or kill Wi-Fi), wait,
then make a call. Measure time-to-error and confirm the DO never noticed the drop on its own.
(~1 h.)
**Mitigation.** App-level heartbeat: a tiny `ping()` RPC every ~30s on each live mount, with
`onRpcBroken`-plus-timeout eviction. Cost: the heartbeat itself defeats hibernation _and_
adds request billing (see theory 9) — you're now paying to keep a doomed socket detectably
alive. There is no free liveness.

### 6. Undisposed stubs accumulate → monotonic heap growth → 128 MB OOM → DO reset

**Mechanism.** capnweb GC "does not work well" (README:427); you must dispose explicitly or
end the session. The design **never disposes anything**: `resolve()` mints a fresh `cap.dup()`
per call (`capability-host.mjs:68`), `runDemo` awaits results and drops them on the floor, and
the 3-party proxy (theory 8) creates proxy import/export entries per relayed capability. Over
a multi-day session these entries are only reclaimed on session _abort_. Live-set grows with
cumulative un-disposed resolutions, not just concurrency. At ~1 resolve/2s that's ~43k/day of
retained hooks + closures + table entries.
**Trigger.** Sustained call volume on a long-lived session with no `using`/`[Symbol.dispose]`.
**Evidence.** README:437-441, :465 ("property RpcPromises have no own disposer"); design has
zero disposal calls; `delete`-based table freeing keeps array `.length` at high-water
(`:2247`,`:2460`) and `getStats()` (`:2600`, `for..in`) _hides_ it by counting only live
slots.
**Severity.** High and insidious. 128 MB/isolate (CF Workers limits). When the heap crosses
it, the isolate is killed → DO reset → theory 4's correlated disconnect. And `getStats()`
won't warn you, because it reports live entries, not retained-closure bytes or array length.
**Cheap experiment.** Long-run harness: hammer `resolve()` for 10 min without disposing;
sample `process.memoryUsage()`/isolate heap and `getStats()` side by side; show heap climbs
while `getStats().imports` looks flat. (~2 h.)
**Mitigation.** Make `resolve()`/the fallthrough hand back short-lived stubs wrapped in
disposal discipline (`using`), and dispose the per-call dup after the pipelined call resolves.
Cost: you must thread disposal through the ergonomic `host.egress.fetch(url)` sugar — the very
sugar (prototype-trap magic, `capability-host.mjs:82-93`) that makes disposal invisible and
easy to forget. High ergonomic tax on the design's central trick.

### 7. Stateless-Worker leg: the whole session is one request → 5-min CPU cap kills it

**Mechanism.** "In stateless Workers… the system considers an entire WebSocket session to be
one request for CPU limits" (README:501). Workers paid CPU cap = 5 min. If a live provider's
capnweb session terminates on a **stateless Worker** (the design's `WorkerEntrypoint` `fetch`
door, `newWorkersRpcResponse`; or `peer.mjs`/the `/test/capnweb` PEER path in `gateway.mjs`),
cumulative CPU across the whole multi-day session monotonically approaches 5 min and the
runtime **kills the session**. A DO resets to 30s per message and dodges this — which is
exactly why the design is _forced_ onto a DO for live mounts, contradicting §2a's
"stateless-first / stateless worker as first port of call."
**Trigger.** A live session routed through any stateless-worker hop (entry door, middle proxy).
**Evidence.** README:501; Workers limits (5-min CPU); `gateway.mjs:59-63` uses
`newWebSocketRpcSession` over a stateless PEER worker; `peer.mjs:14` `newWorkersRpcResponse`.
**Severity.** High for the entry/proxy tier; it means "live provider" is a DO-only feature and
the stateless read-path (§2a) categorically cannot carry live capabilities — only routing.
**Cheap experiment.** Run a capnweb WS to a stateless Worker (not a DO), drive periodic small
CPU (parse a 1 MB payload each call); watch cumulative CPU and the session die near 5 min. (~2 h.)
**Mitigation.** Mandate DO termination for every live session (already the lean). Cost:
re-confirms theory 1's 24/7 duration bill; kills the "stateless first port of call" story for
anything live.

### 8. The 3-party proxy pins the MIDDLE isolate for the union of both peers' lifetimes

**Mechanism.** `resolve()` falls through to a remote parent: `return this.#parent.resolve(name)`
(`capability-host.mjs:71`). project→CP→Pi means the **CP DO** holds a session with the project
_and_ a session with the Pi, and relays. Each relayed capability creates matching
import/export entries in the CP's tables that persist until disposal/abort. capnweb has **no
cross-connection GC** (README:427-433; the jam §6 fork-9 note repeats this), so the middle
cannot reclaim a proxy entry just because one side went quiet — it must stay resident as long
as _either_ end lives, forwarding nothing.
**Trigger.** Any capability whose provider is one hop past the resolving host (the Pi mounted
on the CP, consumed by a project).
**Evidence.** `:71` recursive remote resolve; README GC section; jam §6 "no cross-connection
GC, so the durable link must be a name."
**Severity.** High. Three isolates billed (theory 1 ×3) for one logical capability, and the
middle is the least observable place a leak accrues. Multiplies every cost above by the hop
count.
**Cheap experiment.** Wire project(local)→CP(DO)→Pi(remote), resolve a Pi capability, then
`getStats()` on the CP DO before/after; show CP import+export both grew and never shrink
without explicit disposal. (~3 h.)
**Mitigation.** fork-9 "C": store the fallthrough as a **dialable name**, let the _consumer_
dial the provider directly (project→Pi), so the CP is not on the steady-state path. Cost: the
consumer needs reachability + credentials to the provider (breaks the "CP mediates egress"
security model in `graph.mjs`'s `Egress`), and you lose CP-side mediation/observability.

### 9. Liveness vs. hibernation vs. billing is an unwinnable trilemma

**Mechanism.** To detect dead peers (theory 5) you need app-level pings. But CF says app-level
messages/timers **prevent** hibernation, and each incoming WS message is billed at a 20:1
ratio as requests. So: **no pings** → silent corpses + unbounded stale-hang; **pings** →
guaranteed no hibernation (theory 1's meter can never turn off) + per-message request billing.
capnweb removes even the _option_ of the cheap middle ground (CF auto-response ping/pong, which
doesn't wake a hibernating DO) because it doesn't use the Hibernation API at all (theory 2).
**Trigger.** Inherent to "keep thousands of live providers healthy."
**Evidence.** CF: "alarms, incoming requests, scheduled callbacks prevent hibernation…
including `setTimeout`/`setInterval`"; "20:1 ratio on incoming WebSocket messages"; capnweb
uses neither hibernation nor auto-response (grep).
**Severity.** Medium-high — it means there is no configuration of this stack that is
simultaneously cheap, hibernating, and liveness-checked. You pick two.
**Cheap experiment.** Cost-model spreadsheet: 10k devices × ping interval × 20:1 request price
vs. residency GB-s with/without hibernation. (~1 h.)
**Mitigation.** CF WebSocket auto-response (`setWebSocketAutoResponse`) gives ping/pong that
keeps NAT open _without_ waking a hibernating DO — but only if you're on the Hibernation API
(theory 2/3). So the mitigation is again "fork capnweb onto hibernation." Cost: as theory 3.

### 10. Clock skew / long-session absolute-time assumptions in auth re-gate

**Mechanism.** The data axis has the project call `itx.auth.gate` back to the CP (§1); a
multi-day live session may outlive token/credential validity. capnweb never re-authenticates a
mid-session; the session is authorized once at `authenticate()` and trusted forever after
(README:499 in-band auth). A Pi connected for a week holds authority frozen at connect time —
revocation/expiry doesn't reach it until reconnect.
**Trigger.** Credential rotation, revocation, or session-claim change during a long session.
**Evidence.** In-band auth model (README:499; jam §4 shells); no re-auth path in capnweb;
mirrors the known "minted prd session = frozen claims" class of bug in this codebase.
**Severity.** Medium (security-adjacent, but real for days-long sessions).
**Cheap experiment.** Authenticate, revoke server-side, keep calling on the old socket; confirm
calls still succeed until reconnect. (~1 h.)
**Mitigation.** Bound live-session lifetime (force re-`authenticate()` every N hours). Cost:
periodic full redial of every device = periodic fleet-wide theory-4 event, on purpose.

### 11. `onRpcBroken` propagation gaps across the proxy → mounts that never get evicted

**Mechanism.** Eviction of a dead mount depends on `onRpcBroken` firing so the host removes the
`dup()`'d stub from `#caps`. But the design registers **no** `onRpcBroken` on stored caps
(`provide`, `capability-host.mjs:51-57`, just dups and stores). `onBroken` fires on abort
(`:2484-2489`) — but only for the _directly_ attached session. Across the 3-party proxy
(theory 8), whether a broken Pi→CP socket propagates brokenness to the project's held stub
depends on capnweb relaying the reject through the middle; if the CP DO was itself evicted
(theory 4), the project's stub may hang rather than break. Net: dead mounts can linger in
`#caps` indefinitely, pinning nothing useful but counting against memory and lookups.
**Trigger.** Provider disconnect, especially two hops away or across a middle-eviction.
**Evidence.** `provide` stores without `onRpcBroken` `:51-57`; abort-path `onBroken` is
session-local `:2484-2489`; README:493 lists what brokenness covers (direct connection loss /
promise reject) — not transitive middle-death.
**Severity.** Medium. Slow mount-table rot; compounds theory 6.
**Cheap experiment.** Mount a remote cap, kill the provider, inspect `#caps` — confirm the dead
entry is still present with no auto-removal. (~1 h.)
**Mitigation.** `provide` must wire `stored.onRpcBroken(() => this.#caps.delete(name))`. Cheap
to add; but across a proxy it only fires if the middle relays the break — so it's necessary,
not sufficient.

### 12. `nextExportId--` / `imports.length` monotonic → array high-water never shrinks

**Mechanism.** Export IDs decrement forever (`nextExportId--`, `:2176`); import IDs are
`imports.length` at push time (`:2346`,`:2412`). Freed slots are `delete`d, not popped, so
`imports.length` and the exports index space only ever grow across a long session. V8 may
demote very sparse arrays to dictionary mode (bounding bytes to live entries), but the
monotonic ID space plus `reverseExports` Map churn is still steady allocator pressure over
days, and defeats any "the tables are small so we're fine" reasoning based on `getStats()`.
**Trigger.** High cumulative call count on one session.
**Evidence.** `:2176`, `:2346`, `:2412`, `:2247`, `:2460`; `getStats` counts live only `:2600`.
**Severity.** Low-medium on its own; a multiplier on theory 6.
**Cheap experiment.** 1M resolves on one session; log `imports.length` vs `getStats().imports`;
show the former unbounded, the latter flat. (~1 h.)
**Mitigation.** Cap session lifetime / cycle sessions (theory 10's bound doubles here). Cost:
same redial churn.

---

## The 3 scariest

**S1 — The 24/7 duration meter that cannot be switched off (theories 1 + 2 + 3).** The
design's flagship "Pi holds a capnweb WS for days" is billed wall-clock, continuously, per
device, because capnweb `server.accept()`s (`:2648`) and therefore the DO can never hibernate;
and it can _never_ be made to hibernate without forking capnweb, because hibernation resets
in-memory state and capnweb's whole session lives unserialized in isolate heap. §2d's promise
of "storage ≈ 0, billed on message routing" is exactly backwards: you are billed on
**residency**, and residency is 100%. Order-of-magnitude: ~2.5 always-on devices exhaust the
monthly free GB-s; 10k devices ≈ ~$20k/mo in _idle_ duration alone.

**S2 — One eviction, correlated fleet-wide death, no resume (theories 4 + 3 + 6).** A single
DO holding many live mounts will be evicted by CF (>30s compute between messages, rebalance,
or 128 MB OOM from undisposed stubs) — and because capnweb state can't survive a restart,
**every** mounted device on that DO disconnects at once and must full-redial. "Possibly for
days" has no platform backing; the realistic MTBF is hours, and the failure is synchronized,
not isolated.

**S3 — Silent corpses: a "live" mount that is actually a dead socket (theory 5 + 9).** With no
keepalive in capnweb and no dead-peer detection, a NAT/idle/sleep drop leaves both ends
believing the mount is live. Callers get multi-minute hangs, not clean errors, and the mount
table rots (theory 11). Fixing it with app pings is the trilemma (theory 9): pings forbid
hibernation and add 20:1 request billing — so the only honest liveness makes S1 strictly
worse. There is no cheap, correct, hibernating configuration of this stack for a live provider.
