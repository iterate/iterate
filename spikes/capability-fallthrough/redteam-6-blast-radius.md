# Red-team 6 — Failure blast radius, topology & operations

**Target:** the uniform "capability host" fallthrough design (`spikes/capability-fallthrough/`,
`apps/os/docs/simplification/wayfinder/jam-capability-provision.md`). Everything is one
`CapabilityHost`; unknown members resolve locally else **fall through to a parent host** (local
object, native Workers-RPC stub, or capnweb stub). Three layers: **iterate** ← **control-plane** ←
**project**. Cross-machine calls are **3-party proxied through the middle**. Source-of-truth AND
resolver is, "for now," **a single Durable Object** ("one DO now; KV projection later").

Reviewer's stance: adversarial. Below is where it breaks at the system level. Ranked by
severity × likelihood. Every theory has mechanism / trigger / evidence / severity+scale / a cheap
experiment against these spike files / a mitigation with its cost. The "one DO now, KV later"
deferral is assessed explicitly (theory 1, 10) — verdict: **load-bearing, not a safe deferral**.

Hard numbers this rests on (Cloudflare docs, fetched 2026-08-03):

- **DO soft limit: 1,000 requests/second per individual object.** DOs are **single-threaded**.
- **6 simultaneous outgoing connections** per worker/DO invocation waiting for response headers —
  a hard ceiling shared across `fetch()`, service bindings, sockets.
- **Subrequests to internal services (service bindings): 1,000/request cap** (paid can raise the
  external cap to 10k, but internal is capped).
- **DO location is pinned at first `get()`** and "do not currently change locations after they are
  created"; cross-DO calls "will often add response latency as requests must be forwarded to the
  data center where the Durable Object is located."
- **Overloaded DO throws `.overloaded` errors that must NOT be retried** (retry worsens overload);
  "many exceptions leave the DurableObjectStub in a 'broken' state."
- capnweb has **no cross-connection GC** (design doc §6, memory `capnweb_vacuous_rejects`).

---

## THEORY 1 — The single "singleton" DO is a global SPOF _and_ a single-threaded hot shard

**Mechanism.** `gateway.mjs:51` is literally `env.HOST_DO.getByName("singleton").project()` — **one**
DO instance for the entire deployment. The design doc confirms this is intended: "a
**capability-host DO** is the single source of truth _and_ the resolver" (§4, "One DO now"). Every
capability miss on every project funnels through this one object. A DO is single-threaded: it
processes one turn at a time. The instant any resolve blocks on I/O — and the whole point of
fallthrough is that a miss makes an _outbound_ call to a parent (native RPC to the CP DO, or capnweb
to a Pi) — that DO's single thread is occupied awaiting a network round trip while every other
tenant's resolve queues behind it. This is head-of-line blocking across the entire customer base
funneled through one isolate.

**Trigger.** (a) Organic growth past ~1,000 resolves/sec aggregate. (b) One slow fallthrough — a Pi
on a 300 ms link, a cross-region CP DO, a hung egress — stalls the single thread and every unrelated
project's resolve behind it. (c) The DO evicts/crashes → **100% of fallthrough resolution is down**
for every project simultaneously.

**Evidence.** DO **1,000 req/s soft limit** + **single-threaded** (CF docs). Overload throws
non-retryable `.overloaded`; the guidance is explicitly "do not retry." The real system already
lives this pain: memory `incident_do_duration_worker_split_subscriptions` ("subs pin DOs; unfixed")
and the design doc §0 ("a stream fed every 1–2s **never hibernates**"). The spike hard-codes
`getByName("singleton")` — there is no sharding key at all.

**Severity + scale.** Catastrophic, deployment-wide. This is not a per-project blast radius; it is
**every project that falls through**, which by the design's own north-star is _all of them_ (auth,
egress, email, directory all resolve via fallthrough). One object caps the throughput of the whole
platform and serializes unrelated tenants.

**Cheap experiment.** Extend `run-workerd.mjs`: fire N=200 concurrent `mf.dispatchFetch(
"http://gateway/test/native")` at the same `getByName("singleton")` and plot completed-req/s and
p99. Then insert an artificial `await scheduler.wait(200)` inside `HostDO.project()` (or make the
egress fetch slow) and show that ONE slow tenant collapses p99 for ALL callers — that is the HOL
proof. `inproc.mjs` already supports a `HOP=<ms>` per-hop latency knob for the Node variant.

**Mitigation + cost.** Shard the capability-host DO by `(projectId)` or `(projectId, subtree)`
instead of a global `"singleton"`, and make cross-project fallthrough hit only the _layer_ DO it
needs. Cost: you lose the "one DO is source of truth" consistency story the design leans on, and you
must define the shard key + a cross-shard shadow-propagation story (theory 11). This is real
architecture, not a config flip — which is exactly why deferring it (theory 10) is dangerous.

---

## THEORY 2 — The 3-party relay makes the middle a hard liveness dependency for calls that don't need it

**Mechanism.** Cross-machine fallthrough is **relayed through the middle shell**. Design doc §6
fork A states it outright: "the cross-transport fallthrough is a **three-party proxy relayed through
the middle shell** (no cross-connection GC in capnweb)." So a project calling a capability that
lives on a **Pi** does not talk to the Pi directly — the call transits the **control plane**. The CP
must hold both legs of the relay stub alive in memory (capnweb has no cross-connection GC, so the
middle can't let either side get collected). If the control plane isolate/DO is down, evicted, or
mid-deploy, **project↔Pi calls fail even though the project and the Pi are both perfectly healthy**.

**Trigger.** Any control-plane restart, deploy, DO eviction, or overload (theory 1). Also: the
capnweb session on either leg breaking silently — the middle's relay stub is now half-dead.

**Evidence.** Design doc §6 fork A + fork 9 lean ("capnweb has **no cross-connection GC**, so the
durable link must be a record/name and the live stub must live only in the one DO keyed by
connection with `onRpcBroken` eviction"). `demo-node.mjs` case B literally wires the project's parent
as a remote capnweb stub to the CP and pipelines through it — kill that CP `RpcSession` and the
project's egress dies. This is the classic "add a proxy, add a liveness dependency + double the
latency" anti-pattern, and it lands on the busiest node (theory 1).

**Severity + scale.** High. Converts an _independent_ project↔device link into one gated on the
shared central node's health. Double latency on every relayed call (project→CP→Pi→CP→project). Blast
radius = every live/BYO/Pi capability of every project, all coupled to CP uptime. The Pi
unification (§2d) — the marquee use case — is the _most_ exposed because it is the one that most
wants to be independent of the cloud.

**Cheap experiment.** In `demo-node.mjs` case B, after the first successful `runDemo`, call
`cpStub` session teardown (or drop `wire`) and re-issue `project.egress.fetch(...)`; observe the
project↔provider path fail with both endpoints alive. For latency: set `HOP=50` in `inproc.mjs` and
compare a direct 2-party call vs the 3-party relay wall time (the spike README already measured
~4 one-way hops for the relay — that is the tax on _every_ cross-machine call).

**Mitigation + cost.** Give live providers a _dialable name_ (fork C) and let the project dial the
provider **directly** after resolution, so the CP is on the resolution path but not the data path.
Cost: capnweb has no cross-connection GC, so a direct project↔Pi session needs its own DO-keyed
lifecycle + `onRpcBroken` eviction on _both_ ends; and NAT means the Pi still dials _out_, so
"direct" may still need a rendezvous the CP hosts. You don't fully escape the middle; you only move
it off the hot data path.

---

## THEORY 3 — "One DO now, KV later" is load-bearing for exactly the hot path it claims to defer

**Mechanism.** The design sells the single DO as a temporary simplification: "initially just route
everything through a durable object … later that's an optimisation" (§4), with §2a promising a **KV
projection** that "must **never** try to serve live data." But read §2a's own fine print: KV can
resolve **static mounts** statelessly, but **live mounts** (Pi/BYO over a socket) "→ KV resolves to
a **holder DO** that terminates the (ideally hibernatable) connection." And the 3-party relay
(theory 2) _must_ live in a stateful DO because capnweb has no cross-connection GC. So the KV
optimization removes the DO from the **cold, static** path only. For the **live/streaming** path —
the Pi every-1-2s stream, BYO sockets, the whole motivation for the redesign (§2d: escape DO
pinning) — the resolver-DO and relay-DO **stay pinned on the hot path**. The deferral is not "we'll
optimize later"; it's "the load-bearing case is unaddressed."

**Trigger.** Shipping the Pi/streams-as-capabilities feature (fork 2/2c/2d) on top of the one-DO
model. The single DO now terminates N live connections AND relays AND resolves — the pin the whole
jam set out to escape (§2d: "Backed by a Cloudflare DO it would **pin forever**") is reintroduced
_at the resolver_.

**Evidence.** §2a bullet: "'Stateless first port of call' holds for _resolution_, not for _serving a
live connection_." §2c: "The connection **pins unless it's a hibernatable WebSocket** — which the
current live-cap path is **not**." §0: streams fed every 1–2s "**never hibernate**." Memory
`incident_do_duration_worker_split_subscriptions`. The KV projection isn't even built yet (§2a
correction: "adding it is the right next move but it isn't there yet").

**Severity + scale.** High and strategic. This is the assumption the whole "defer it" plan rests on.
If the single DO is load-bearing for live capabilities, then "one DO now" isn't a stepping stone —
it's the architecture, and it has theory-1 throughput and theory-2 liveness baked in. **Verdict:
NOT a safe deferral.** Safe to defer for static-mount resolution; unsafe for the live/Pi/streams
capabilities that justify the redesign.

**Cheap experiment.** Add a `/test/live` route to `gateway.mjs` where `HostDO` retains K live
provider stubs (simulate K Pis) and a background `setInterval`-style push; measure (a) whether the
DO ever hibernates while any provider is connected, and (b) resident duration cost. Prove the pin is
in the resolver DO, not just the stream DO. Then show KV can't help: resolution → still lands on the
holder DO.

**Mitigation + cost.** Separate the three roles the DO currently fuses: (1) source-of-truth
(D1/DO, cold), (2) resolution (KV projection, stateless), (3) live-connection termination
(hibernatable-WS holder DO, per-connection, sharded). Cost: three subsystems + a real KV-convergence
story (~30s staleness, theory 11) instead of one object. Substantial — and it should be designed
_now_, because retrofitting sharding + KV under a live-connection workload is the hardest possible
time to do it.

---

## THEORY 4 — Cold-start chains multiply tail latency and cross-region RTT

**Mechanism.** A deep miss traverses project DO → control-plane DO → iterate host, each a separate
isolate, each **location-pinned at first `get()`** and possibly in a different colo. A resolve that
falls all the way through pays the **serial sum** of: each hop's cold-start (if that DO was evicted)

- each cross-region RTT. `capability-host.mjs:71` `return this.#parent.resolve(name)` is a blocking
  outbound call per layer; nothing is parallel.

**Trigger.** Cold/evicted DOs (after a deploy, or low-traffic projects that evict between requests)

- layers pinned to different regions (project first-touched in EU, CP in US-East). First request
  after any idle period pays the full chain.

**Evidence.** CF: "Durable Objects … will often add response latency as requests must be forwarded
to the data center where the Durable Object … is located"; location pinned at first `get()`, never
moves. The design's own §4 admits inner↔outer can be capnweb (WebSocket) for self-host — a WS
handshake per cold hop. capnweb pipelining (spike README) collapses _round trips within one
expression_, but it does **not** collapse _sequential DO hops each doing their own resolve_ — each
`this.#parent.resolve(name)` is a fresh awaited call.

**Severity + scale.** Medium-high on p99, especially for low-traffic tenants and post-deploy. Every
layer added to the fallthrough chain is a latency multiplier on misses. The design encourages
_more_ layers (kernel defaults → CP → iterate → config), so the tail grows with the model's
ambition.

**Cheap experiment.** Use `inproc.mjs`'s `HOP=<ms>` to give each hop realistic RTT and measure
`runDemo` wall time as you add parent layers (project→CP→iterate is already 3). Then, in
`run-workerd.mjs`, force DO eviction (dispose + recreate Miniflare, or idle) between two `/test/
native` calls and measure the cold-hop delta. Chain depth × (cold-start + RTT) should be visibly
super-linear vs a flat local resolve.

**Mitigation + cost.** Fork B's "pull CP mounts into the local fold **once at birth**" so
steady-state resolves are local — but that trades latency for staleness (theory 11) and a
thundering-herd birth-pull (theory 7). Or cache resolutions in KV (theory 3). Cost: cache invalidation
across shadowing, and the birth-pull herd.

---

## THEORY 5 — The 6-connection ceiling is a hard global cap on the relay/resolver DO

**Mechanism.** A worker/DO invocation may have only **6 simultaneous outgoing connections** waiting
for response headers (hard CF limit, shared across fetch/service-bindings/sockets). The single
capability-host DO is _the_ relay hub (theory 2) and resolver — it holds outbound legs to the parent,
to each live provider (Pi, BYO), to egress targets. Concurrency beyond 6 outbound serializes; the
7th blocks. For a 3-party relay the middle holds _two_ connections per in-flight relayed call, so
the effective concurrency is ~3 relayed calls before the DO stalls on connections.

**Trigger.** More than ~6 concurrent fallthrough/relay operations in the one DO — trivially reached
with a handful of active projects each with a live provider.

**Evidence.** CF: "Each Worker invocation can have up to six connections simultaneously waiting for
response headers … Workers triggered via Service bindings share the same connection limit." This
compounds theory 1: single-threaded _and_ 6-connection-capped.

**Severity + scale.** Medium-high. A silent throughput cliff that looks like latency, not error.
Combined with the 1,000 req/s cap, the single DO's real usable concurrency for _fallthrough_ work is
tiny relative to a whole platform's traffic.

**Cheap experiment.** In `gateway.mjs` `HostDO`, issue 12 concurrent `env.SELF.fetch(...)` egress
calls from one DO turn and observe the 7th+ block until a prior completes (timestamp each). Ground
it against the same DO handling `/test/native`.

**Mitigation + cost.** Don't relay through one DO; shard + direct-dial (theory 2 mitigation). Cost as
above.

---

## THEORY 6 — Version/deploy skew across a shadowable graph with no contract negotiation

**Mechanism.** The shadowable capability graph spans **control-plane deploy**, **project config
worker** (user code, Worker Loader), and **edge devices** (Pi/BYO) on fully independent release
cadences. capnweb/Workers-RPC dispatch is **structural by method name** — there is no version
handshake. Full shadowing (§4, "any shell may shadow any capability a prior shell provided") means a
newer layer can replace a capability the layer below still calls with the **old** signature. A Pi
running months-old firmware provides `subscribe(sink)`; the cloud upgraded to `subscribe(sink,
opts)` → the extra arg is silently dropped or the call vacuously rejects.

**Trigger.** Any independent deploy: CP ships a new egress signature; projects pinned to old config
workers; a Pi that hasn't been reflashed. The stream contract even has explicit **tiers** (§2c:
minimal vs full) — a processor needing `getReducedState()` catch-up hits a minimal Pi provider and
**breaks**, and nothing in the resolve path detects tier mismatch.

**Evidence.** §2c "The contract has TIERS (the core fork) … processors that need catch-up **break**
on a minimal provider." §6 fork B "CP-shadows-config ordering means a provided-cap _miss_ costs a
round-trip before hitting config defaults." Memory `incident_capnweb_error_name_drop` (capnweb 0.8.0
dropped `error.name`) shows cross-version capnweb behavior already bites here.

**Severity + scale.** Medium-high, and _insidious_ because it's silent and version-dependent — a
capability that works in test (all-latest) fails in the field (Pi on old firmware). Blast radius =
whichever capability skewed, per affected provider.

**Cheap experiment.** Add a `graph.mjs` variant where the Pi provider omits a method the consumer
calls (e.g. `getReducedState`), run `runDemo` and observe the failure mode — does it throw loudly,
or vacuously reject (theory 9)? Then bump a method's arity on one side only and confirm silent
arg-drop.

**Mitigation + cost.** A declared capability **contract version** per mount + a negotiation/reject on
mismatch (tier advertisement in the mount record). Cost: reintroduces the "shape" the provision
model was proud to erase (§1: "kernel carries **zero** product shape") — you need at least a version
tag and a tier enum on every mount.

---

## THEORY 7 — Thundering herd on the single DO after every control-plane deploy

**Mechanism.** A CP deploy evicts all isolates. Every project's fallthrough capnweb session to the
CP dies with the old incarnation (capnweb sessions don't survive redeploy). Fork B's "pull CP mounts
into the local fold **once at birth**" means every project, on its next request, re-pulls its mounts
from the **single** capability-host DO **simultaneously** — a synchronized stampede at the 1,000
req/s single-threaded object (theory 1), plus a capnweb reconnect storm.

**Trigger.** Every CP deploy (the design's own §1 "falls-out action" strips CP console pages → the
CP will deploy often), plus any mass eviction.

**Evidence.** Theory-1 limits + fork B birth-pull (§6). Memory `os_dev_server_branch_switch_fragility`
and preview drift incidents show mass-reconnect pain is already real. `.overloaded` errors "should
not be retried" — but a naive client _will_ retry, worsening it (CF's explicit warning).

**Severity + scale.** High at deploy boundaries — self-inflicted, recurring, correlated across all
tenants. The worst possible correlation: everyone reconnects at once to the one object.

**Cheap experiment.** In `run-workerd.mjs`, restart the peer/gateway worker and immediately fire N
concurrent `/test/capnweb` + `/test/native`; measure error rate and time-to-recover vs a staggered
baseline. Model birth-pull as N concurrent resolves at t=0.

**Mitigation + cost.** Jittered reconnect + birth-pull backoff; serve resolution from KV (not the DO)
so the herd hits a stateless, horizontally-scaled read (theory 3). Cost: the KV projection must
actually exist (it doesn't yet) and adds ~30s staleness.

---

## THEORY 8 — You cannot trace a call that fell through 3 isolates over 2 transports

**Mechanism.** A pipelined `project.iterate.flavor.flavorPrompt()` is evaluated **server-side in one
shot**; the intermediate fallthrough hops (`resolve` → parent `resolve` → mounted host) happen
_inside_ one expression evaluation and one DO `fetch`. Workers Trace Events log per-worker-
invocation — so the whole traversal collapses to ONE trace entry on the DO with **no record of which
capability path was walked** or which layer served/threw. capnweb's `onCall` hook is **per session**,
so a 3-party relay produces disjoint `onCall` logs on three different isolates with **no shared
correlation id** threaded across the relay.

**Trigger.** Any production incident requiring "why did project X's egress call fail?" The error
`[control-plane] no capability "egress" and no parent to fall through to` (`capability-host.mjs:72`)
tells you the terminal host and the name — but **not** the full chain attempted, not the transport,
not the tenant, not a request id.

**Evidence.** `capability-host.mjs:72` error string is host+name only. capnweb `onCall` is
session-scoped (per the capnweb README / spike). CF Trace Events are per-invocation. There is no
correlation-id plumbing anywhere in the spike.

**Severity + scale.** Medium on availability but **high on MTTR** — every cross-layer incident
becomes archaeology across three logging surfaces with no join key. Given theory 1/2/7 will produce
those incidents, poor observability multiplies their cost.

**Cheap experiment.** Instrument `capability-host.mjs resolve()` to log `{host, name, hit/miss}` and
run `demo-node.mjs` case B; confirm you cannot reconstruct the end-to-end path from the CP-side logs
alone (the project-side and provider-side hops are on other isolates). Add a `traceId` param and see
how invasive threading it through `resolve` → `parent.resolve` actually is.

**Mitigation + cost.** Thread a correlation id through every `resolve` and every capnweb `onCall`;
emit a span per hop. Cost: `resolve(name)` becomes `resolve(name, ctx)` everywhere, and you must
propagate ctx across the transport boundary (capnweb doesn't carry ambient context) — non-trivial,
touches the one method the whole design is built on.

---

## THEORY 9 — Vacuous rejection silently strips a project of all fallen-through capabilities

**Mechanism.** If the parent stub is broken (theory 2/7), `this.#parent.resolve(name)`
(`capability-host.mjs:71`) returns a **rejected** promise. capnweb rejections can propagate as
_vacuous_ rejects (memory `capnweb_vacuous_rejects`: "rejects can pass; wrap in closure";
`incident_capnweb_error_name_drop`). A broken-parent rejection is **indistinguishable from a genuine
"no such capability" miss** at the call site — so a project whose fallthrough link is dead doesn't
fail loudly; it silently behaves as if egress/auth/email/directory **don't exist**.

**Trigger.** Parent session broken mid-flight (deploy, eviction, network blip) while a resolve is in
flight or the birth-pull was sloppy.

**Evidence.** The design doc flags it itself: §6 fork B "vacuous-rejection can hide an unbound
project if birth-pull/eviction is sloppy." `capability-host.mjs` does zero classification of the
parent's rejection — miss and transport-death take the same path.

**Severity + scale.** High and **silent** — the worst kind. A project appears up but has quietly lost
its CP-provided capabilities (including `auth.gate`, which fork 6 makes a capability — so an auth
mechanism vanishing silently could **fail open or fail closed** unpredictably). Blast radius = every
project whose parent link broke.

**Cheap experiment.** In `demo-node.mjs` case B, tear down `cpStub` and call
`project.someUnknownCap` vs `project.egress.fetch()`; show both surface the same rejection shape —
you can't tell "no such cap" from "parent is dead." Then wrap in the closure trick from
`capnweb_vacuous_rejects` and show it changes the observed error.

**Mitigation + cost.** Classify transport-death vs genuine-miss in `resolve`; on parent-broken, throw
a loud, distinct, non-cacheable error and trip a circuit breaker rather than returning a miss. Cost:
`resolve` must inspect capnweb error taxonomy (which drops `error.name` across versions — brittle)
and hold breaker state (more DO state).

---

## THEORY 10 — Reentrancy / cycle deadlock on the single-threaded DO

**Mechanism.** Fallthrough makes cycles easy to form by accident. Project shadows `egress`; its
egress impl falls through to the CP; the CP's handler calls **back** into the project (auth.gate
back-call is the _already-shipped_ instance of exactly this — §1: "the project calls `itx.auth.gate`
back to the CP"). If both the project host and CP host live in the **same single-threaded DO** (the
"one DO" model), the DO is busy awaiting the outbound leg and **cannot service the reentrant inbound
call** → stall until timeout, or deadlock.

**Trigger.** Any capability whose implementation re-enters a host already on the call stack —
made likely by the onion model (§1: "outer calls inner on the way in; inner calls outer via a
provided capability") and full shadowing.

**Evidence.** DO single-threaded (CF). The streams subsystem already engineers **hard** to avoid
this: README "a pulled result would make that nested append part of a **cyclic actor-drain tree**,"
and disposes results unpulled precisely to break the cycle. The fallthrough design has no such
guard — `resolve` → `parent.resolve` → … → back to self is unguarded recursion across a
single-threaded boundary.

**Severity + scale.** Medium-high; hard to reproduce, catastrophic when hit (a wedged DO takes its
whole shard with it, theory 1). Cycles that are fine across _separate_ isolates deadlock once you
"simplify" to one DO.

**Cheap experiment.** Build a `graph.mjs` where the CP's egress calls back a project-provided
capability, and host both in one `HostDO` (share the singleton). Issue the call and watch it stall.
Contrast with hosting them in two DOs (no deadlock) — proving the "one DO" simplification _introduces_
the deadlock.

**Mitigation + cost.** Cycle detection (path set in the resolve ctx, reject on revisit — loops are
"structurally impossible" in streams via exactly this technique), or never co-host mutually-calling
layers in one DO. Cost: a visited-set threaded through resolve (same plumbing as theory 8), or giving
up the one-DO consolidation (theory 1).

---

## THEORY 11 — Cascading shadow invalidation / split-brain across the convergence window

**Mechanism.** Full shadowing + event-sourced mounts + fork B's birth-pull cache = readers hold
_copies_ of a capability graph that a mid-layer can shadow at any time. With "one DO now" there is no
invalidation _push_; with "KV later" (§2a) convergence is explicitly "~30s." During that window
different projects/isolates resolve the **same** capability to **different** providers — split-brain.
For an ordinary mount that's a stale route; for the **auth mechanism** (fork 6, a shadowable
capability) it's 30s of two different auth policies live at once.

**Trigger.** Any shadow/re-provide of a capability that downstream layers have already pulled/cached,
especially security-relevant ones (auth.gate, egress origin-pin).

**Evidence.** §2a "converging in ~30s"; §4 "any shell may shadow any capability a prior shell
provided" + "Shadowing security/risk = explicitly parked." Fork B birth-pull caches at birth (§6).
The design _knows_ it parked shadow risk — this is that risk cashing in.

**Severity + scale.** Medium; bounded by the convergence window but unbounded in what it can change
(auth). Blast radius = readers who cached the pre-shadow value until they converge.

**Cheap experiment.** Two `project` hosts sharing a CP parent; `project.provide("egress", …)` to
shadow on one after both pulled; show the other still resolves the old egress until it re-pulls —
quantify the window. Model KV lag as a fixed delay on `resolve`.

**Mitigation + cost.** Version/epoch on mounts + read-through revalidation for security-relevant caps
(don't cache auth); push invalidation for shadows. Cost: gives up the "cache the routing" cheapness
for exactly the caps that most need freshness — i.e. the KV projection can't be used naively for auth.

---

## THEORY 12 — Partial-failure / no atomicity when a provide spans a DO write + a live connection

**Mechanism.** `provide(name, cap, "live")` (`capability-host.mjs:51`) records the mount, but a live
mount's authority is a **connection** (Pi/BYO socket) whose liveness is independent of the DO write.
The DO can persist "egress → provider@conn" while the connection is already dead, or persist before
the cross-account (topology 4) provider is actually reachable. `onRpcBroken` eviction is best-effort
and, cross-account, the born-key HTTP dial has no shared transaction with the DO write. Result: a
mount that points at a corpse and **vacuously rejects forever** (theory 9) until something re-provides.

**Trigger.** Provider disconnects between the `dup()`/store and first use; cross-account provider
unreachable at provide time; DO evicts and reloads the mount record but not the (now-dead) connection.

**Evidence.** `capability-host.mjs:54` stores `cap.dup()` — a stub whose underlying connection can
die independently of the stored record. Spike README gotcha: "Stubs passed as call params are
disposed when the call returns … `provideCapability` must `.dup()` … or the provider handle dies
immediately." Cross-account has no shared transaction (deployment-topologies §4, born-key HTTP dial).

**Severity + scale.** Medium; per-mount, but the failure is durable (survives in the record) and
silent (theory 9). Cross-account/BYO is where it bites hardest — exactly the topology with the least
shared fate.

**Cheap experiment.** In `demo-node.mjs`, `provide` a live cap, dispose the provider's session, then
`resolve` + call it; confirm the stored `.dup()` yields a dead stub with no self-heal. Add a DO
eviction (recreate the host) and show the record survives but the connection doesn't.

**Mitigation + cost.** Health-check + `onRpcBroken`-driven auto-eviction of live mounts, and treat
the mount record as a _name_ (fork C) re-dialed on use rather than a captured stub. Cost: re-dial
latency per call + a rendezvous for NAT'd providers; more DO state for health.

---

## THEORY 13 — Subrequest fan-out cap under chained fallthrough

**Mechanism.** Internal-service subrequests are capped at **1,000/request**. A single ingress request
that triggers a fallthrough chain (project→CP→iterate) where each hop is a service-binding/subrequest,
multiplied by any per-request fan-out (resolve several capabilities, each falling through), consumes
the budget. Deep chains + wide capability use per request approach the cap; the request fails at
subrequest 1,001 with no partial-result story.

**Trigger.** A request that touches many capabilities (an agent turn: streams + secrets + ai + email

- egress), each a fallthrough, each a subrequest, across a 3-layer chain.

**Evidence.** CF: "Subrequests to internal services" capped at 1,000 (paid). Each
`this.#parent.resolve` and each relayed leg is a subrequest. The 6-connection ceiling (theory 5)
bites first for concurrency, but the 1,000 cap bites for fan-out volume.

**Severity + scale.** Low-medium; only pathological requests hit 1,000, but the design encourages
"everything is a capability," which maximizes subrequest count per request.

**Cheap experiment.** Instrument `env.SELF.fetch` count per ingress in `gateway.mjs`; drive a
`runDemo` that resolves K capabilities through the chain and count subrequests as a function of
(chain depth × caps used).

**Mitigation + cost.** Batch resolution (resolve-many in one call), local birth-pull cache (theory 4).
Cost: caching + staleness.

---

## The 3 scariest (return value)

1. **Single `"singleton"` DO = global SPOF + single-threaded hot shard.** `gateway.mjs:51`
   hard-codes `getByName("singleton")`; DO is 1-threaded, 1,000 req/s soft cap. Every project's
   fallthrough funnels through one isolate — one slow/remote resolve HOL-blocks all tenants; its
   outage downs the whole platform. **The pin the redesign set out to escape, re-created at the resolver.**
2. **3-party relay makes the middle a hard liveness dependency it needn't be.** capnweb has no
   cross-connection GC, so project↔Pi calls are relayed through the control plane and die when the CP
   restarts/deploys/evicts — both endpoints healthy, call fails, at double latency (design §6 fork A;
   `demo-node.mjs` case B).
3. **"One DO now, KV later" is load-bearing, not a safe deferral.** KV can offload only _static_
   resolution; live mounts (Pi/BYO/streams — the whole motivation) still terminate on a stateful
   holder DO, and the relay must stay in a DO. Deferral is safe for the cold path, **unsafe for the
   live path** — so the single DO IS the architecture, with theory-1 throughput and theory-2 liveness
   baked in.
