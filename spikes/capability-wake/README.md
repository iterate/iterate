# Spike 3 — wake-on-call live capabilities (hibernatable), 2026-08-03

Side-quest 3 from `apps/os/docs/simplification/wayfinder/jam-capability-provision.md`. Generalizes PR **#2386**
("Stream wake sockets") from **wake-on-append** (streams) to **wake-on-call** (any capability). This is the
answer to the red-team's #2 (a pinned live socket bills 24/7) — and to Jonas's design: _loads of live
capabilities connected to horizontally-scalable edge providers that cost nothing, woken on demand._

## The mechanism (two channels, per #2386)

```
provider (Pi/edge)                      capability-host DO ("context")
  │  WAKE SOCKET (doorbell) ───────────▶ ctx.acceptWebSocket(…, ["wake"])   ← hibernatable, ~$0 idle
  │      register {cap}                    serializeAttachment(cap → socket)
  │                                       ┌─ consumer calls invokeCapability(cap,arg)
  │  ◀───────── {"type":"wake"} ─────────┤   no live leg? ring the doorbell (outgoing send = free)
  │  RPC LEG (phone call) ──────────────▶│   provider dials /rpc with its invoker as capnweb localMain
  │      (pinning capnweb session)        │   DO forwards the call, arms idle timer
  │  ◀───────── {"type":"idle"} ─────────┤   idle window elapses → dispose the leg (the pin) + notify
  ▼      drop the leg → dormant           ▼   only the hibernatable doorbell remains → hibernation-eligible
```

The **RPC leg is a live stub → it blocks hibernation**; that's exactly why it's torn down after idle. The
**wake socket is a plain hibernatable socket + attachment → it does not pin.** So a _registered but idle_
provider costs ~nothing, and the DO can hold thousands of them.

## What's proven (all green — `node build.mjs && node run-workerd.mjs`, and `node run-deployed.mjs`)

Both in Miniflare (real workerd) **and deployed** to the POC account (`capnweb-spike-wake.iterate.workers.dev`):

1. A **registered provider is DORMANT** — `liveLegs=0`, no pinning stub, hibernation-eligible — _before any call_.
2. A **call wakes it** (doorbell → provider dials the RPC leg → call forwarded → `"hello world"`).
3. After the idle window the **pinning leg is torn down** — dormant again, only the doorbell remains, provider saw `{"type":"idle"}`.
4. A **second call wakes it again** — repeatable.

`/state` exposes `{ wakeSockets, liveLegs, idleTimers, dormant }` so the dormant/no-pin state is _observable_.

## Why this matters for the model

- This is the **shared live-capability primitive** the jam calls for: the capability host (context) is the
  innermost thing; a _stream_ is just a capability that uses the **same** wake mechanism (wake-on-append +
  replay-from-log) while a general capability uses **wake-on-call** (forward the pending call — simpler, no log).
- It directly retires the red-team's 24/7-billing finding AND the `retainLiveCapabilityProvider` duped-stub
  pin (grounding agent's note): the live mount's stub now lives only during an active call window.

## Honest caveats (what this spike does NOT prove)

- **Actual hibernation/eviction** isn't observable in Miniflare (it doesn't truly evict); the spike proves the
  _precondition_ — dormant state has **no live stub and no timer** — which #2386's cited billing facts turn
  into "not billed for duration." Confirm real eviction with a deployed duration-metering probe.
- **Idle timer via `setTimeout`** is a spike shortcut — `setTimeout` itself blocks hibernation, so production
  uses a **DO alarm** (as #2386 reuses the stream idle alarm). Teardown clears the timer, so the _dormant_
  state has neither.
- **No dedupe/replay/resume, socketId same-key replacement, or resurrection-loop guards** — #2386 needs those
  because streams are push+log (at-most-once wake, replay from cursor). Wake-on-**call** forwards the _pending
  call_ itself, so it needs far less; but reconnect-races, wake timeouts, and same-key replacement still need
  the #2386 treatment before production.
- **Auth/guardrails** from the red-team still apply (unauth wire mutators, downward-scoped resolution, per-tenant).

## Files

- `do.mjs` — the capability-host DO (hibernatable wake socket + on-demand RPC leg + idle teardown) + thin router.
- `provider.mjs` — a provider (simulated Pi): holds the doorbell, dials the RPC leg only when woken.
- `run-workerd.mjs` / `run-deployed.mjs` — the Miniflare + deployed harnesses.
- `build.mjs`, `wrangler.jsonc` — esbuild bundle + POC deploy config.
