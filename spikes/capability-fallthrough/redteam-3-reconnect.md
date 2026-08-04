# Red-team 3 — RECONNECT, FAILOVER & DELIVERY SEMANTICS

Adversarial review of the "everything is a capability host + one fallthrough" design under
**disconnection**. Target: `spikes/capability-fallthrough/{capability-host,graph,gateway}.mjs`,
design `apps/os/docs/simplification/wayfinder/jam-capability-provision.md` (§2c/§2d/§4/§6), against
**real capnweb 0.10.0** (`node_modules/.pnpm/@iterate-com+capnweb@0.10.0/.../dist/index.js`).

The design's own claim under test: _"the durable fold stores a routing record only, never the stub;
on disconnect `onRpcBroken` evicts and resolution falls back."_ **The eviction story is the single
point of failure, and it breaks in at least four distinct ways** — plus one bug where a _normal_
disconnect crashes capnweb's own teardown.

Reproducible experiment: `spikes/capability-fallthrough/redteam-reconnect-experiment.mjs`
(`node redteam-reconnect-experiment.mjs`). Findings T1–T6 below map to its sections; every "CONFIRMED"
tag was produced by that script or the one-liners quoted.

Load-bearing capnweb facts I established from source (all citations `dist/index.js` / `dist/index.d.ts`):

- **No reconnect, no resume, no sequence numbers, no keepalive/ping.** `grep -ni
"ping|pong|keepalive|heartbeat|reconnect|resume|sequence"` over `index.js` → **zero hits** (only
  `fetch`'s unrelated `keepalive`). A dropped session is dead forever; a new socket is a brand-new
  session with a fresh import/export table.
- **No hibernation.** capnweb uses `webSocket.accept()` + `addEventListener` (`index.js:2642, 2668`),
  **not** `state.acceptWebSocket()`. `grep -ni "hibernat|acceptWebSocket|webSocketMessage|
serializeAttachment"` → **zero hits**. Any DO holding a capnweb WS is **pinned resident** and its
  sessions **die on any DO eviction/restart**.
- **"Clean shutdown" = silent failure.** `RpcTransport.receive` docstring (`index.d.ts:184-187`): if
  the transport disconnects and _there are no outstanding calls, "the error does not propagate
  anywhere -- this is considered a clean shutdown."_
- **Close is always an error to the reader, but only via a delivered event.** `WebSocketTransport`
  turns _any_ `close`/`error` event into a `receive()` rejection (`index.js:2676-2681`) — but **only
  when the event fires**. No event (half-open) ⇒ `receive()` hangs forever.
- **`abort()` closes with application code `3000`, reason truncated to 123 bytes** (`index.js:2701-2708`).
- **Exports are disposed on abort in an UNGUARDED loop** (`index.js:2490`:
  `for (let i in this.exports) this.exports[i].hook.dispose();` — no try/catch, unlike the
  `onBrokenCallbacks` loop just above it at 2484).

---

## Ranked failure theories

### 1. [CRITICAL] A _normal_ disconnect crashes capnweb's teardown, because the fallthrough Proxy's `has()=>true` makes `Symbol.dispose in host` true — CONFIRMED (T6)

**Mechanism.** `capability-host.mjs:89-91` — the fallthrough Proxy's `has()` trap returns `true` for
**every** property, including symbols. So `Symbol.dispose in host === true`, yet `host[Symbol.dispose]`
is `undefined` (the `get` trap returns `Reflect.get` for symbols → undefined). When capnweb tears a
session down, `session.abort()` disposes every export; `disposeRpcTarget` (`index.js:876-882`) guards
with `if (Symbol.dispose in target) target[Symbol.dispose]()`. For a CapabilityHost the guard passes
and it **calls `undefined()` → `TypeError: target[Symbol.dispose] is not a function`**. This throws
inside the **unguarded** exports-dispose loop (`index.js:2490`), which runs from
`this.readLoop().catch((err) => this.abort(err))` (`index.js:2203`) — i.e. it becomes an **unhandled
rejection on every disconnect**, and aborts the rest of the cleanup loop (later exports never disposed).

**Trigger.** ANY disconnect (clean or dirty) of a session that has a `CapabilityHost` in its export
table. The whole design exports CapabilityHosts constantly: `HostDO.project()` returns one across
native RPC (`gateway.mjs:31`), the CP's `localMain` is one, `authenticate()`/`projects.get()` shells
are ones, the Pi's cloud-side handle is one. So this fires on **essentially every session teardown in
the system**.

**Evidence.** CONFIRMED. Minimal contrast repro:

```
plain RpcTarget localMain : crash on teardown = NONE (clean)
CapabilityHost localMain  : crash on teardown = TypeError: target[Symbol.dispose] is not a function
```

and directly: `Symbol.dispose in host = true`, `host[Symbol.dispose] = undefined`,
`Symbol.asyncDispose in host = true`, `Symbol.iterator in host = true` (all falsely "present").

**Severity + scale.** Critical, universal. Every reconnect (the thing this domain is about) throws.
In Node it crashes the process; in workerd an unhandled rejection in the readLoop-catch tears the
surrounding context and leaves the export/import table half-cleaned (leak + possibly-skipped later
`onBroken`/eviction callbacks). It also poisons the _counterparty_: the truncated-3000 abort still
goes out, but local cleanup is corrupt. This single line (`has() => true`) also breaks any code that
does `Symbol.iterator in x`, `Symbol.asyncDispose in x`, `"length" in x`, `util.inspect`, structured
clone probing, etc. — a broad correctness landmine that the reconnect path is just the first to hit.

**Cheap experiment.** Already done (T6 + the two-line contrast). To confirm on the native leg, add a
`/test/native-drop` route to `gateway.mjs` that returns `HOST_DO...project()` then aborts the DO stub.

**Mitigation + cost.** Cheap and mandatory: the Proxy `has()` must **not** blanket-return true for
symbols and dispose/JS-machinery keys — return `Reflect.has(target, prop)` for symbols and for the
`RESERVED` set, and only `true` for string capability names. Better: define an actual
`[Symbol.dispose]()` on `CapabilityHostBase` (real, harmless) so the guard finds a callable. Cost: a
few lines, but it re-opens the "which names are real vs capabilities" question the Proxy was papering
over (`RESERVED` is already an acknowledgement this is fragile).

### 2. [CRITICAL] Split-brain: a _late_ `onRpcBroken` from the dead session evicts the _live_ reconnected mount by name — CONFIRMED (T4)

**Mechanism.** Eviction is "delete the mount **by name**." A provider (Pi) reconnects on a new session
and re-`provide()`s `name` _before_ the old socket's close is processed (flaky links, half-open old
socket, mobile handover). The map now holds the **new, healthy** stub under `name`. Then the **old**
session's `onRpcBroken` finally fires and runs `caps.delete(name)` — deleting the freshly-installed
live mount. The provider is connected and healthy, but the host reports "no such capability" and falls
through to the parent (wrong cap) or throws at the terminal.

**Trigger.** Reconnect where the new `provide` wins the race against the old `onBroken` — the _common_
ordering on lossy networks, because the new connect is an active dial (fast) while the old close is a
passive TCP teardown (slow / may need a timeout).

**Evidence.** CONFIRMED:

```
after reconnect provide (new healthy mount): caps.has(sensor) = true
   [onRpcBroken:sensor] evicting by name
after OLD session's late onRpcBroken: caps.has(sensor) = false
```

**Severity + scale.** Critical for every flappy live provider (Home-Assistant/Pi is the design's poster
child, §2d). Manifests as intermittent "capability disappeared seconds after it reconnected," self-heals
only on the _next_ reconnect, and is maddening to debug (the delete comes from a session that no longer
exists).

**Mitigation + cost.** Eviction must be **identity-scoped, not name-scoped**: tag each mount with a
monotonic epoch/`connectionId`; `onRpcBroken` deletes _only if the current mount is still the one this
callback belongs to_ (`if (caps.get(name)?.epoch === myEpoch) caps.delete(name)`). This is exactly why
the §6 lean says "the live stub must live only in the one DO keyed by connection" — but the spike keys
by **name**, so the lean's own safeguard is not yet implemented. Cost: one field + a compare; must be
designed in from the start.

### 3. [CRITICAL] Half-open death: no keepalive ⇒ `receive()` never rejects ⇒ `onRpcBroken` never fires ⇒ mount strands and calls hang — CONFIRMED (T3)

**Mechanism.** capnweb's disconnect signal is _entirely_ event-driven (`close`/`error` →
`#receivedError` → `receive()` rejects → `abort()` → `onBrokenCallbacks`). A **silent** transport
death — power loss, Wi-Fi drop, NAT rebind, cable pull, cloud LB idle-reap without a FIN — delivers
**no event**. `receive()` stays pending forever; `abort()` is never called; **`onRpcBroken` never
fires**; the durable mount keeps pointing at a dead stub. Because capnweb has **no ping/keepalive**
(confirmed: zero hits), nothing detects it. Calls routed to that mount block until the OS TCP timeout
(minutes, if ever) — and if the caller wrapped it in a fetch with no timeout, indefinitely.

**Trigger.** Any ungraceful disconnect of a live provider — the _normal_ failure mode for a Raspberry
Pi on home Wi-Fi (the design's headline use case). Graceful `ws.close()` is the exception, not the rule.

**Evidence.** CONFIRMED (T3): 100 ms after a silent stall, `onRpcBroken fired = false`. Plus source:
no ping/pong anywhere in capnweb; `WebSocketTransport.receive()` (`index.js:2693-2700`) only settles on
a delivered message/close/error.

**Severity + scale.** Critical. The design elevates `onRpcBroken` to _the_ eviction primitive, but it's
only as reliable as the underlying socket's close delivery — which for the target hardware is
unreliable. Fleet-wide, a chunk of "live" mounts are silently dead at any moment, invisible until
something calls them and hangs.

**Mitigation + cost.** You must add liveness _around_ capnweb: application-level ping/pong on an
interval (Pi answers a cheap `ping()`; miss N ⇒ synthesize an abort + evict), and/or Cloudflare
hibernatable WebSockets with `setWebSocketAutoResponse` pings + a DO alarm sweep. Both are real work and
**incompatible with capnweb's current non-hibernatable `accept()` path** — you'd need capnweb to grow a
hibernation-aware transport, or run the liveness check outside it. Cost: substantial; it's a missing
subsystem, not a tweak.

### 4. [HIGH] DO restart / redeploy = mass eviction of all live mounts at once; the durable record then lies — analytical, grounded

**Mechanism.** All live stubs "live only in memory and die with the connection" (design) and capnweb
WSs are **non-hibernatable** (confirmed). A single capability-host **DO** (the §4 "one DO now" decision)
holds them all. Any DO restart — deploy, crash, eviction, migration, `wrangler deploy` — drops **every**
capnweb WS simultaneously and wipes the in-memory `#caps`. The **durable fold survives** and still says
"name X is a live mount," but there is no stub and no socket. `resolve(name)` finds a routing record it
**cannot back** (the record is "a name," per fork-9 C — but a _live_ name has no dialable address; the
provider dialed _in_). Result: a resolution that neither serves nor cleanly falls through until each
provider independently notices its socket died and redials.

**Trigger.** Every control-plane deploy (routine!), plus crashes/evictions. Cloudflare rolls new code
by spinning up new isolates and draining old ones — DO WebSockets that aren't hibernatable are dropped.

**Evidence.** Design §0/§2c ("continuous RPC keeps it resident; no hibernatable WebSockets anywhere");
capnweb source confirms `accept()` not `acceptWebSocket()`. Cloudflare's own guidance: only
`state.acceptWebSocket()` connections survive eviction/hibernation; `ws.accept()` ones are terminated
on eviction and lost on code deploys.

**Severity + scale.** High, correlated. Not one Pi — _every_ live provider at once, on every deploy.
Turns a routine deploy into a fleet-wide capability outage whose recovery time = max device
reconnect-backoff, and feeds directly into #5 and #6.

**Mitigation + cost.** (a) Make the live-provider transport hibernatable (big capnweb change, see #3).
(b) Treat live mounts as **soft state**: on DO cold-start, mark all live records "pending-redial," have
providers reconnect with backoff, and have `resolve()` return a _typed_ "provider offline" instead of a
dead stub or a wrong fallthrough. (c) Shard providers across many DOs so one restart isn't fleet-wide
(contradicts "one DO now"). Cost: medium-high; partly a product call (fork 2, offline behavior).

### 5. [HIGH] Parent-stub break kills _every_ inherited capability at once, with no re-dial — CONFIRMED (T5)

**Mechanism.** In the spike, `project.setParent(cpStub)` where `cpStub` is a remote capnweb stub, and
`resolve()` does `return this.#parent.resolve(name)`. When the single project→CP session drops, the
parent stub is dead, so **every** fallthrough — egress, email, auth.gate, directory, iterate flavor,
brand — fails simultaneously. capnweb has no reconnect, so nothing re-dials; the project is bricked for
all inherited capabilities until something reprovisions the parent.

**Trigger.** One dropped project↔CP connection (deploy, transient network, CP DO restart per #4).

**Evidence.** CONFIRMED (T5): after the drop, both `project.egress.fetch` and the static `project.brand`
fail with `project<->cp session dropped`.

**Severity + scale.** High. The fallthrough chain is a **series circuit**: one broken link opens the
whole downstream. Worse for static caps — `brand` is a constant that could have been cached, but routing
it through a live parent stub makes a string constant fail on a network blip.

**Mitigation + cost.** This is precisely what the §6 fork-9 **lean** prescribes — store the parent as a
**dialable name (C)**, redialed fresh per resolve, not as a captured long-lived stub (B) — plus **pull
CP mounts into the local fold at birth** so steady-state resolves are local and survive a parent blip.
The spike implements the fragile B-variant (captured stub); the safe design is on paper but not built.
Also: pass static/`itx-expression` caps **by value at birth** so they never depend on a live parent.
Cost: medium; it's the core of the still-open fork 9.

### 6. [HIGH] Reconnect storm concentrates on one single-threaded DO that each connection also _pins_ — analytical

**Mechanism.** After a CP deploy/restart (#4), thousands of devices redial at once. §4 routes
everything through **one** capability-host DO — single-threaded actor, serialized RPC. Each accepted
capnweb WS is non-hibernatable and **pins the DO resident** (§0). So the storm is: N simultaneous
session setups + N `provide` folds, serialized through one object, each leaving a pinning socket. Head-
of-line blocking → slow accepts → client connect timeouts → more retries → metastable failure.

**Trigger.** Any correlated reconnect: CP deploy, CP DO eviction, a Cloudflare edge blip, an upstream
Wi-Fi/ISP recovery reconnecting a neighborhood of Pis.

**Evidence.** §4 "one DO now"; capnweb non-hibernatable `accept()` (pins); DO concurrency model
(one instance, serialized). The design explicitly defers the KV/stateless projection (§2a) as "later."

**Severity + scale.** High at fleet scale; invisible in a 3-party spike. The very optimization that
would help (KV routing projection + stateless resolution) is postponed, and live serving _cannot_ be
stateless anyway (it needs the pinned socket), so the storm has nowhere to spread.

**Mitigation + cost.** Shard the holder DOs by provider id (many DOs, not one); jittered client backoff;
hibernatable WS so idle providers don't pin; accept-rate limiting. Cost: medium; partially reverses
"one DO now."

### 7. [HIGH] No resume ⇒ an in-flight call at drop is at-most-once with _unknown_-once ambiguity; naive retry duplicates side effects — CONFIRMED (T1)

**Mechanism.** capnweb has no message-level ack/replay. A call in flight when the socket drops
**rejects** (good — not a silent hang, when a close is delivered). But the caller **cannot tell whether
the provider already executed it** before the resolve frame was lost. For `egress.fetch` doing a POST, a
webhook, or a Pi actuator command, "rejected" could mean _never ran_ or _ran, ack lost_. Any automatic
retry is then **at-least-once with no idempotency key** → duplicate side effects; no retry → possibly
zero. There is no idempotency layer anywhere in the design.

**Trigger.** Drop during any mutating call; especially egress and device-actuation caps.

**Evidence.** CONFIRMED (T1): in-flight `slow()` settled `REJECTED: pi dropped`. Source: no
sequence/resume; `RpcImportHook.call` after abort returns an `ErrorStubHook` (`index.js:2065-2110`).

**Severity + scale.** High for mutating capabilities. The design markets egress as a _mediated_ capability
(secrets/origin-pin substitution) — exactly the calls where a silent duplicate POST is dangerous.

**Mitigation + cost.** Idempotency keys on mutating cap calls + provider-side dedupe; or declare cap
methods idempotent/non-idempotent and refuse auto-retry on the latter. Cost: medium; a contract change
to the capability interface (§2c's `append`/`fetch`/… tiers).

### 8. [HIGH] "Clean shutdown" vacuous rejection swallows provider death entirely — analytical, grounded

**Mechanism.** Per `receive()`'s contract (`index.d.ts:184-187`), if a session disconnects with **no
outstanding pulled calls**, the error _does not propagate anywhere_. capnweb even calls
`hook.ignoreUnhandledRejections()` on pushed expressions (`index.js:2509`). So a fire-and-forget or
pipelined-but-not-awaited call to a live cap that then dies produces **silence** — no throw, no log,
no eviction visible to the caller. Combined with the known capnweb hazards already in our memory
(_"rejects can pass; wrap in closure"_, and 0.8.0 dropping `error.name`), failures can vanish.

**Trigger.** Any pipelined chain whose tail result the caller disposes/doesn't await, over a session
that breaks; or a `provide()`/mount side-effect whose ack is never pulled.

**Evidence.** `index.d.ts:184-187`; `index.js:2509` `ignoreUnhandledRejections()`; memory notes
`capnweb_vacuous_rejects.md`, `incident_capnweb_error_name_drop.md`.

**Severity + scale.** High for observability/correctness: the eviction/failure story assumes failures
are _observed_; this says a class of them is structurally invisible. You can't build reliable failover
on a signal that legitimately never fires.

**Mitigation + cost.** Always keep at least one awaited call per critical mount (so the break has
something to reject); wrap rejections in closures per the memory note; add app-level acks. Cost: low-
medium but must be a standing convention, easy to forget.

### 9. [MEDIUM] No cross-session e-order ⇒ mount/unmount events reorder across a reconnect ⇒ the fold ends wrong — analytical

**Mechanism.** The capability table "is a stream fold" (§2b, §0): mounts/unmounts are events. capnweb
preserves e-order **within** a session only. A provider that emits fold events and then reconnects has
its post-reconnect events on a _different_ session with no ordering relation to the old session's
still-draining frames. An old-session `unmount`/teardown landing _after_ a new-session `remount` leaves
the name unmounted (a cousin of #2 at the event-log level).

**Trigger.** Reconnect interleaved with fold-mutating events; also DO restart mid-fold.

**Evidence.** capnweb e-order is per-session (README/source model); no global sequence.

**Severity + scale.** Medium; corrupts the durable fold, which is the source of truth. Rare but sticky.

**Mitigation + cost.** Per-connection epoch on every fold event; fold ignores events from a superseded
epoch. Same epoch mechanism as #2. Cost: low if #2's epoch already exists.

### 10. [MEDIUM] Eviction/resolve race: `resolve()` hands out a `dup()` of a stub that dies microseconds later — CONFIRMED-adjacent (T1/T2)

**Mechanism.** `resolve()` reads `#caps` and returns `hit.cap.dup()` synchronously. Between that return
and the caller's `.method()`, the session can break; `onRpcBroken` evicts the map entry but **cannot
recall the dup already handed out**. The caller holds a live-looking stub whose next call rejects (or,
under #3, hangs). So even with perfect eviction there's an unavoidable in-flight window where callers
get a doomed stub.

**Trigger.** Resolve concurrent with disconnect — a wide window under flapping.

**Evidence.** `capability-host.mjs:68` (`return hit.cap.dup()`); T1/T2 show the dup's call rejects after
the drop; eviction only affects _future_ lookups.

**Severity + scale.** Medium; inherent to "hand out a captured stub." Bounded by call latency, but
non-zero and worse the flappier the link.

**Mitigation + cost.** Callers must treat any live-cap call as retryable-on-broken with a fresh
`resolve()` (dial-by-name per read, fork-9 C), not cache the stub. Cost: low; a calling convention +
the name-based resolve.

### 11. [MEDIUM] A live mount cannot exist over the HTTP-batch door; the session ends immediately — grounded

**Mechanism.** The client `/api` door is capnweb over **WS or HTTP-batch** (§0, §6). On the batch
transport, `receive()` throws **"Batch RPC request ended."** once the batch drains
(`index.js:2735-2740`), and the server side returns after `drain()` (`index.js:2805-2813`). So a
batch session is one-shot: a live provider that dialed in over batch, or a fallthrough parent reached
over batch, is **gone the moment the batch completes**. Only the WS door can host anything "live."

**Trigger.** Any attempt to hold a live mount / long-lived parent over the HTTP-batch door (e.g. an
HTTP-only client, a proxy that downgrades WS, a serverless caller).

**Evidence.** `index.js:2735-2740, 2805-2813`.

**Severity + scale.** Medium; a sharp constraint the "same interface, two transports" framing hides.
"Live capability" silently requires WS; over batch every cap is effectively static/per-request.

**Mitigation + cost.** Document/enforce: live mounts and long-lived parents require WS; reject or
degrade on batch. Cost: low, but a real capability of the model must be gated by transport.

### 12. [MEDIUM] `abort()` closes with app code 3000 and truncates the reason to 123 bytes ⇒ providers mis-handle reconnect / lose the error — grounded

**Mechanism.** `WebSocketTransport.abort` calls `ws.close(3000, message)` and truncates `message` to
123 UTF-8 bytes (`index.js:2701-2708`). A Pi/firmware that treats non-1000/1001 codes as "fatal, do not
reconnect" will stay down; the truncated reason may drop the actionable part of the error. Also, capnweb
sends its _own_ `abort` protocol frame just before closing — a device implementing a plain WS (not
capnweb) won't understand it.

**Trigger.** Any capnweb-initiated abort toward a device with naive reconnect logic.

**Evidence.** `index.js:2701-2708`.

**Severity + scale.** Medium at the edge; interacts with #3 (if the device won't reconnect, the mount
strands permanently, not transiently).

**Mitigation + cost.** Publish a device reconnect spec (3000 = reconnect-with-backoff); keep reasons
short and structured. Cost: low (docs + firmware convention).

### 13. [LOW-MED] `dup()`-without-`dispose()` leaks on re-provide/shadow and under churn; broken-session disposes send failing releases — grounded

**Mechanism.** `provide()` overwrites `#caps.set(name, …)` **without disposing the previous stub**
(`capability-host.mjs:51-57`); `resolve()` mints a fresh `dup()` per read (`:68`). Under shadowing and
reconnect churn these import entries accumulate. On a broken session, disposing a dup tries to
`sendRelease` over a dead transport (best-effort, but adds noise). `onBrokenCallbacks` also grows via
sparse `delete` (`index.js:2035-2043, 2079`) on the long-lived hub session.

**Trigger.** High-churn shadowing / frequent reconnects on a long-lived hub.

**Evidence.** `capability-host.mjs:51-57, 68`; capnweb refcount/dispose paths.

**Severity + scale.** Low-medium; slow leak, matters for a hub holding many providers for days.

**Mitigation + cost.** Dispose the previous stub on re-provide/evict; bound resolve to not dup per call
where avoidable. Cost: low.

### 14. [LOW] Static caps are needlessly coupled to live-parent liveness — grounded

**Mechanism.** `brand`/`itx-expression` static caps resolved _through_ a live parent stub (fork-9 B)
fail when the parent session drops (seen in T5: `brand` failed). A pass-by-value constant should never
depend on a socket.

**Mitigation + cost.** Copy static caps into the local fold at birth (§6 "pull CP mounts into the local
fold once at birth"). Cost: low; already in the lean, not in the spike.

---

## The 3 scariest

1. **#1 — the `has()=>true` Proxy makes `Symbol.dispose in host` true, so a _normal_ disconnect throws
   `target[Symbol.dispose] is not a function` inside capnweb's unguarded teardown loop, on essentially
   every session that exports a CapabilityHost.** It's confirmed, universal, fires on the exact event
   this review targets, corrupts cleanup, and is a symptom of a broader `has()`-lies landmine
   (`Symbol.iterator`, `"length"`, inspection all falsely "present"). Cheapest to fix, most embarrassing
   to ship.
2. **#3 + #4 together — the eviction primitive (`onRpcBroken`) is unreliable exactly when it matters.**
   capnweb has no keepalive, so half-open deaths never fire it (#3), and non-hibernatable WSs mean any DO
   restart mass-drops every live mount while the durable record still claims "live" (#4). The design's
   whole reconnect story rests on a signal that structurally fails for the target hardware (Pi on home
   Wi-Fi) and on every deploy.
3. **#2 — split-brain by name.** A late `onRpcBroken` from a dead session deletes the freshly-reconnected
   live mount (confirmed), because eviction is keyed by name, not by connection epoch. Self-inflicted,
   intermittent, and it _removes_ a healthy capability — the worst kind of failover bug. The §6 lean
   already knows to key by connection; the spike doesn't.

(Closely behind: #5 parent-stub series-circuit failure and #7 duplicate-side-effect on retry.)
