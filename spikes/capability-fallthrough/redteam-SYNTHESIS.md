# Red-team synthesis — how the capability-fallthrough model breaks (2026-08-03)

Six adversarial agents (volume · duration · reconnect · resources · security · blast-radius) attacked the
design in `spikes/capability-fallthrough/`. Full analyses in `redteam-1..6-*.md`; runnable PoCs in
`redteam-poc.mjs` (security) + `redteam-reconnect-experiment.mjs`. This is the deduped, ranked verdict.

## The one theme four agents hit independently

The spike's single `env.HOST_DO.getByName("singleton")` — **one capability-host Durable Object for the whole
deployment** — is a global single-threaded chokepoint (~1,000 req/s, one isolate, HOL-blocking, SPOF) and it
**re-creates the DO-pinning problem this whole redesign set out to escape**, just relocated to the resolver.
The "one DO now, KV projection later" deferral is **load-bearing, not safe**: KV can offload only _static/cold_
resolution; **live mounts still terminate on a stateful holder DO**, so the single DO IS the architecture.

## Root causes (what actually bites), ranked

**A. capnweb has no distributed GC, no hibernation, no reconnect/keepalive.** The deepest cluster.

- **A1 — per-call fallthrough LEAK (CRITICAL, measured).** A local host with a _remote parent_ leaks 1 import
  - 1 export **per property access** — the intermediate resolve-stub is never disposed, and capnweb can't GC
    it. `getStats()`: 10 calls → 11/11 entries, strictly monotonic → hot-path 128 MB isolate OOM (control plane
    first). The spike's `resolve()`-on-every-access shape is the culprit. **Spike 1 missed this** — it only
    tested all-remote-stub, never local-host-with-remote-parent (the deployed topology).
- **A2 — 24/7 duration billing (CRITICAL).** capnweb `accept()`s the socket (no `acceptWebSocket`, zero
  hibernation code), so a DO holding a live mount can **never hibernate** → billed wall-clock continuously
  even idle. **This inverts §2d's "storage≈0, billed on routing"** — you're billed on 100% residency. ~10k
  idle always-on devices ≈ ~$20k/mo doing nothing.
- **A3 — silent corpses + no resume (CRITICAL).** No keepalive → a NAT/idle/sleep drop leaves both ends
  thinking the mount is live; callers hang for minutes. No resume → in-flight _mutating_ calls are
  unknown-once with **no idempotency anywhere**. A DO restart/deploy **mass-drops every live mount at once**
  while the durable record still says "live."
- **A4 — split-brain by name (CONFIRMED).** Eviction keyed by _name_ not _connection-epoch_: a late
  `onRpcBroken` from the dead session deletes the freshly-reconnected healthy mount.

**B. capnweb ships _evaluation over the wire_ with no resource governor.**

- **B1 — unbounded batch DoS (CRITICAL).** `newHttpBatchRpcResponse` reads the whole POST and evaluates
  every op before responding; capnweb caps message size (32 MB) + depth (256) but **not op-count or
  exports-table size** → a 100 MB body ≈ ~2.3 M synchronous resolutions on one 30 s / 128 MB single-threaded
  DO. No config knob.
- **B2 — `.map()` fan-out.** One frame replays per input element, unbounded, each a full fallthrough +
  real egress subrequest → attacker-chosen multiplicative amplification (also collides with the 6-connection
  / 1,000-subrequest walls).
- **B3 — zero resolution cache.** `resolve()` re-walks the parent chain on _every_ property access; normal
  traffic — not just attackers — saturates the single-threaded DO.

**C. No authority model (untrusted-code blocker).**

- **C1** `resolve`/`provide`/`setParent`/`whoami` are **unauthenticated public wire methods** (capnweb makes
  every prototype method callable, no allowlist).
- **C2** **Unbounded upward resolution** — the bottom (untrusted) layer resolves the _union of every
  ancestor's capabilities by name_, no per-caller ACL. The headline demo **is** the exploit.
- **C3** `egress` = **re-delegable, secret-bearing ambient CP authority** handed to untrusted code → SSRF +
  secret exfil; capnweb lets a holder re-delegate to third parties.
- **C4** Unauthenticated cross-origin WS (`ACAO:*`, no Origin check).
- **C5 (safe)** Prototype pollution is blocked (`#caps` is a Map; capnweb neutralizes `Object.prototype`
  names; `constructor` reserved).

**D. Single-DO topology.** SPOF + hot shard (D1); the **3-party relay makes the middle a hard liveness
dependency** — control-plane down → project↔Pi fails though both are healthy — plus double latency (D2);
version/contract skew across independently-deployed layers (D4).

## Classification for the commit decision

**① Fixed in the spike now (regression still green):**

- Phantom `Symbol.dispose` crash — the trap's `has()=>true` made `Symbol.dispose in host` true while the
  value was `undefined`, so capnweb's teardown called `undefined()` and crashed on **every** disconnect that
  exported a host. Fixed: `has` reports real presence for symbols/reserved.
- `setParent` didn't `.dup()` (unlike `provide`) → a remote call stored a stub disposed at call-end →
  permanent unauthenticated fallthrough wedge. Fixed: dup stubs.

**② Design guardrails REQUIRED before untrusted / at-scale commit** — and note **most of these are already the
fork-9 / §2a leans; the spike just didn't implement them.** They are mandatory, not optional:

- **Resolve downward-only + per-caller-scoped; mutators (`provide`/`setParent`) OFF the tenant wire surface**
  (two facets); in-band auth + Origin allowlist. _(C1–C4)_
- **Per-tenant host isolation** — not one singleton DO. _(D1, B3)_
- **Store parent + statics as NAMES pulled at birth, not captured stubs; resolve-by-name + cache the
  resolved provider; do NOT hold an intermediate stub per access.** This is the fix for the A1 leak _and_ the
  B3 cache miss — and it's literally "cache the routing, not the data" (§2a). _(A1, B3)_
- **Key live-mount eviction by connection-EPOCH, not name.** _(A4)_
- **Idempotency for mutating calls** (capnweb has no resume; never naive-retry). _(A3)_

**③ capnweb-level limits (need an upstream patch or an edge governor):**

- **Resource governor** — op-count / fan-out / rate caps before evaluation. _(B1, B2)_
- **Hibernation for live sockets** — capnweb can't `acceptWebSocket`, so holding thousands of live
  capnweb sessions in DOs is billing-prohibitive. **Live always-connected providers likely need a raw
  hibernatable-WS holder + a thin message protocol — NOT a pinned capnweb session.** Reserve capnweb for
  request/response + short-lived control. This is the **biggest architectural fork the red-team surfaced.**
  _(A2, A3)_

## Verdict

**The model is sound and every core proof stands** — pipelining 1+1, transport duality, the native-boundary
leg, the uniform host + parent fallthrough + provided caps. **None of the findings invalidate any proven
result.** What the red-team kills is the **naive hosting/scale/trust posture of the spike**, specifically three
"for now" shortcuts:

1. **resolve-on-every-access holding stubs** → replace with resolve-by-name + cache (fixes the leak).
2. **one singleton capability-host DO** → per-tenant sharding; and the resolver DO is not where live sockets
   should live.
3. **capnweb-session-in-a-DO as the live-mount primitive** → wrong for always-on devices and the hot path;
   use hibernatable raw WS + a protocol, capnweb for control/RPC.

Net: **committable as the resolution/authority MODEL; not committable as spiked for untrusted, multi-tenant,
always-connected use** until ② lands and ③ is answered. The good news — ② is mostly the leans you'd already
written down; the red-team just proved they're mandatory and showed exactly where the naive version dies.
