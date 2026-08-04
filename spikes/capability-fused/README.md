# Spike 4 — the FUSED, hardened capability host, proven in PRODUCTION at fleet scale (2026-08-03)

Side-quest 4. Fuses spike-2 (parent fallthrough) + spike-3 (wake-on-call live mounts) with the red-team
hardening, and proves it **on deployed workers only** (no Miniflare) — including **real hibernation with a
1000-device fleet**. Deployed: `capnweb-spike-fused.iterate.workers.dev` (POC account, DO `CONTEXT`).

## What it fuses + hardens

- **Parent fallthrough BY NAME.** Resolution is `local live cap → local static cap → parent (by name)`.
  The parent is re-dialed by name per call (native RPC to another context DO) and **never retained** — this
  kills the per-access import/export leak the red-team measured (`do.mjs` `invokeCapability`).
- **Downward-only + mutators off the tenant surface.** `/call` resolves downward only. The mutators
  (`/admin/set-parent`, `/admin/provide-static`) are a **separate facet behind a shared secret** — a tenant
  hitting them without the secret gets `403` (the red-team's unauthenticated-wire-mutator finding).
- **Live mounts via the wake doorbell** (spike-3): a device holds a hibernatable wake socket; a call wakes
  only it; the pinning RPC leg is torn down after idle.
- **Hibernation is OBSERVABLE.** A durable `incarnation` counter is bumped in the constructor, so eviction +
  reconstruction is visible (it grows only when the DO is rebuilt).

## Proven in production — `node run-prod.mjs` (FLEET=1000, all pass)

Part A — hardening:

- tenant **cannot** mutate (`/admin/*` gated) → `403`.
- local **live** cap via the wake doorbell → `hello world`.
- **fallthrough by name** to the parent's static cap → `static:iterate` (no retained stub).
- unknown cap → downward miss, **no upward escalation**.

Part B — **1000 IoT devices + real hibernation**:

- **1000 providers connected + registered**, `liveLegs=0`, dormant (zero pinning stubs).
- **The DO HIBERNATED + was evicted while all 1000 stayed connected** — `incarnation 3→4`, `wakeSockets
1000→1000` (every socket survived eviction).
- **dev-0 / dev-500 / dev-999 each woke on demand** and returned; **only the 3 targeted devices woke** — the
  other 997 never left dormancy.
- fleet dormant again after idle.

## Platform verification (`wrangler tail` — Cloudflare's trace API)

Ran the full test under tail (529 sampled events) and inspected them:

- **0 exceptions, 0 error/warn logs.** All responses `200` except the **2 expected `403`s** (gated mutators).
- **executionModel**: 515 `durableObject` + 13 `stateless`; DO `cpuTime` ≈ 21ms total (sampled) — negligible.
- **The timeline has a single 60.2-second gap with ZERO events** during the idle window — with all 1000
  WebSockets held, the DO did _nothing_: no invocation, no wallTime, no CPU. That is the definitive
  "not billed for duration → hibernating" signal, corroborating the incarnation bump.
- The only non-`ok` event was a **wrangler-tail sampling notice** (`type:"overload"` = the tail _service_
  sampling under load), **not** a DO overload.

## Billing-level proof + lessons (Cloudflare DO analytics, `run-soak.mjs`)

Re-ran as a **5-minute soak** with **staggered connect** (25 every 250ms) + **graceful close (code 1000)**,
then read `durableObjectsPeriodicGroups` / `durableObjectsInvocationsAdaptiveGroups` for the window:

- **Idle duty cycle: 14–22 ms billed `activeTime` per minute while holding 1000 WebSockets = ~0.47% of
  wall-clock → ~99.5% hibernating** over 5 minutes (exactly as predicted for a multi-minute view; the
  earlier one-minute 2% figure was a single `/state` poll amortized over one minute). The DO comes alive
  ONLY when something calls it (or the test polls `/state`) — **never spontaneously**. `wakeCount=0`, zero
  devices woke during idle.
- **`invocationStatusTotals: { success: 1006 }` — ZERO `clientDisconnected`, zero exceptions.** The graceful
  close + staggered connect eliminated the spike.

### Lessons banked (this is the "learn our lesson" part)

1. **The `clientDisconnected` spike was self-inflicted, not intrinsic.** The first run connected 1000 sockets
   to ONE DO in a burst → the DO shed connections under the herd → the auto-reconnecting providers re-dialed
   → each drop counted as `clientDisconnected` (in the analytics **errors** metric) AND caused an odd
   mid-idle wake. **Fix: pace connects (stagger/shard).** With staggering: **0 reconnects, 0
   clientDisconnected.** Production needs per-tenant sharding + connect-rate control (the red-team's single-DO
   point, now measured).
2. **Close gracefully with code 1000.** On compat date ≥ 2026-04-07 the `web_socket_auto_reply_to_close` flag
   auto-completes the close handshake; a graceful `close(1000)` avoids the client-side `1006` abnormal
   closure. Never rely on a bare drop.
3. **NEVER use `ctx.abort()` to "reset in-memory state but keep clients."** Verified live: `abort()` throws an
   uncatchable error (the `/abort` request 500s), reconstructs the DO (`incarnation++`), but **CLOSES every
   hibernatable inbound socket** — client gets a `1006` abnormal close and is NOT re-attached (`wakeSockets`
   → 0). That's the `evictDurableObject(stub, { webSockets: "close" })` mode. For "reset in-memory, keep
   clients connected," rely on **natural hibernation/eviction** (the default `{ webSockets: "hibernate" }`),
   which preserves + re-attaches sockets and re-runs the constructor. `abort()` is a hard reset, not a
   hibernation primitive.
4. **A mass client disconnect shows up as N `clientDisconnected` in DO analytics** — benign (it's just
   sockets closing) but it lands in the _errors_ metric, so don't page on it for WS fleets; watch
   `scriptThrewException`/`exceededCpu|Memory` instead.

## Honest edges (still to do before production)

- **Connect-burst load on a single DO.** 1000 simultaneous upgrades stress one DO; the fleet filled to 1000
  only because providers **auto-reconnect** (real devices do). Production wants per-tenant sharding and/or
  connect-rate control (the red-team's single-DO-hot-shard point). One DO _can_ hold 32k sockets; the issue
  is the connect rate, not the socket count.
- **Idle timer via `setTimeout`** is a spike shortcut (blocks hibernation while pending) — production uses a
  DO **alarm**. Teardown clears it, so the _dormant_ state has none (confirmed by the 60s zero-activity gap).
- **`abort()` probe** and same-key replacement / reconnect-race guards (#2386 has these) still to port.

## Files

- `do.mjs` — the fused context DO (fallthrough-by-name · gated mutators · wake-on-call · incarnation counter).
- `provider.mjs` — an auto-reconnecting device provider.
- `run-prod.mjs` — the production harness (Part A hardening + Part B 1000-device fleet + hibernation).
- `wrangler.jsonc` — POC deploy config.
