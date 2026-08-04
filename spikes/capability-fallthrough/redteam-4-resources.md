# Red-team 4 — RESOURCE MANAGEMENT, DISPOSAL, LEAKS & GC

Adversarial review of the "everything is a capability host" design
(`capability-host.mjs`, `graph.mjs`, `gateway.mjs`; design doc
`jam-capability-provision.md` §2a/§4/§6; pipelining spike
`spikes/capnweb-pipelining/`). Domain: **object lifecycle** — what leaks, what
over-disposes, and what crashes the disposal machinery, across capnweb sessions
that have **no distributed GC**.

**Verdict up front.** The design's own ergonomic premise — _unknown member access
falls through to a (possibly remote) parent_ — is a **per-call, unbounded
import/export-table leak** whenever the fall-through crosses a wire, because the
intermediate resolved stub is never disposed and capnweb cannot GC it. Worse, the
**one fix** (dispose the intermediate) trips a **second, latent bug**: the
prototype Proxy's `has() => true` makes every host claim `Symbol.dispose in host`,
so capnweb's disposal path calls a **non-existent disposer and crashes the
isolate**. The leak currently _masks_ the crash; repairing either exposes the
other. Both are **measured from source in this repo**, not theorized.

This report is complementary to `redteam-2-duration.md`. That one proves a
_retained mount pins one session forever_ (steady-state, connected-but-idle
billing). This one proves the tables **grow per request even on a healthy,
busy connection** and that **teardown crashes** — the failure modes on the
_churn_ and _shutdown_ axes, not the idle axis.

---

## Load-bearing facts (verified in this repo)

- **capnweb refcounts; it does not GC.** Imports/exports are plain arrays
  (`imports=[]`, `exports=[]`, `dist/index.js:2171-2173`); freed slots are
  `delete`d leaving holes (`:2247`, `:2460`); export IDs are monotonic
  (`nextExportId--`, `:2176`), imports pushed by `imports.length` (`:2396`,
  `:2412`, `:2445`). An entry lives until its refcount hits 0
  (`releaseExport`, `:2241`; `RpcImportHook.dispose` → `--localRefcount`,
  `:2143-2148`). There is **no `FinalizationRegistry`** anywhere in the dist.
  capnweb README §Resource Management says GC "does not work well" and mandates
  explicit disposal or short sessions.
- **`RpcSession.getStats()` exists precisely for this** (`:2595-2603`,
  `:2618`): `{imports, exports}` counting live table entries. It is the leak
  oracle. **Caveat proven below:** it counts _entries_, not `localRefcount`, so
  it _under-reports_ dup-based leaks.
- **`provide()` dups a live stub and stores it forever** (`capability-host.mjs:54`);
  **`resolve()` returns a fresh `hit.cap.dup()` on every access** (`:68`) or, on a
  miss, `return this.#parent.resolve(name)` with **no dup and no ownership**
  (`:71`).
- **A local RpcTarget has no `.dup`** (dup is `RESERVED`, so the trap yields
  `undefined`; `IterateFlavor`/`Egress` define none) — so `provide`/`resolve`
  correctly leave local caps un-dup'd. Only **remote capnweb stubs** (which have a
  real `.dup`, `dist/index.js:219`) are dup'd.
- **CF isolate cap = 128 MB** including JS heap (CF Workers limits). DO shares the
  isolate. Every leaked import/export entry retains an `ImportTableEntry` /
  `{hook, refcount}` **and the whole capability object graph the hook points at**,
  plus a `reverseExports` Map slot (`:2172`, `:2223`) that only shrinks on
  release.

---

## How I measured (the cheap experiment, reproduced)

A ~90-line probe reusing the repo's own `inproc.mjs` + `new RpcSession(...)`
(which exposes `getStats()`), wiring `demo-node.mjs` scenario B — a **local
`CapabilityHost` whose `parent` is a REMOTE stub** (the exact self-host / Pi /
3-party-middle topology the design centers on) — then calling the ergonomic
fall-through repeatedly and printing `getStats()` each iteration. All numbers
below are copied from real runs. (Probe was run in the spike dir so `capnweb`
resolves to the same module instance, then removed; it is trivially
reconstructable from the snippets herein.)

Headline measurement (10 ergonomic calls of `project.iterate.flavor.flavorPrompt("a")`):

```
ergonomic chain x10:      proj.imports=11   cp.exports=11     ← +1 / +1 per call, never released
dispose intermediate x10: proj.imports=1    cp.exports=2  then → TypeError crash (phantom Symbol.dispose)
```

40 iterations × 2 ops (`.iterate.flavor.flavorPrompt` + `.egress.fetch`):
`project.imports 1→81`, `control-plane.exports 1→81`, strictly monotonic,
`FINAL == peak` (nothing ever reclaimed).

---

## Ranked failure theories

### 1. Per-call fall-through leak — unbounded import/export growth on a healthy connection ★ SCARIEST

**Mechanism.** The ergonomic chain `host.a.b.c()` is **JS** property access on a
_local_ host object, not one capnweb expression. `host.a` fires the prototype
trap → `resolve("a")` → on a miss, `this.#parent.resolve("a")`
(`capability-host.mjs:71`). When `#parent` is a remote stub that is a **separate
RPC call**: `sendCall` allocates an import entry on the inner session
(`dist/index.js:2396`) and an export entry on the outer
(`exportStub`, `:2211`), and returns an `RpcPromise`. The caller then does
`.b.c()` **on that promise** and awaits — but the **intermediate `host.a`
promise/stub is never disposed**. JS drops the reference; capnweb's table entry
does not care about JS references (no GC). `localRefcount` stays 1 forever; the
export is never `release`d. **One leaked import (inner) + one leaked export
(outer) per fall-through property access, for the life of the session.**
**Trigger.** Every ergonomic remote fall-through — i.e. the design's whole point.
The DATA axis is _"hot — every ingress request"_ (design §1); `project.egress`,
`project.auth.gate`, `project.email` all fall through to the CP per request.
**Evidence.** `capability-host.mjs:71`; `followPath` rpc-target branch does
`value = value[part]` and never disposes the interim (`dist/index.js:737`);
`sendCall`/`exportStub` allocate without an owner (`:2384-2398`, `:2211-2225`).
**Measured:** 10 calls → 11/11; 40×2 → 81/81, monotonic (getStats).
**Severity/scale.** CRITICAL. At even 10 req/s on one project's CP link, ~36k
leaked entry-pairs/hour, each pinning a hook + its target graph + a Map slot →
128 MB isolate OOM in hours, or DO eviction (which _re-seeds_, Theory 10). The
pipelining spike (`spike.mjs`) **never caught this** because it only tested the
_consumer→hub→provider all-remote-stub_ shape (one pipelined expression, clean
disposal — see Theory 6 "why scenario 2 is flat"); it never tested a **local host
with a remote parent**, which is the deployed topology.
**Cheap experiment.** The probe above; assert `getStats().imports` constant
across N calls.
**Mitigation + cost.** (a) _Don't remotely fall through per request_ — pull the
CP's mounts into the project's **local** fold once at birth (design §6 fork B's
"pull CP mounts into the local fold at birth"); steady-state resolution is then
local and dup-free. Cost: births get heavier, shadowing needs invalidation. (b)
Capture + dispose intermediates — **blocked by Theory 2** until the has-trap is
fixed. (c) Flatten each capability to a single pipelined call from a remote
_stub_ to the host (scenario-2 shape) rather than a local host re-emitting a
remote stub. Cost: gives up the "local object with a parent" model that
`capability-host.mjs` is built on.

### 2. `has() => true` makes every host a phantom `Disposable` → capnweb calls a non-existent disposer → isolate crash ★ SCARIEST

**Mechanism.** capnweb disposes an exported RpcTarget via
`disposeRpcTarget(target)`: `if (Symbol.dispose in target) target[Symbol.dispose]()`
(`dist/index.js:876-882`). The host's prototype Proxy answers **`has() => true`**
(`capability-host.mjs:89-91`), so `Symbol.dispose in host` is **`true`** even
though the `get` trap returns `undefined` for it (symbols short-circuit to
`Reflect.get`, `:85`). capnweb then calls `undefined()` →
**`TypeError: target[Symbol.dispose] is not a function`**, thrown inside
`readLoop`/`abort` → session abort → uncaught → isolate teardown. The same lie
also gives the host a bogus refcount at `TargetStubHook` construction
(`else if (Symbol.dispose in target) this.refcount = {count:1}`, `:897`),
corrupting ref accounting.
**Trigger.** **Any clean release** of an exported host (peer disposes a stub →
`release` frame → `releaseExport` → `TargetStubHook.dispose` → `disposeRpcTarget`,
`:2249`/`:926`), **any** session shutdown/abort (`:2490`), **any** payload
disposal containing a host (`:625`). Not abort-specific.
**Evidence + measured.** `Symbol.dispose in host === true`,
`typeof host[Symbol.dispose] === "undefined"`, `"anything" in host === true`
(all printed). Two independent crash stacks captured: clean
`readLoop → releaseExport → TargetStubHook.dispose → disposeRpcTarget` (`:878`),
and `RpcPayload.dispose → disposeImpl → disposeRpcTarget` (`:625`→`:878`).
**Severity/scale.** CRITICAL. A single well-behaved client disconnect that
releases a host export crashes the whole session (and any siblings sharing the
isolate). It is currently **latent only because Theory 1 stops exports from ever
being released** — see Theory 3.
**Cheap experiment.** `const h = new CapabilityHost("x"); h[Symbol.dispose]?.()` —
or export a host and dispose the client stub; observe the throw.
**Mitigation + cost.** In the `has` trap, return `false` for `symbol` props and
for `RESERVED`; and/or add `Symbol.dispose`/`Symbol.asyncDispose` to `RESERVED`.
~3 lines, must-do. (Also decide whether a host _should_ be Disposable and, if so,
give it a real `[Symbol.dispose]` that disposes its stored dups — Theory 5.)

### 3. Theories 1 and 2 are LOCKED — the leak masks the crash; fixing either exposes the other ★ SCARIEST

**Mechanism.** The only way to stop Theory 1 is to dispose intermediate
fall-through stubs. Disposing an intermediate whose resolved value is a
`CapabilityHost` runs `RpcPayload.dispose → disposeImpl(rpc-target) →
disposeRpcTarget(host)` → Theory 2 crash. Conversely, Theory 1 guarantees exports
are _never_ released, so `disposeRpcTarget` is _never_ reached in steady state —
which is why the design "looks fine" in the green `demo-node.mjs`.
**Evidence + measured.** Variant 2 above: disposing the intermediate drops
`imports 11→1` **and then throws the phantom-dispose TypeError** in the same run.
**Severity.** CRITICAL — this is a _design trap_, not two isolable bugs. You
cannot ship the ergonomic remote fall-through until **both** the has-trap
(Theory 2) and an ownership/disposal story (Theory 1) are fixed together.
**Mitigation.** Fix Theory 2 first (cheap), then Theory 1's ownership model, then
add a `getStats`-based regression test that fails on monotonic growth.

### 4. The 3-party middle (control plane) accrues BOTH sides of the leak

**Mechanism.** In `project → control-plane → Pi`, capnweb proxies through the
middle: the CP holds an **export** entry facing the project (Theory 1) _and_ an
**import** entry facing the Pi, per proxied capability, per call. The busiest node
— the CP, which mediates egress/auth/directory for _every_ tenant on the hot data
axis — is where leaked pairs concentrate fastest.
**Evidence.** `sendCall` import on CP→Pi (`:2396`) + `exportStub` on project→CP
(`:2211`); design §6 fork-9 note "the cross-transport fallthrough is a three-party
proxy relayed through the middle shell (no cross-connection GC in capnweb)"
already flags the absence of GC — this quantifies its cost.
**Severity/scale.** HIGH; the CP OOMs before any single project does.
**Experiment.** Extend the probe to three sessions, watch the middle's `getStats`.
**Mitigation.** As Theory 1(a): resolve locally after a birth-time pull so the CP
is not in the per-request path.

### 5. Shadow / re-provision leaks the prior dup — `#caps.set` never disposes what it overwrites

**Mechanism.** `provide()` stores `cap.dup()` and, on a repeated `provide(name,…)`,
**overwrites the Map slot without disposing the prior dup** (`capability-host.mjs:55`).
The dropped `RpcImportHook`'s `++localRefcount` (`dist/index.js:2097`) is never
decremented, so the import **entry's `localRefcount` inflates permanently** and
the entry — plus the remote provider's pinned export — **can never be released**,
even after every legitimate holder disposes.
**Trigger.** The design _features_ shadowing ("any shell may shadow any
capability a prior shell provided", §4) and **event-sourced re-provision** (mounts
are events; the table is a stream fold, §2b/§4) — so normal operation and every
fold _replay_ re-`provide`s and re-leaks.
**Evidence + measured.** 20 re-provides of a remote stub: import **entry count
stays 1** but the entry is pinned; `getStats().imports` does not move — the leak is
in `localRefcount`, invisible to entry-count monitoring (Theory 8).
**Severity/scale.** HIGH for churny mounts (a Pi that re-announces, a browser that
reconnects); the remote provider's export never frees for the session's life.
**Mitigation.** On overwrite: `const prev = this.#caps.get(name); this.#caps.set(...);
prev?.cap?.[Symbol.dispose]?.()` — **but only after Theory 2 is fixed**, else the
dispose crashes. ~4 lines.

### 6. Is the `.dup()` discipline correct? — verdict: locally correct, globally leaks

- **`provide()` dup is CORRECT** about _what_ to dup: live remote stubs need
  `.dup()` to survive param-disposal (capnweb auto-disposes call params, README
  §Automatic disposal; `getHookForRpcTarget` dups params `:344-346`), and local
  RpcTargets correctly aren't dup'd (no `.dup`). **INCOMPLETE**: never disposes on
  overwrite (Theory 5).
- **`resolve()` dup is CORRECT in isolation** — proven by the "scenario 2" probe:
  a _remote stub_ consumer doing `cpStub.piSensor.read()` keeps every table flat
  (1/1/1) across 40 calls, because that whole chain is **one pipelined capnweb
  expression**; the dup'd stub is disposed when the expression's payload is
  disposed. **But** the _fall-through-to-parent_ branch (`:71`) returns an
  **un-owned** intermediate that the ergonomic _JS_ caller never disposes → Theory
  1. So the dup is right; the **calling pattern the fall-through enables** is what
     leaks.
- **Deepest issue:** `dup` is a refcount _increment_; correctness needs a matching
  `dispose`, and the ergonomic API (`host.a.b.c()`) **structurally hides the
  handle** you would dispose (you can't `using const x = host.a` when `host.a` is
  consumed inline). Add Theory 2 and even _correct_ dispose calls crash. Net: the
  discipline is sound only where a single pipelined expression owns the result;
  everywhere a local host re-emits a remote stub for further JS navigation, it
  leaks or (once patched) crashes.

### 7. Disposing the parent/main stub tears down the whole connection (footgun)

**Mechanism.** `#parent` is the remote **main** import; disposing it hits
`RpcMainHook.dispose → session.shutdown → abort` (`dist/index.js:2160-2166`),
killing **every** capability reached through that parent, not just the parent link.
**Trigger.** A `using` block, an eviction routine, or a `Symbol.dispose` on the
parent stub. Nothing in `capability-host.mjs` guards it; `setParent` stores it raw.
**Evidence + measured.** Scenario 3: after `cpStub[Symbol.dispose]()`, the next
fall-through throws _"Attempted to use RPC stub after it has been disposed."_
**Severity.** HIGH footgun. **Mitigation.** Hold the parent behind a
non-disposing wrapper, or dup it and only ever dispose the dup; document that the
main stub is not disposable. Small.

### 8. Streams-OUT sink exports leak on every (re)subscribe with no GC to save you

**Mechanism.** Design §2c: "consumer registers a sink, provider pushes batches."
A sink is a callback/RpcTarget param → exported on the provider. If the consumer
drops without disposing (crash, network drop, reconnect), the provider's dup of
the sink **pins the export forever** (no GC). Every reconnect re-subscribes →
another leaked sink. Streams are fed every 1–2 s and **never hibernate** (§0),
so sessions are long and sink churn is high.
**Evidence.** capnweb README GC caveat; `exportStub` `:2211`; compounds Theory 1
on the push path. **Severity.** HIGH for the HA/Pi telemetry case the design
targets. **Experiment.** Subscribe/abort a sink N times; watch provider
`getStats().exports`. **Mitigation.** `onRpcBroken`-driven sink disposal keyed to
the connection (design §6 already wants "the live stub … in the one DO keyed by
connection with `onRpcBroken` eviction" — make it mandatory for sinks). Medium.

### 9. `getStats()` under-reports — dup/refcount leaks are invisible to entry-count monitoring

**Mechanism.** `RpcImportHook.dup` **shares** the entry and bumps `localRefcount`
(`:2133-2135`, `:2097`); `getStats` counts _entries_ (`for (i in imports)`,
`:2600`), not refcounts. So Theory 5's leak (and any dup-without-dispose that
reuses an entry) grows memory while `getStats().imports` stays flat.
**Severity.** MEDIUM but insidious — any leak dashboard built naively on getStats
gives false green. **Mitigation.** Sum `localRefcount`/`remoteRefcount` across
entries, not just count them; capnweb would need a patch or a wrapper to expose it.

### 10. Eviction re-seeds the leak instead of resetting it

**Mechanism.** When CF evicts the DO (it _will_ — see redteam-2), the session and
tables vanish. But the **durable mount table is a stream fold** (§2b/§4): on the
new isolate it **replays every `provide()`**, re-dup-ing and (Theory 5) re-leaking
from turn one, and every subsequent request re-leaks per Theory 1. Eviction is not
a relief valve; it is a periodic reset-to-leaking.
**Severity.** MEDIUM (amplifier). **Mitigation.** Idempotent provision that
disposes superseded dups on replay (needs Theory 2 + Theory 5 fixes first).

### 11. Error / vacuous-reject path may strand intermediate imports

**Mechanism.** `resolve` throws at the terminal (`:72`). In `host.missing.foo()`
the intermediate resolve stub (an import) is created before the terminal rejects;
capnweb's un-awaited-rejection handling (`ignoreUnhandledRejections`, `:669`) and
the design's synchronous-throw goal (fork A "clean vacuous-rejection story")
interact. A rejected-but-un-awaited import promise may leave its entry until
release. **Confidence.** Lower — flag for a targeted `getStats` experiment on the
miss path (repeatedly access an unbound capability, watch imports).
**Severity.** MEDIUM. **Mitigation.** Ensure the miss path disposes the interim
before throwing.

### 12. Monotonic IDs + `reverseExports` Map are the real heap sink

**Mechanism.** Even with perfect disposal, export IDs only ever decrease
(`nextExportId--`) and freed slots are `delete`d (sparse arrays that never shorten);
`reverseExports` (`:2172`) only loses a key on release. Under Theory 1 (nothing
releases) the Map is unbounded and is the dominant retained structure long before
the arrays' own overhead matters. 128 MB cap. **Severity.** MEDIUM (amplifier of
1/4/5). **Mitigation.** Bounded session lifetime + explicit disposal (capnweb's own
sanctioned strategies); the design's long-lived pinning sessions are the
anti-pattern.

---

## The 3 scariest

1. **Per-call fall-through leak (Theory 1).** The ergonomic remote fall-through —
   the design's raison d'être — leaks exactly one import (inner) + one export
   (outer) per property access, never reclaimed (no distributed GC). Measured:
   10 calls → 11/11; 40×2 → 81/81, monotonic. On the hot per-request data axis
   this OOMs the 128 MB isolate (CP first, Theory 4). The pipelining spike missed
   it by only testing the all-remote-stub shape, not a local host with a remote
   parent.

2. **Phantom `Symbol.dispose` crash (Theory 2).** `has() => true`
   (`capability-host.mjs:89`) makes `Symbol.dispose in host` true, so capnweb's
   `disposeRpcTarget` calls `undefined()` → uncaught `TypeError` → session/isolate
   crash on **any** clean release, shutdown, or payload disposal of an exported
   host. Reproduced twice from source.

3. **They are locked together (Theory 3).** The leak masks the crash; the only fix
   for the leak (dispose intermediates) _is_ what fires the crash — demonstrated in
   one run (`imports 11→1`, then TypeError). Neither is shippable alone; fix the
   3-line has-trap first, then the ownership model, then gate with a
   `getStats()`-monotonicity regression test.
