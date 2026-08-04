# Red-team 1 — VOLUME, FAN-OUT, and PIPELINING AMPLIFICATION

Adversarial review of the uniform capability-host design (`spikes/capability-fallthrough/`)
under scale. Domain: how it breaks when a client sends _a lot_, when misses multiply across
hops, and when one DO is the single resolver. No reassurance — only failure theories.

**What the design gives an attacker for free (the thesis):**

1. **Server-side work amplification is the default.** Every wire frame the server reads is
   _evaluated synchronously_ in the read loop (`index.js:2508`,
   `new Evaluator(...).evaluate(msg[1])`), and evaluation walks the capability graph through
   `followPath` (`index.js:716`), which for an `rpc-target` does `value[part]`
   (`index.js:737`) — i.e. it _invokes our prototype-Proxy `resolve()`_ for every path
   segment. One small message → many resolutions → many `Map.get` + parent-chain walks.
2. **There is no cache anywhere.** `resolve()` (`capability-host.mjs:65-73`) does
   `#caps.get(name)` then `#parent.resolve(name)` on every single call. Nothing memoizes the
   answer. Every miss re-walks the whole parent chain, every time.
3. **The resolver is a single-threaded DO.** `gateway.mjs` reaches `env.HOST_DO.getByName("singleton")`
   — literally one Durable Object. Cloudflare DOs are "inherently single-threaded" (DO limits
   docs) with a soft 1,000 req/s ceiling and 128 MB isolate memory. The source of truth _is_
   the bottleneck (design doc §4: "a capability-host DO is the single source of truth **and**
   the resolver", "initially just route everything through a durable object").
4. **capnweb's only real backpressure is send-side.** `FlowController` (`index.js:3193`) gates
   the _sender_ (`onSend`→`shouldBlock`, `index.js:3209-3222`). A hostile client owns its send
   loop and ignores it; the server `readLoop` (`index.js:2492`) has _no_ receive-side rate
   limit — it reads, size-checks one frame, evaluates, repeats.

Everything below is a specific way to weaponize those four facts.

---

## Ranked failure theories

### 1. BLOCKER — Unbounded batch: one HTTP POST → millions of evaluated calls in one DO isolate

**Mechanism.** `newHttpBatchRpcResponse` (`index.js:2805-2812`) does `body = await request.text()`
then `body.split("\n")` to get the message array, constructs a session, and `await rpc.drain()`
— it evaluates **every** newline-delimited message before responding. The per-_message_ size cap
(`maxMessageSize = 32 MB`, `DEFAULT_LIMITS`, `index.js:1267`) is checked only per line
(`index.js:2502`) and **only when `encodingLevel === "string"`**. There is **no cap on the number
of messages/pushes in a batch** and no cap on the exports table — each `push` does
`this.exports.push({hook, refcount:1})` (`index.js:2510-2513`), growing an in-memory array one
entry per op.
**Trigger.** A POST body near the Cloudflare request-body limit (100 MB free/pro, 200 MB Business,
500 MB Enterprise — Workers limits docs) filled with tiny pipelined pushes. A minimal push like
`["push",["pipeline",0,["egress","fetch"],[["u"]]]]` is ~45 bytes ⇒ **~2.3 million operations in a
100 MB body**, each synchronously evaluated in the DO.
**Evidence.** `index.js:2807` (`request.text()`), `:2808` (`split("\n")`, no length guard),
`:2510` (`exports.push` per op), `:2502` (size check is per-line only); Cloudflare request-body
limit 100 MB (Workers limits). DO CPU default 30 s / 128 MB (DO limits).
**Severity.** **Blocker.** Bites the _first time_ any untrusted client can POST to `/api`. Even a
few hundred thousand ops blow the 30 s CPU limit or the 128 MB isolate; because the DO is
single-threaded, the isolate is unavailable to _every other_ consumer of that DO for the duration,
then dies. Batch = classic amplification (bytes-in ≪ work-done).
**Cheap experiment.** Against the spike's `/api`: `curl -X POST --data-binary @big.txt` where
`big.txt` is 1 M lines of the push above; watch wall-time / OOM. Or purely local: build a
`BatchServerTransport` with a synthetic array of 1e6 pushes targeting a local `CapabilityHost`
and time `drain()` + `process.memoryUsage()`. No network needed.
**Mitigation & cost.** Add `maxMessagesPerBatch` and `maxExports` to a forked `DEFAULT_LIMITS` and
enforce in `readLoop`/batch split; reject oversized batches with a 413. Cost: fork/patch capnweb
(not currently configurable — limits are read from `getLimits()` which returns the frozen default,
`index.js:1658`), plus picking a number that doesn't break legitimate large batches.

### 2. BLOCKER — The single "singleton" capability-host DO is a global hot shard

**Mechanism.** All resolution funnels through one single-threaded DO
(`gateway.mjs`, `getByName("singleton")`). Worse, in the layered design _every project's every
miss_ falls through to the **control-plane** host (design doc §1/§4: project → control-plane →
iterate), so the CP host DO is a global chokepoint for egress/auth/directory across all tenants.
DOs serialize: one slow or abusive caller blocks all others on that object.
**Trigger.** Fan-in: N concurrent projects each doing `project.egress.fetch(...)`. Each is a
miss at the project layer → native RPC hop into the CP host DO's `resolve("egress")`. The DO
processes them serially.
**Evidence.** DO "inherently single-threaded" + "soft limit of 1,000 requests per second per
object" (DO limits docs); `gateway.mjs` singleton; no per-project sharding in the spike. Design
doc §2a admits it: _"'Everything through one DO is easier' is true for consistency but is the exact
**pin** we're escaping."_ The KV projection that would relieve it is explicitly deferred
(§4: "one DO now; stateless/KV later").
**Severity.** **Blocker at moderate scale.** Past ~1 k resolutions/s aggregate (trivially reached
if resolution is on the hot request path and uncached — see #6), the DO saturates and every tenant
sees latency/queueing. This is a shared-fate design: one tenant's load is everyone's outage.
**Cheap experiment.** Fire 2–4 k concurrent `runDemo(proj)` calls at `/test/native` (all hit the
one `singleton` DO) and plot p50/p99 vs concurrency; compare against sharding the DO by a random
name to show the ceiling is the single object, not the code.
**Mitigation & cost.** Shard the host DO per-project (and keep the CP host itself replicated/behind
the KV routing projection from §2a). Cost: the whole "one DO is source-of-truth _and_ resolver"
simplification goes away; you need the KV-projection read path _before_ launch, not "later."

### 3. BLOCKER — `.map()` record-replay: one frame → N (or N×M) server-side call chains

**Mechanism.** `.map(f)` sends ONE `remap` frame carrying recorded `instructions`
(`MapBuilder`, `index.js:2907-2970`). Server-side `applyMap` iterates the input array and, **per
element**, constructs a `MapApplicator` and replays the full instruction list
(`index.js:3104-3123`, loop at `:3111`). Each replayed instruction can be a `pipeline` call
(`index.js:2955-2960`) that traverses the capability fallthrough. So a map over an N-element array
= N chains of resolutions/calls from one small frame. **Nested maps compound**: an inner map emits
a `remap` instruction embedded in the outer (`index.js:2941-2947`), so `arr.map(x => x.sub.map(y =>
y.f()))` fans out **N×M**.
**Trigger.** `bigArray.map(x => project.egress.fetch(x.url))` where `bigArray` is a server-held
value (e.g. a directory listing) with 10^5+ entries; or nested maps for multiplicative blow-up.
**Evidence.** `index.js:3111` (per-element replay), `:3096-3102` (`applyMapToElement` deep-copies

- replays), `:2941` (nested → `remap`). No element-count limit anywhere; `maxDepth` (256) bounds
  _nesting of the encoded value_, not _array length_ or _fan-out_.
  **Severity.** **Blocker.** The amplification factor is attacker-chosen and unbounded; nested maps
  make it super-linear. Every replayed `egress.fetch` is also a real subrequest (see #7). Streams are
  out of scope, but `.map` over any capability isn't.
  **Cheap experiment.** Add a provider that returns a large array, then a consumer that does
  `.map(x => host.egress.fetch(x))`; count frames on the `inproc.mjs` wire (one `remap` out) vs
  `doFetch` invocations server-side (N). Then nest a second `.map` and confirm N×M.
  **Mitigation & cost.** Cap map input length and forbid/limit nested maps; meter replayed-call count
  per session against a budget. Cost: `.map` is a headline capnweb ergonomic (README leans on it);
  capping it changes the programming model and needs a capnweb patch.

### 4. SERIOUS — Deep-path amplifier: a single tiny push with a very long path

**Mechanism.** A pipelined call carries a `path` array (`["a","b","c",…]`). `followPath` walks it
segment-by-segment (`index.js:717` loop), and for an `rpc-target` each segment does `value[part]`
(`index.js:737`) → our Proxy `resolve()`. Path length is an _array length_, not encoded _depth_, so
`maxDepth` (256) does **not** bound it. One ~10 KB push can carry ~2,000 segments ⇒ 2,000
synchronous `resolve()` calls (each a `Map.get` + possible parent walk) inline in the read loop.
**Trigger.** `stub.a.a.a.…(thousands).whatever()` where each `a` resolves to a host that also
resolves `a` (any self-referential or deep mounted subtree), keeping every segment a hit so it
doesn't error early.
**Evidence.** `index.js:717-739` (per-segment property access on rpc-target), `capability-host.mjs:65`
(each access = a full `resolve`). Depth cap is nesting-only (`index.js:1706`), irrelevant to path
length.
**Severity.** **Serious.** Lower amplification than #1/#3 (bounded by 32 MB message → ~hundreds of
thousands of segments max) but _synchronous_ — it pins the single DO thread with zero I/O, immune to
the 6-connection and subrequest caps because no subrequest is issued for local resolves.
**Cheap experiment.** Wire a host whose `resolve("a")` returns itself; send one push with a 50 k-
segment path; time the synchronous stall.
**Mitigation & cost.** Enforce a max path length in `followPath` / the evaluator. Cost: capnweb
patch; pick a limit that doesn't break legitimately deep capability trees.

### 5. SERIOUS — N-hop fallthrough multiplies every miss into cross-isolate round trips

**Mechanism.** A miss at the project host calls `#parent.resolve(name)`
(`capability-host.mjs:71`). With a remote parent this is a real RPC. Three layers
(project→control-plane→iterate) means a miss that only resolves at `iterate` costs **two**
cross-isolate hops _per resolution_, and because there's no cache (#6) it recurs on every call.
For native (DO/service-binding) parents, each hop is also a **subrequest** counting against the
1,000/request cap (10,000 paid). A pipelined expression that touches K distinct missing members
= up to K×(chain length) hops.
**Trigger.** A request whose capability names are all shadow-misses that only the outermost layer
provides (e.g. flavor/lifecycle hooks), issued in a `.map` over many elements (compounds with #3).
**Evidence.** `capability-host.mjs:71` (recursive remote `resolve`); design doc §6 fork-9 note:
_"a provided-cap miss costs a round-trip before hitting config defaults"_ and _"the cross-transport
fallthrough is a three-party proxy relayed through the middle shell (no cross-connection GC)."_
Subrequest cap 1,000 (Workers limits); 6 simultaneous outgoing connections (Workers/DO limits).
**Severity.** **Serious.** Latency stacks per hop; worse, the deepest layer (iterate) becomes a
fan-in point for all first-party projects. Spike measured 1+1 round trips for a _hit_; a _miss_
train is unmeasured and strictly worse.
**Cheap experiment.** Extend `demo-node.mjs` case B to a 3-deep remote chain and a workload of
all-misses-resolved-at-terminal; count wire frames per logical call via `inproc.mjs` `summarize()`.
**Mitigation & cost.** Birth-pull parent mounts into the local fold once (design doc §6 option B) +
negative-result caching. Cost: staleness/shadowing-consistency window; eviction correctness (the
doc flags "vacuous-rejection can hide an unbound project if birth-pull/eviction is sloppy").

### 6. SERIOUS — Cache-less resolution turns innocent property access into an RPC storm

**Mechanism.** `resolve()` has no memoization (`capability-host.mjs:65-73`). The prototype-Proxy
means _every property read_ on a host is a resolve (`capability-host.mjs:83-88`). Ordinary
ergonomic code — `const e = project.egress; await e.fetch(a); await e.fetch(b);` — re-resolves
`egress` each time it's re-read; loops that re-touch `project.iterate.flavor` re-walk the chain
each iteration. Combined with the remote parent (#5), each innocent read is a round trip.
**Trigger.** Any hot loop or per-request handler that reads capability members repeatedly (the
_expected_ usage), across many concurrent requests.
**Evidence.** `capability-host.mjs:65-73` (no cache), `:83-88` (`get` trap → `resolve` on every
access), `:87` returns `receiver.resolve(prop)` unconditionally for non-reserved names.
**Severity.** **Serious.** This is the steady-state load generator that drives #2 (the single DO)
into saturation without any adversary — normal traffic at scale is enough.
**Cheap experiment.** Instrument `resolve()` with a counter; run a loop that reads
`project.iterate.flavor` 1,000× and confirm 1,000 chain walks (and, with remote parent, 1,000
round trips).
**Mitigation & cost.** Memoize resolved caps per host with an event-driven invalidation (the mount
table is already a stream fold — invalidate on mount-change). Cost: shadowing/eviction correctness;
must not cache across a `provide()` that shadows.

### 7. SERIOUS — Egress fan-out hits the 6-connection / subrequest walls and serializes on the CP

**Mechanism.** `Egress.fetch` (`graph.mjs:33`) performs the real outbound call, mediated by the
control-plane host. Projects have no raw fetch; _all_ their egress funnels through the CP egress
capability. Cloudflare caps **6 simultaneous** outgoing connections per request and **1,000**
subrequests/request. A `.map`-driven fan-out of fetches (see #3) both exhausts the 6-connection
window (everything queues behind 6) and can blow the subrequest cap.
**Trigger.** `urls.map(u => project.egress.fetch(u))` with >1,000 URLs, or high concurrency where
the CP egress isolate is the shared path.
**Evidence.** `graph.mjs:27-38` (all egress via one CP capability); Workers limits: "6 connections
simultaneously", subrequests 1,000 (free 50, paid 10,000). Because egress is _provided down_, the
CP worker owns the subrequest budget, not the project.
**Severity.** **Serious.** DoS of the shared egress path + accidental self-throttling; the 51st/1001st
fetch errors or stalls, and because it's a shared capability the blast radius is cross-tenant.
**Cheap experiment.** Point `/egress-target` at a slow endpoint; issue 20 concurrent
`project.egress.fetch` and observe only 6 in flight; issue 1,001 and observe the cap error.
**Mitigation & cost.** Per-tenant egress concurrency limits + queueing with backpressure signaled
to the caller. Cost: egress is no longer a transparent passthrough; you add a scheduler.

### 8. SERIOUS — No receive-side backpressure: send-side flow control is trivially bypassed

**Mechanism.** capnweb's congestion control (`FlowController`, `index.js:3193-3260`) only advises
the _sender_ to block (`onSend`→`shouldBlock`, `:3221`). The server `readLoop` (`index.js:2492`)
has no equivalent — it awaits `transport.receive()`, size-checks one frame, evaluates, loops. A
malicious client bypasses its own `FlowController` (it controls its transport) and floods.
**Trigger.** A custom WS client that writes frames as fast as the socket drains, never reading
`resolve` replies (so it never pays for backpressure).
**Evidence.** `index.js:3209-3222` (flow control is send-path), `:2492-2515` (read loop has no
rate/inflight limit), `:2502` (only a per-frame size check). WS received-message cap is 32 MiB
(DO limits) — per message, not per second.
**Severity.** **Serious.** Turns #1/#3/#4 from "one big request" into "sustained flood," and the
single DO thread can't drain faster than one frame at a time.
**Cheap experiment.** Open a raw WS to `/api`, pump `["push",…]` frames in a tight loop without
reading; watch the server isolate CPU pin and memory (exports table) climb.
**Mitigation & cost.** Enforce max in-flight pulls / ops-per-window per session server-side and
abort abusers. Cost: capnweb has no such hook today — needs a patch to `readLoop`.

### 9. SERIOUS — Exports/imports tables grow unbounded and never compact within a batch

**Mechanism.** Each `push` appends to `exports` (`index.js:2510`); releases use
`delete this.imports[id]` (`index.js:2460`) leaving sparse arrays that never shrink; `getStats`
counts by iterating (`index.js:2600-2601`). In an HTTP batch nothing is released until the batch
ends (`drain`, `index.js:2584`). So a batch of M ops holds M export hooks (each a `PayloadStubHook`
retaining a payload) live simultaneously in a 128 MB isolate.
**Trigger.** A large batch (#1) where each op returns a non-trivial payload (e.g. `.dup()` of a
live cap — `resolve` dups on every hit, `capability-host.mjs:68`), so each export pins a stub.
**Evidence.** `index.js:2510` (push→export, no eviction mid-batch), `:2460` (sparse delete),
`capability-host.mjs:68` (`hit.cap.dup()` per resolve → a retained stub); DO 128 MB memory.
**Severity.** **Serious.** OOM well before the CPU limit for payload-heavy batches; the dup-per-
resolve makes live-capability workloads especially memory-hungry.
**Cheap experiment.** Batch of 500 k pushes that each resolve a live cap; log `getStats()` +
`memoryUsage()` growth; confirm linear, unreleased growth until drain.
**Mitigation & cost.** Stream/incremental release within a batch; cap concurrent live exports.
Cost: changes batch semantics; capnweb patch.

### 10. ANNOYANCE→SERIOUS — `has() => true` makes the host a universal responder (probe amplifier)

**Mechanism.** The Proxy `has` trap returns `true` for everything (`capability-host.mjs:89-91`),
and `get` resolves any non-reserved name (`:84-88`). So _any_ name a client probes is treated as a
capability lookup and walks the parent chain to the terminal, where it throws only after the full
walk (`capability-host.mjs:72`). Enumeration/typo/scanner traffic each costs a full chain walk +
(remote) round trips before failing.
**Trigger.** A client that probes many random member names (fuzzing, `in` checks, JS machinery
touching unexpected props not in `RESERVED`).
**Evidence.** `capability-host.mjs:89-91` (`has`→true), `:71-72` (miss walks to terminal then
throws), `:19-22` (`RESERVED` is a _hardcoded_ short list — anything outside it resolves).
**Severity.** **Serious under adversary, annoyance otherwise.** Each probe is cheap alone but
composes with #1/#8 (batch/flood of misses = worst-case chain walks, the most expensive path).
Also a correctness footgun: a stray property access in library code silently triggers RPC.
**Cheap experiment.** Batch of 100 k pushes with random unique member names; every one walks to the
terminal — measure vs the same count of hits.
**Mitigation & cost.** Bound negative lookups (cache "no such cap"), and/or make `has` reflect the
actual mount set. Cost: `has`→true was deliberately chosen (README "Gotchas": _"has() => true …
which is what capnweb's property-access check wants"_), so tightening it risks breaking pipelining.

### 11. ANNOYANCE — `structuredClonable`/binary WS encoding disables the 32 MB capnweb message cap

**Mechanism.** The per-message size check is guarded by `encodingLevel === "string"`
(`index.js:2502`). On a workerd WS/native path using a non-string encoding
(`jsonCompatible`/`structuredClonable`, `index.js:2189`), that check is skipped entirely — only the
platform WS cap (32 MiB received, DO limits) applies, and the estimator `estimateEncodedSize` is
capped at `MAX_ESTIMATE_DEPTH = 64` (`index.js:1977-1982`) so deep structures are _under-counted_.
**Trigger.** Any deployment that selects a binary encoding for the native leg (likely for the
DO/service-binding transport) — the capnweb-level guardrail silently doesn't apply.
**Evidence.** `index.js:2502` (string-only guard), `:2189` (encoding options), `:1977` (estimate
depth cap 64 → undercount).
**Severity.** **Annoyance/latent.** Not a direct break, but it removes a guardrail exactly on the
native path the design leans on, widening #1/#9.
**Cheap experiment.** Run the native leg with a structuredClonable transport and send a >32 MB-
encoded value; confirm no capnweb-level rejection (only platform).
**Mitigation & cost.** Always set/verify a size limit independent of encoding level. Cost: small
capnweb patch.

### 12. ANNOYANCE — Static capabilities are copied on every resolve (needless allocation at volume)

**Mechanism.** A static cap returns `hit.cap` by value (`capability-host.mjs:69`); over RPC the
result is deep-copied on the way out (`RpcPayload.deepCopyFrom`, e.g. `index.js:831`). A large
static value (config blob, directory snapshot) is re-serialized/copied on _every_ resolve because
there's no cache (#6).
**Trigger.** A frequently-read large static capability (e.g. `brandName` is tiny, but a real
`config`/`directory` static would not be) under high read volume.
**Evidence.** `capability-host.mjs:69` (return by value), `graph.mjs:51` (`brandName` static),
`index.js:831` (`deepCopyFrom` on get). No memo.
**Severity.** **Annoyance,** escalating with payload size × read rate; feeds #9's memory pressure.
**Cheap experiment.** Provide a 1 MB static cap; resolve it 10 k× in a batch; measure copy cost +
memory.
**Mitigation & cost.** Cache/freeze static payloads and share the serialized form. Cost: cache
invalidation on shadowing.

---

## The 3 scariest

1. **#1 Unbounded batch → millions of evaluated ops in one single-threaded DO.** capnweb enforces
   _per-message_ limits (32 MB, depth 256) but **nothing on op-count-per-batch or exports-table
   size** (`index.js:2805-2812`, `:2510`), and `newHttpBatchRpcResponse` evaluates the entire body
   before responding. A single 100 MB POST is millions of resolutions on a 30 s / 128 MB DO thread.
   This is exploitable on day one and there is no configuration knob for it today.

2. **#2/#6 The one "singleton" resolver DO with zero resolution caching.** The design _chose_ one
   DO as source-of-truth-and-resolver (design doc §4) and `resolve()` re-walks the parent chain on
   every property access (`capability-host.mjs:65-73`). Normal traffic at scale — not even an
   attacker — saturates the single-threaded 1,000-req/s object. The relief valve (KV routing
   projection) is explicitly deferred; the design admits this DO is "the exact pin we're escaping."

3. **#3 `.map()` fan-out (nested → N×M) over the fallthrough.** One tiny `remap` frame replays its
   instruction list per input element (`index.js:3104-3123`), each replay a full capability
   traversal + (for egress) a real subrequest, with **no element-count or nesting cap**. The
   amplification factor is attacker-chosen and multiplicative; it turns one frame into an unbounded
   server-side call storm that also collides with the 6-connection / 1,000-subrequest walls.

**Common root cause:** the design pushes _evaluation_ (not just transport) across the wire, makes
every property access a graph walk, funnels it through one uncached single-threaded object, and
inherits a capnweb whose only limits are per-message size/depth — none of which bound
_op-count, fan-out, or resolution rate_. Volume defenses (batch caps, resolution cache, per-tenant
DO sharding + KV routing read-path, map/fan-out budgets, receive-side backpressure) are all
**absent** and several require patching capnweb, not just the host.
