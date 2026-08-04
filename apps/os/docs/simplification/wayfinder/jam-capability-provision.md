# Jam — capability provision as the spine (three layers · streams · everything-as-a-capability)

A **living, append-only** jam log (Jonas + Claude). We _add_ to it; we don't rewrite it. It records
decisions and context for future use. Grounded in the clean-room control-plane + project-worker (proven
31/31 — see `deployment-topologies.md`) and the `apps/os` capability system as it exists **today**.

Started 2026-08-03. Two dimensions in play:

1. A clean split between the **iterate product**, the **control plane**, and the **project** — modelled as
   capability provision, not configuration.
2. Capabilities can live **anywhere** (Cloudflare DO, your CF account, a Raspberry Pi). The project becomes
   "mostly a networking and messaging layer." Streams-in-DOs become one capability implementation among many.

---

## ▶ Bookmark — where we are (2026-08-03)

**Locked:** §1 (three layers = mutual capability provision; the iterate product _provides_ to the control
plane — revises ADR 0030). By 3-proposal consensus (§6): **fork 6** (auth = a control-plane concern; the
mechanism is a shadowable capability), **fork 3** (streams = constructive built-in router), **fork 8** (store
only overrides). Entrypoint shape settled: one `WorkerEntrypoint`, `fetch` = capnweb door / `get()` =
loopback, **one `RpcTarget` graph across both transports** (capnweb's `RpcTarget` _is_ the `cloudflare:workers`
one).

**✅ Fork 9 RESOLVED + proven in production (§8):** provision = **one `fallthrough` to the parent stored as a
NAME, re-dialed per call (never a retained stub), resolved downward-only, with live mounts woken on demand via
a hibernatable wake socket.** Proven across 4 spikes incl. **1000 devices on one hibernating DO** (~99.5%
hibernation, billing-confirmed). Recommended architecture written up in §8.

**Open:** **fork 2** (does the HA stream need offline replay — a product call), and the **innermost-core
layering** (§9 — what is the irreducible primitive; where stream / context / ITX / project-DO sit).

**✅ Resolved by the SIDE-QUEST (see `spikes/capnweb-pipelining/`):** §6's "physics ceiling" was **wrong for
the capnweb path** (Jonas was right). Measured, self-verifying: a capability host with **one
`invokeCapability` fallback** lets a consumer pipeline `itx.streams.get("/x").helloWorld()` in **one** round
trip B→hub **and** one hub→provider; a **`Proxy`** resolver pipelines fine; and a `Proxy` with `RpcTarget` on
its prototype chain is passed by reference. The `workerd#6873` brand check is a **native-Workers-RPC** concern
only — the safe cross-transport rule is \*return a real `RpcTarget` instance across a native boundary and put
the resolver `Proxy` on its **prototype\*** (what `installPrototypeInvokeCapabilityFallback` already does). So
"everything is a capability, resolved through one fallback" is **viable**, not ceilinged.

**✅ Native leg now confirmed (SIDE-QUEST 2 — `spikes/capability-fallthrough/`):** the whole design (uniform
host, **parent fallthrough**, iterate mounted on the CP, **egress provided down to the project**, live+static
caps, **shadowing**) runs in **real workerd** across three transports — Node→workerd capnweb, **native
Workers-RPC across a DO boundary**, and workerd→workerd capnweb over a service binding — **both in Miniflare
and DEPLOYED on the POC account** (`capnweb-spike-{gateway,peer}.iterate.workers.dev`). The prototype-proxy
rule holds across the native boundary exactly as predicted.

**⚑ Red-team DONE — verdict (6 agents; `spikes/capability-fallthrough/redteam-SYNTHESIS.md`):** the
**model is sound and every core proof stands** — nothing invalidates pipelining/duality/native-boundary. What
breaks is the spike's naive _hosting/scale/trust posture_, via three "for now" shortcuts: (1) resolve-on-every-
access **holds intermediate stubs → measured hot-path import/export LEAK** (capnweb has no distributed GC);
(2) **one singleton capability-host DO** = SPOF + single-threaded hot shard that _re-creates the DO-pinning we
set out to escape_; (3) **capnweb-session-in-a-DO can't hibernate** (`accept()`, no `acceptWebSocket`) → a DO
holding live sockets is billed **24/7**, inverting §2d's "billed on routing". Plus: **no authority model**
(`resolve`/`provide`/`setParent` are unauthenticated wire methods; untrusted bottom layer resolves every
ancestor cap by name; `egress` is re-delegable secret-bearing authority). **The mandatory pre-commit
guardrails are mostly the fork-9 / §2a leans already written down** — store parent+statics as _names_ pulled
at birth (not stubs) + cache resolution (fixes the leak _and_ B3), per-tenant host isolation, downward-only
per-caller-scoped resolution with mutators off the tenant surface, epoch-keyed eviction, idempotent mutations
— the red-team just proved they're **mandatory, not optional**, and showed exactly where the naive version
dies. **The biggest genuinely-new fork:** live always-connected providers (Pi/browser/BYO) probably need a
**raw hibernatable-WS holder + a thin protocol, NOT a pinned capnweb session** (capnweb for control/RPC only)
— **which is exactly what PR #2386 already built for streams** (a `ctx.acceptWebSocket` wake socket + an
idle-torn-down RPC leg; `apps/os/src/domains/streams/wake-socket.ts`). Generalize that into the capability
host's live-mount primitive.
Two spike bugs the agents reproduced were **fixed** (phantom `Symbol.dispose` crash on disconnect; `setParent`
missing `.dup()`); regression stays green.

---

## 0. The `apps/os` capability system today (grounding — don't re-derive)

- **One tree, one class.** `itx` is `ProjectRpcTarget` (`apps/os/src/rpc-targets.ts:5238`, built by
  `itxForScope` at `:5989`). Branches are getters vending concrete `RpcTarget`s: `streams`, `secrets`, `ai`,
  `email`, `egress`, `integrations`, `agents`, `workers`, `sandboxes`, `files`, `kv`, `devices`, `mcp`,
  `openapi`, `auth`, `liveState`, `capabilityHost`.
- **Two doors, same tree.** External `/api` = capnweb over WS/HTTP-batch
  (`UnauthenticatedOsRpcTarget.authenticate` → `SessionRpcTarget` → `ProjectCollectionRpcTarget` →
  `ProjectRpcTarget`). In-worker callers (dynamic/config workers) get the same tree over a loopback via
  `ItxEntrypoint` / `env.ITX` (`domains/itx/itx-entrypoint.ts`).
- **The mount fallthrough (the important part).** Built-in branches run in-isolate. Any _unknown_ member
  falls through a prototype Proxy (`installPrototypeInvokeCapabilityFallback`, `domains/itx/utils.ts`) into
  `capabilityHost.invokeCapability({path,args})` → `CapabilityHostDurableObject` → longest-prefix **mount**,
  which resolves to either a **live capability** (a bare value provided by a _connected_ party — browser,
  CLI, device, another worker — calls travel back over that connection and die with it;
  `domains/capability-host/live-capability.ts`, `retainLiveCapabilityProvider`) or an **itx-expression**
  (a recorded capnweb expression replayed on the tree). `ProvideCapabilityInput` type is `"live"` |
  `"itx-expression"` (`domains/capability-host/types.ts`). **The mount table itself is a stream fold**
  (`CapabilityHostProcessor`).
- **Streams today are the opposite of pluggable.** `StreamDurableObject` (`domains/streams/…`), one DO per
  `(project, path)`, authoritative log in DO SQLite (`stream-storage.ts`, 512 KB event chunks, no R2
  offload). A stream fed every 1–2s **never hibernates** (continuous RPC keeps it resident; **no
  hibernatable WebSockets anywhere in the stream path**). Locality rule: streams can't watch each other;
  the only cross-stream move is `cross-post` (real copies). **No notion of a stream whose log lives
  off-Cloudflare.**
- **Product split today.** `apps/auth` = OAuth provider + org/project directory; `apps/os` = a
  relying-party _client_ with no DB. Ingress = one pure function (`decideIngressRoute`, `apps/os/src/
ingress.ts`). Webhooks route by _payload external-id claim_, not by host. Email is a capability
  (`itx.email`). `remoteCapability` was **removed** (#2156, ADR 0014/D13); "remote apps" today = HTTP
  reverse-proxy + two `/api` credential lanes (`project-secret` born key, `project-app-session`).

Prior jam artifacts this builds on: `control-plane-and-product.md`, `topologies-and-axes.md`, and
`DECISIONS.md` ADRs 0009, 0013, 0014, 0017, 0018, 0021, 0022, 0025, 0030, 0031, 0033, 0034.

---

## 1. LOCKED (2026-08-03) — the three layers are MUTUAL capability provision, not config

**This revises the lean in ADR 0030 + `control-plane-and-product.md` §1**, which framed the iterate product
as _config the generic control plane consumes_ ("self-host = the same worker with the product bag empty").
Jonas: _"The difference … is just configuration. I don't think that's so good … a control plane is a
capability provider to a project, and an iterate project is a capability provider to the control plane … I
want that done as an outer layer, not a config-parameterized control plane."_

**New model:** the **iterate product is a capability _provider_ to the control plane** — a first-party
project that _provides_ lifecycle/flavor capabilities the CP invokes (e.g. "on project created, add this
prompting to make it iterate-flavoured"). Self-host = don't mount it (or mount your own).

**Why it beats the config bag:** config still makes the kernel carry the _shape_ of every product concern
(`platformSecrets`/`integrations`/`billing` slots) even when empty. Provision makes the kernel carry **zero
product shape** — it just calls hooks that may or may not be bound. That is "outer layer, not
config-parameterized."

**One mechanism, two axes** (this is the "fetch-middleware onion": outer calls inner on the way in; inner
calls outer via a provided capability):

```
CONTROL / LIFECYCLE axis                DATA / REQUEST axis
(rare — directory mutations)            (hot — every ingress request)

 ITERATE PROJECT   (outer)               CONTROL PLANE   (outer)
   provides ↓ hooks to the CP:            authenticates + routes,
   onProjectCreated, flavorPrompt, …      dials ↓ the project
 CONTROL PLANE     (inner)               PROJECT         (inner)
   invokes those hooks on create/emerge   consumes ↑ CP caps via itx.*:
                                          auth.gate, egress, email, directory
```

- We **already have one instance** of the data-axis pattern: the CP dials the project on ingress, and the
  project calls `itx.auth.gate` back to the CP. Generalize it.
- The iterate project is _simultaneously_ a **tenant** (consumes CP `/api` like anyone) and a
  **flavor-provider** (provides hooks up to the CP). This dual nature is the whole trick — and why "the
  interface could be one and the same" felt right.
- Preserves: MCP as a CP concern (0022), reserved CP host (0031), the two web apps (0030 §3 — console = the
  CP's face, now part of the iterate project; dashboard = a `project-app-session` remote app).

**Falls-out action (not yet done):** strip the clean-room CP of its console pages (`/`, `/projects`) and
move them into a first-party project; the CP keeps only names/auth/routing/egress + the sockets for the
lifecycle hooks.

---

## 2. OPEN — everything as a provided capability, stateless-first

Status: **exploring** (Jonas: _"i feel like maybe expressing EVERYTHING as provided capabilities could be
really good … not sure though!"_). Nothing here is locked.

**Alignment with a locked decision:** uniform provided-capabilities is _how you kill the `rpc-targets.ts`
god-object_ (ADR 0018) — self-contained mounted pieces instead of getters on a 7,667-LOC mega-class.

### 2a. The runtime pattern to be great at — cache the _routing_, not the _data_

Jonas: _"a small KV lookup table populated from a durable-object source of truth, read from a stateless
worker. If the stateless worker gets confusing outcomes, it goes to the DO (a more expensive call), which
refreshes the KV, and ~30s later every reader in the stateless isolates can read the KV."_

- **Principle:** a **KV projection of a D1/DO source of truth** answers _"which provider serves this?"_
  cheaply + stateless, converging in ~30s. It must **never** try to serve live data.
- **Reconciles two of our own conflicting ADRs:** 0025 ("routing table is KV") vs 0033 ("directory is D1").
  Resolution: **source of truth = D1/DO; read path = KV projection.**
- **Correction to the current state:** the clean room does **not** yet have this KV read-cache — the CP
  reads routes _straight from D1_ (`directory.resolveRoute` → sqlfu). The KV projection is the `apps/os`
  `PROJECT_DIRECTORY` pattern; **adding it is the right next move but it isn't there yet.**
- **Two resolution speeds** (answers "can a stateless worker be the first port of call?"):
  - **Static mounts** (durable stream at DO path X, reverse-proxy origin, itx-expression) → resolved _and_
    served stateless from KV. Yes.
  - **Live mounts** (Pi / BYO over a socket) → KV resolves to a **holder DO** that terminates the (ideally
    hibernatable) connection. "Stateless first port of call" holds for _resolution_, not for _serving a
    live connection_.
- "Everything through one DO is easier" is true for consistency but is the exact **pin** we're escaping;
  the KV projection is how you keep one source of truth _without_ every read hitting it.

### 2b. "Stream context determines the capability tree"

Already half-true: the capability host **is** a stream fold; mounts are events; the live mount table is the
fold. Elevating that to _the_ organizing principle is coherent. **Boundary:** a KV-cached fold is fine for
**mounts** (rarely change), never for a **live tail** (changes every 2s).

### 2c. Streams as provided capabilities — proposal + the hairy parts

**Proposal:** keep `itx.streams` as a built-in **namespace/router**; make per-path resolution
**pluggable**. Default provider = today's `StreamDurableObject`; a path/subtree can be **overridden** to a
mounted provider (Pi, BYO). Mirrors ingress exactly (routes table + default convention). `itx.streams
["/foo"]` is then `get("/foo")` with a swappable backend — you keep the collection, you make its leaves
pluggable.

The **append/subscribe API is the contract** competing providers satisfy — `append(event)`,
`subscribe(sink)`, `getEvents(range)`, `getReducedState()`. Hairy parts:

- **The contract has TIERS (the core fork).** _Minimal_ (append + live subscribe, no history) vs _full_
  (durable log + range reads + reduced-state catch-up + obligation replay + cross-post). A Pi likely offers
  only minimal; processors that need catch-up **break** on a minimal provider. This is the
  **durable-vs-edge-stream** decision.
- **Push vs pull.** Streams _push_ (fan-out); live capabilities _pull_ (`invokeCapability`). "Stream as a
  live capability" is a hybrid — consumer registers a sink, provider pushes batches over the connection. A
  new shape on `retainLiveCapabilityProvider`.
- **The connection pins unless it's a hibernatable WebSocket** — which the current live-cap path is _not_
  (it uses pinning capnweb sessions). Fork: pinning session vs hibernatable-WS edge provider.

### 2d. The Home-Assistant / Pi case, and an ADR tension it resolves

The Pi emits an event stream every 1–2s. Backed by a Cloudflare DO it would **pin forever** (§0). The move:
the Pi **hosts the log**; the cloud holds a **thin connection + a tiny mount registry**; billed on message
routing, storage ≈ 0.

- **Unification:** _remote-app_, _BYO-Cloudflare-account_, and _Pi-hosted_ are the **same mechanism** — a
  capability provider at a different location + trust level that **dials in** and the project **routes to**.
  Location is a property of the _provider_, not of the capability's identity. (The cross-account
  project-worker dial we already proved is the BYO case.)
- **Resolves the 0017 ↔ 0013 tension:** 0017 says "no NAT dial-out; the runner is reached via
  loopback/HTTP"; 0013 (home-assistant mode) says "the runner dials out." Resolution: **the _runner_
  doesn't dial out (0017 stands); a _capability provider_ does** (0009's persistent bidirectional capnweb
  session). The Pi isn't running the project — it provides _one capability_ to a cloud-hosted project.

---

## 4. The nested shells + the entrypoint — transport-duality (2026-08-03, cont.)

**The shells, navigated by `authenticate()` — and they already exist in `apps/os`.** Connect from outside
to `/api` over a WebSocket and call `authenticate()`; what comes back is a _nested_ set of RPC targets, each
a "shell":

```
authenticate()               → MIDDLE shell (control plane): can only manage projects
  .projects.get(projectId)   → INNER shell (project): the itx capability tree
```

This is _not new_ — it's the existing chain: `UnauthenticatedOsRpcTarget.authenticate()` →
`SessionRpcTarget` (list/create/get projects) → `.projects.get()` → `ProjectRpcTarget` (itx). We're
formalizing it as **shells you navigate by RPC**, and asking whether there's an **outer** shell above
`authenticate` (the iterate product), e.g. the iterate layer as a _pluggable authentication mechanism_.
**Lean (open):** `authenticate` lives at the **control-plane** shell; the auth _mechanism_ behind it
(iterate OAuth / Cloudflare Access / Clerk / wide-open — today's `LOGIN_MODE`) is itself a **provided,
shadowable capability**. So "the iterate layer provides an auth mechanism" and "authenticate is a
control-plane concern" are _both_ true — the mechanism is a capability the deployment (iterate, or a
self-hoster) provides to the CP.

**The recursion (the interesting bit):** _"what if the project worker itself is just composed of provided
capabilities that in turn come from the outer shells again?"_ The inner shell's capabilities are **provided
by** the outer shells (kernel defaults → control plane → iterate product), each able to shadow the last.

**How inner shells talk to outer shells — the crux for topology:**

- **Full iterate deployment:** everything is **Workers RPC bindings** (same account; `env.ITX.get()`-style
  loopback + service bindings). Cheap.
- **Extreme self-host:** the project runs on a **separate server with NO RPC bindings**, and a stream lives
  on a **Raspberry Pi**. Then inner↔outer runs over **capnweb** (WebSocket) instead. _Same interface, two
  transports._

**⇒ Entrypoint design goal (the thing to get right):** a `WorkerEntrypoint` with **one `fetch`** that hands
to a **single capnweb `RpcTarget`**, where that _same_ target is **also reachable via Workers RPC**
(the `env.ITX.get()` shape). One implementation, two transports — capnweb for cross-account/cross-machine,
Workers RPC for same-account. Known constraint: **`fetch` is a reserved method name over Workers RPC**, so
the duality must route around it. This is what the three research agents are designing (see below).

**Capabilities as data / events; born from config, stacked, shadowed.** A project worker is **born with
default capabilities from config** (the deployed worker's `APP_CONFIG`), then makes an **authenticated call
out to the control plane** and gets **more capabilities stacked on top** — each layer possibly _shadowing_
a prior layer. Provision is **event-sourced data** ("capability provided by events") — which is exactly what
`CapabilityHostProcessor` already is (mounts are events; the table is the fold).

**Full shadowing, on purpose — defer the risk.** Jonas: _"allow shadowing completely the whole time… don't
worry about risks of shadowing so soon. Anything anywhere on this multi-layered shell model can shadow the
things provided prior."_ **Locked-for-now:** any shell may shadow any capability a prior shell provided.
Shadowing security/risk = explicitly parked.

**One DO now; stateless/KV later (refines §2a).** Jonas: _"initially just route everything through a durable
object and don't worry about the whole stateless-worker/KV thing — later that's an optimisation."_ Near-term:
a **capability-host DO** is the single source of truth _and_ the resolver; the KV projection in §2a is a
**later** optimization, not the starting point.

**The fallthrough chain.** Each **capability host knows which host it falls through to.** A miss falls
outward — inner → control plane → … → and if nothing else, to the **config defaults baked into the deployed
worker.** The terminal of the chain is "what the worker shipped with."

**Kernel = the _defines_ (the API); impls pluggable.** The kernel is the **interface definitions** — what a
stream is, what a repo is (`append`/`subscribe`/…). A **reference implementation** does a stream as a
**Cloudflare Durable Object**; the _same_ interface could run in **Miniflare on a Raspberry Pi**. Even a
**repo** is "just a provider." _Why bother:_ it lets iterate ship **different particularised products** on
the same platform later.

**Research in flight** — three independent, same-mission proposals for the entrypoint / transport-duality
structure (grounded in capnweb source, Workers RPC, Cloudflare Workers docs, and Kenton Varda's writing).
Nothing discarded:

- `proposals/capnweb-entrypoint-a.md`
- `proposals/capnweb-entrypoint-b.md`
- `proposals/capnweb-entrypoint-c.md`

---

## 5. North-star goal (record for now)

> The **iterate product** is just a capability layer provided to the **control plane**. The **control
> plane** is just a capability + **ingress** layer provided to a **project**. A **project** has a bunch of
> capabilities (streams, repos, …) that come from the **kernel**. The **kernel** really just has the
> _defines_ — the API / interfaces. There's a **reference implementation** that does a stream as a
> Cloudflare Durable Object, but you could also run it in **Miniflare on a Raspberry Pi**. That is the goal.

Each layer _provides capabilities to the layer below and can be provided-to (shadowed) from the layer
above_; navigation between layers is `authenticate()` / `projects.get()` (the shells, §4); provision is
event-sourced data that can shadow (§4); the interface is kernel-defined and implementation-pluggable.

---

## 6. Three proposals in — convergence, the one divergence, the physics ceiling (2026-08-03)

`proposals/capnweb-entrypoint-{a,b,c}.md` — three independent designers, same brief.

**Unanimous (treat as _found_, not proposed):**

- **The load-bearing fact:** on workerd, capnweb's `RpcTarget` **is an alias of** `cloudflare:workers`'
  `RpcTarget` (same constructor; `dist/index-workers.d.ts:371`). ⇒ ONE class serves both transports with
  **zero adapter**. Transport duality is essentially free.
- **Entrypoint shape:** one `WorkerEntrypoint`, two doors — `fetch` = capnweb (WS + HTTP-batch in one
  `newWorkersRpcResponse` call), a non-reserved method (`get()`/`enter()`) = the same-account Workers-RPC
  loopback. `fetch` being reserved is a _feature_ (unambiguously the wire, never a callable capability).
- **Shells = the existing chain.** `authenticate() → session → projects.get(id) → project` is literally
  today's `UnauthenticatedOsRpcTarget → SessionRpcTarget → ProjectCollection → ProjectRpcTarget`. In-band
  auth (Kenton: you can't forge a session, only be handed one; headers/cookies don't work over cross-origin
  WS anyway). Not new architecture — a renaming.
- **Kernel = interfaces; impls pluggable.** `CloudflareStream extends DurableObject implements Stream` and
  `PiStream/MiniStream extends RpcTarget implements Stream`. "Runs on a Pi" = two classes, one TS interface.
- **Constructive streams.** `streams.get(path)` computes a DO name (O(1), zero records); a record exists
  ONLY to shadow a path onto a non-default provider. Same shape as ingress (default convention + overrides).
- **God-object death.** Thin shell + per-capability modules registering their branch (`defineBranch` =
  relocated `installPrototypeInvokeCapabilityFallback`), not 18 getters on 7,667 LOC.
- **The Pi.** Symmetric capnweb session, Pi dials OUT (solves NAT), passes its own `localMain` so the cloud
  calls back. Confirms: the _runner_ never dials out; a _capability provider_ does.

**The one hard limit all three surfaced — this bounds "everything is a capability":** workerd's
promise-pipelining **native brand check** (`serializeJsValueWithPipeline`; `cloudflare/workerd#6873`). A JS
`Proxy` can never pass it, so anything that must be **pipelined** (`x.get(p).append(e)` in one round trip)
must be a **real branded `RpcTarget`** returned _before_ any proxy hop. ⇒ You cannot make literally
everything a lazy mount: the hot, pipelined built-ins (streams/repos/secrets) stay **real getters**; only
_misses_ traverse the proxy hop (which itself ends in one pipelinable `invokeCapability`). This is already
the exact trade-off `installPrototypeInvokeCapabilityFallback` makes. **"Everything is a capability" holds
conceptually; mechanically the hot built-ins stay real** — so streams-stay-constructive is forced, not just
an optimization.

> **CORRECTION (side-quest spike, 2026-08-03 — `spikes/capnweb-pipelining/`):** the paragraph above is
> **wrong for the capnweb-over-WebSocket path** (the client-facing one). Measured: a **`Proxy`** dynamic
> resolver _does_ promise-pipeline over capnweb, and a single `invokeCapability` fallback yields **one** round
> trip consumer→hub and **one** hub→provider. The `workerd#6873` brand check is a **native-Workers-RPC**
> concern only (DO stubs / service bindings / `ctx.exports`). Cross-transport safe rule: **return a real
> `RpcTarget` instance across a native boundary; put the resolver `Proxy` on its _prototype_** (exactly
> `installPrototypeInvokeCapabilityFallback`). So "everything is a capability, resolved through one fallback"
> is **viable** — hot built-ins staying constructive is a _performance/clarity_ choice (avoid a needless hub
> hop), not a hard requirement. This meaningfully softens **fork 9** and the streams design. Native leg still
> to confirm under `workerd`.

**The one real divergence — how _provision_ is represented (new fork 9):**

- **A — an explicit `Resolver` linked list.** Each shell owns `HostResolver{shadows, next}`; `next` may be a
  remote stub. `resolve()` is **synchronous** (in-memory pick) so a bad path throws at call time (clean
  vacuous-rejection story). Cost: a distinct concept beside the shells; the cross-transport fallthrough is a
  three-party proxy relayed through the middle shell (no cross-connection GC in capnweb).
- **B — one field: `fallthrough: RpcStub<Shell> | null`.** "CP provides to project" = the project's
  fallthrough stub points at the CP shell. Most minimal, most capnweb-native. Born-with-config, then pull CP
  mounts into the local fold once at birth so steady-state is local. Cost: "CP-shadows-config" ordering
  means a provided-cap _miss_ costs a round-trip before hitting config defaults; vacuous-rejection can hide
  an unbound project if birth-pull/eviction is sloppy.
- **C — the fallback is a dialable NAME, resolved fresh each read** ("a durable name, never captured
  authority"), dialed over the transport its location implies. Most decoupled (survives disconnect/redeploy;
  matches how `capabilityFallbackForScope` already records a name). Everything is one `resolve(path)`;
  commits hardest to "the iterate product is a _mount_, not a shell."

**Now lockable by 3/3 consensus:** **fork 6** (no outer iterate shell; `authenticate` is a control-plane
concern; the auth _mechanism_ is itself a shadowable capability), **fork 3** (streams = constructive
built-in router — even radical C keeps `streams` a real getter because of the brand check), **fork 8**
(constructive default, store only overrides).

**Still open — a product-semantics question no mechanism answers:** **fork 2** — does the HA stream need
replay when the Pi is offline? All three give the _mechanism_ for a stream-provider-anywhere; B even encodes
the **tiers** (`StreamProvider` minimal / `DurableStreamProvider` full). Whether the cloud keeps a durable
copy (full tier) or it's edge-only-while-connected (minimal tier) is a product call.

**Lean on fork 9:** B's single `fallthrough` as the shape, but store the fallback as a **name** (C) not a
long-lived stub, and keep the local _pick_ **synchronous** (A). Minimal concept count (B), no captured/stale
cross-shell authority — which matters because capnweb has **no cross-connection GC**, so the durable link
must be a record/name and the live stub must live only in the one DO keyed by connection with `onRpcBroken`
eviction.

---

## 7. Forks &amp; problems awaiting a call

1. **Dimension 1 — is the dashboard its own worker?** (deploy cadence / blast radius) or just a first-party
   project on the project-worker tier? Model says "a project"; a separate worker is an ops choice on top.
2. **HA stream — offline replay needed?** If yes → the log must live cloud-side or be checkpointed
   (hot-on-Pi + downsampled rollup in a small DO). If no → edge-only, exists while connected. Drives the
   durable-vs-edge tier.
3. **`itx.streams` — built-in router with pluggable leaves (2c proposal) vs the whole `streams` node is a
   mount?** Leaning: built-in router.
4. **The stream contract's tiers** — define minimal vs full explicitly, and which processors require which.
5. **Transport for edge providers** — pinning capnweb session (simple, pins) vs hibernatable WS (sleeps,
   new work). Telemetry wants the latter.
6. **Is `authenticate` the outermost (iterate) shell or the control plane?** (§4) Lean: control-plane
   shell, with the auth _mechanism_ itself a provided/shadowable capability. Confirm.
7. **The entrypoint transport-duality structure** (§4) — one `RpcTarget` reachable via _both_ Workers RPC
   and capnweb from one `WorkerEntrypoint`, routing around `fetch` being reserved. **3 proposals in flight**
   (`proposals/capnweb-entrypoint-{a,b,c}.md`).
8. **Linear growth of capabilities if every stream is a mount** (Jonas, "not sure if worth solving"). Today
   `itx.streams.get("/path")` is **constructive** — it computes a DO name from the path (O(1), _zero_
   records). If every stream became a registered mount, the registry grows linearly with paths ever used.
   **Candidate:** keep the _default_ constructive (path → default provider, computed, no record); store a
   mount record **only when a path is shadowed** to a non-default provider (the Pi). The fallthrough's
   terminal default is computed, so unshadowed streams cost nothing — only overrides are stored.

**Resolved by the 3-proposal consensus (2026-08-03, see §6):** forks **3** (streams = constructive built-in
router), **6** (no outer iterate shell; auth mechanism is a shadowable capability), **8** (store only
overrides). **New fork 9 — how provision is represented:** A resolver-list · B fallthrough-stub · C
dialable-name; lean = B-shape + C-name + A-synchronous-pick (§6). **Fork 2** (offline replay) stays a
_product_ decision, unanswered by the mechanism.

---

## 8. RECOMMENDED ARCHITECTURE — the hardened wake-based capability host (fork 9 resolved, proven)

Fork 9 is resolved by four deployed spikes (`spikes/capnweb-pipelining`, `capability-fallthrough`,
`capability-wake`, `capability-fused`) + Cloudflare billing analytics. This is the committable shape.

**The capability host ("context") — one primitive, per tenant:**

1. **Transport-dual RpcTarget.** One `WorkerEntrypoint`; `fetch` = capnweb (WS/HTTP-batch), a non-reserved
   method (`get`/`enter`) = same-account Workers-RPC loopback. `capnweb.RpcTarget === cloudflare:workers`'
   `RpcTarget`, so one class serves both — **zero adapter** (spike 1/2, proven native + capnweb, deployed).
2. **Resolve = one downward fallthrough:** `local live mount → local static → parent (BY NAME)`. The parent
   is **a stored name, re-dialed per call, NEVER a retained stub** — this is what removes the measured
   per-access import/export leak. Resolution is **downward-only** (a tenant cannot resolve upward into
   ancestor authority). The resolver Proxy lives on the **prototype** of a real `RpcTarget` instance, so it
   pipelines over BOTH transports and crosses native boundaries safely (spike 2).
3. **Live mounts = wake-on-call (the #2386 mechanism, generalized).** A live provider (Pi/ESP32/browser/BYO)
   holds a **hibernatable wake socket** (`ctx.acceptWebSocket`, the cheap doorbell). It dials a **capnweb RPC
   leg only when woken** by a call; the leg (a live stub = the only hibernation-blocker) is **torn down after
   idle** (via a DO **alarm**, not `setTimeout`), leaving only the doorbell. Streams wake **on append**
   (replay from log); general caps wake **on call** (forward the pending call).
4. **Mutators off the tenant surface.** `provide`/`set-parent` are a **separate facet** (auth-gated), never
   on the `/call` path — the red-team's unauth-wire-mutator finding.
5. **Constructive defaults; store only overrides.** `streams.get(path)` computes a target (O(1), zero
   records); a record exists only to shadow a path onto a non-default provider (fork 8).
6. **Per-tenant hosts + paced connects.** NOT one singleton DO. A DO holds ≤32k hibernatable sockets, but the
   _connect rate_ must be paced/sharded — an unpaced herd onto one DO sheds sockets → `clientDisconnected`
   churn (measured, then fixed by staggering).

**Proven at scale, in production (spike 4 + Cloudflare analytics):** 1000 IoT-style providers each holding a
hibernatable doorbell on **one** context DO; the DO **hibernates ~99.5% of the time** (14–22 ms billed
`activeTime`/min over a 5-min soak while holding 1000 sockets) and wakes **only** when a device is called —
never spontaneously; any single device wakes on demand while the other 999 stay dormant; **0
`clientDisconnected`, 0 exceptions** with staggered connect + graceful `close(1000)`.

**Platform lessons banked** (`spikes/capability-fused/README.md`): pace connects; close with code 1000
(`web_socket_auto_reply_to_close`, default ≥2026-04-07); **never `ctx.abort()` to keep clients** — it CLOSES
all hibernatable inbound sockets (`1006`, not re-attached), unlike natural hibernation which preserves + re-
attaches them; a mass disconnect reads as N errors in DO analytics (benign — page on
`scriptThrewException`/`exceededCpu|Memory`, not `clientDisconnected`).

**Still to port before it's production-grade:** #2386's `socketId` same-key-replacement + reconnect-race +
resurrection-loop guards; idempotency for mutating calls (capnweb has no resume); the auth model behind the
mutator facet; per-tenant sharding policy.

---

## 9. OPEN JAM — the innermost core (2026-08-03): stream · context/ITX · project DO

Where is the irreducible center? A proposal to reason against (not yet locked).

**Two orthogonal substrates, and everything is built from both:**

- **Storage substrate = the event log.** Append-only ordered facts + a fold. Genuinely standalone in `apps/os`
  today (the stream engine `stream-storage.ts` stands free of `Env`/itx/rpc-targets). No capabilities, no itx.
- **Capability substrate = the context.** Resolve + downward fallthrough-by-name + wake-based live mounts,
  exposed as a transport-dual `RpcTarget` (§8). This is iterate's actual invention.

**The unifying primitive — "the domain object":** an **addressable, hibernatable, event-sourced `RpcTarget`**
= { an event log (durable state) + a fold (a processor) + an RpcTarget interface + hibernatable wake }. This
is already literally true in `apps/os`: ~10 domain DOs (stream, capability-host, repo, secret, project,
scheduler, agent, …) are each _a hosted processor fold over an event log, reached as an RpcTarget_. They
differ **only** in their fold + their exposed interface.

```
capnweb RpcTarget  (the atom — object-capability over any transport; not ours)
        │
DOMAIN OBJECT = event-log ⊕ fold ⊕ RpcTarget surface ⊕ hibernatable wake   ← the innermost iterate primitive
        ├── STREAM   : interface = append/subscribe;  fold = core stream state; wake-on-append   (#2386)
        ├── CONTEXT  : interface = resolve/invoke;     fold = mount table;       wake-on-call      (spike 4)
        │      └── a PROJECT is the root CONTEXT for a projectId
        ├── REPO / SECRET / SCHEDULER / AGENT / DEVICE : other interfaces + folds
        │
ITX = the capnweb navigation of a CONTEXT's resolved capabilities  (itx.streams.get(x).append(e))
```

**Answers this model gives (the claims to grill):**

- **What is innermost?** Two things, orthogonal: the **event log** (storage) and the **context** (capability).
  A context's _own durable state is an event log_ — so storage is "below" capability, but a stream is exposed
  _as_ a capability — so capability is "above" storage. Neither is uniquely innermost; they compose. The
  _domain object_ is the primitive that fuses them.
- **Where does the stream fit?** A stream is a domain object whose product **is** its event log
  (append/subscribe). NOT more core than the context — it's one interface over the shared substrate, and can
  be implemented off-Cloudflare (Pi userspace) as a live capability. Do **not** merge stream and context into
  one DO (retracted "unicorn"): they share the event-log + wake _engine_, not the class — a context needs no
  product event log of its own beyond its mount fold; fusing them = the god-object (grounding-agent verdict).
- **Where does ITX fit?** ITX is not a thing — it's the **navigation** (capnweb dotted-path) of a context's
  resolved capabilities. `env.ITX.get()` returns the project's root context; `itx.foo.bar` = resolve `foo`,
  then call `bar`.
- **What is a "project DO"?** The **root context DO for a projectId**: its event-log fold is the project's
  mount table (what capabilities/streams have been provided/revoked), its resolver answers `itx.*` (local →
  constructive default, e.g. `streams.get` → a Stream DO by name → parent = the control-plane context), and it
  holds the hibernatable wake sockets for the project's live device capabilities.

**Open sub-questions to jam (not resolved):**

1. **Do live device capabilities live as wake sockets ON the project context DO, or as their own domain
   objects the context points at?** (apps/os has a `DeviceDurableObject`; spike 4 put device doorbells
   directly on one context DO.) Trade: per-device DO = isolation + its own address; doorbell-on-context =
   fewer DOs, simpler wake. Likely: sharded context DOs hold doorbells; a device is a _mount_, not a DO.
2. **Is the event log truly the only storage primitive, or do some domain objects want plain KV/SQL?**
   (secrets, the directory). i.e. is "everything is event-sourced" a law or a default?
3. **Egress/fetch ↔ secrets ↔ stream-paths:** keep egress as _just a provided `fetch` capability_ on the
   context that internally knows about secrets (which are themselves a capability/domain object)? Keeps the
   innermost surface small (Jonas's musing).
4. **Is the control plane just a context whose mounts are ingress-routes + the directory, with the iterate
   product as one more mount?** (This is §1 restated as "control plane = a context." Likely yes.)

---

## Log

- **2026-08-03** — Session start. Reloaded the `apps/os` capability system (§0) via three readers.
  **Locked §1** (three layers as mutual capability provision; revises ADR 0030). Opened §2 (everything as
  provided capabilities, stateless-first) with the "cache routing not data" principle, the streams-as-caps
  proposal, and the Pi/HA unification. Forks in §3 await Jonas.
- **2026-08-03 (cont.)** — Added the **nested shells** + **transport-duality entrypoint** goal (§4) and the
  **north-star** (§5). Locked **full shadowing for now** and **one-DO-now / KV-later** (refines §2a). Auth
  mechanism reframed as a provided/shadowable capability (§4, fork 6). Recorded the **linear-growth of
  capabilities** problem + the _constructive-default, store-only-overrides_ candidate (fork 8). Launched
  **three independent research agents** on the capnweb entrypoint design → `proposals/capnweb-entrypoint-
{a,b,c}.md`; will discuss when they land.
- **2026-08-03 (proposals in)** — All three landed (§6). **Unanimous:** the `RpcTarget`-alias fact (one
  class, both transports, zero adapter), the one-`WorkerEntrypoint`/two-doors shape, shells = the existing
  `apps/os` chain, kernel-as-interfaces with CF-DO vs Pi-Miniflare impls, constructive streams, god-object
  death, Pi symmetric dial-out. **Physics ceiling:** workerd#6873 brand check ⇒ hot pipelined built-ins
  must stay real getters — "everything is a capability" is conceptual, not literal. **Locked 3/3:** forks
  3, 6, 8. **New fork 9** (provision representation); lean recorded. **Fork 2** (offline replay) still the
  open product call.
- **2026-08-03 (side-quest)** — Jonas challenged §6's brand-check ceiling: he recalls proxies pipelining when
  `RpcTarget` is on the prototype chain, and the ceiling is really a _native-Workers-RPC_ fact, not
  necessarily a _capnweb_ one. Paused the main thread and opened an independent spike at
  **`spikes/capnweb-pipelining/`** to measure it: a minimal capability host with `provideCapability` + one
  `invokeCapability`, and a provider (client A) + consumer (client B) proving `itx.streams.get("/x")
.helloWorld()` costs **one** round trip B→hub and **one** hub→A (not two). Findings will be written into
  the spike's own README and folded back here. **Bookmark at the top of this doc marks the return point.**
- **2026-08-03 (side-quest DONE)** — Spike built + green (`spikes/capnweb-pipelining/spike.mjs`, self-verifying,
  5/5). **Result: the §6 ceiling was wrong for the capnweb path — Jonas was right.** A `Proxy` resolver
  pipelines; one `invokeCapability` fallback gives 1 round trip B→hub + 1 hub→provider; a `Proxy` with
  `RpcTarget` on its prototype is passed by reference. Corrected the §6 paragraph and the top bookmark. The
  `workerd#6873` brand check is native-Workers-RPC only; safe rule = real `RpcTarget` across native
  boundaries, resolver `Proxy` on the prototype. **Softens fork 9** (provision can be a uniform proxy-resolved
  fallthrough without a pipelining penalty). Open: confirm the native (DO/`ctx.exports`) leg under `workerd`.
- **2026-08-03 (side-quest 2 DONE + deployed)** — Built the FULL "look around the corner" model as one
  ~90-line `CapabilityHost` (parent fallthrough · live/static caps · iterate mounted on the CP · egress
  provided down · full shadowing) in `spikes/capability-fallthrough/`. Proven in **real workerd** over three
  transports (Node→workerd capnweb · **native Workers-RPC across a DO boundary** · workerd→workerd capnweb
  over a service binding), **in Miniflare AND deployed** to the POC account
  (`capnweb-spike-{gateway,peer}.iterate.workers.dev`). The native-boundary leg (spike 1's one gap) is
  **closed** — the real-instance + resolver-Proxy-on-the-prototype rule holds. Then launched a 6-agent
  **red-team** (volume · duration · reconnect · resources · security · blast-radius) → `redteam-*.md`;
  synthesis pending.
- **2026-08-03 (red-team synthesis)** — All 6 landed → `redteam-SYNTHESIS.md`. **Verdict: model sound, every
  core proof stands; the spike's naive hosting/scale/trust posture does not.** Deduped root causes: capnweb
  has **no distributed GC / hibernation / reconnect** (→ per-access resolve LEAKS on the hot path; live-mount
  DOs billed 24/7; silent half-open corpses; split-brain-by-name), capnweb **ships eval with no resource
  governor** (unbounded batch / `.map()` fan-out), **no authority model** (unauth wire mutators; upward
  resolution leaks ancestor caps; re-delegable secret-bearing egress), and the **single DO** = SPOF + hot
  shard recreating DO-pinning. Pre-commit guardrails = mostly the fork-9/§2a leans (names-not-stubs + cache;
  per-tenant; downward-scoped; epoch-keyed eviction; idempotency) — now proven **mandatory**. Biggest new
  fork: **live sockets want hibernatable raw WS + a protocol, not a pinned capnweb session.** Fixed 2 spike
  bugs (phantom `Symbol.dispose` disconnect crash; `setParent` no `.dup()`); node + workerd regressions green.
- **2026-08-03 (innermost primitive + wake mechanism)** — Jonas: the hibernatable-WS live-mount fork **is
  already built** — PR **#2386** ("Stream wake sockets"), `apps/os/src/domains/streams/wake-socket.ts`: a
  `ctx.acceptWebSocket` **wake socket** (cheap doorbell, survives hibernation, dialed via the DO stub's real
  `fetch()` because a 101 can't cross an RPC method) + an **idle-torn-down RPC leg**. Solves the red-team's
  24/7-billing finding; already handles the `close→wake→open→idle-close` resurrection loop, `socketId`
  same-key replacement, at-most-once wake + client dedupe, and mid-live-eviction self-heal.
  **Decisions/threads:**
  - **Capability host ("context") is MORE core than "stream."** A stream is _just a capability_
    (`append`/`subscribe`) with a **pluggable** impl — DO+event-log (reference) or Pi userspace on another
    stack. So it can't be innermost; it's a mount.
  - **Do NOT merge stream + capability host into one "unicorn" DO** (tempted, then retracted): the host needs
    **no event log**; a stream capability does — merging = the god-object we killed. They **share the wake
    _mechanism_, not the data.** Extract #2386's wake socket into a reusable primitive both use.
  - **Generalize the wake mechanism:** streams wake **on append**, resume by **replaying the log**; general
    capabilities wake **on call**, resume by **forwarding the pending call** (simpler — no log). Same doorbell
    - phone-call; different trigger/resume. Spiking wake-**on-call** in `spikes/capability-wake/`.
  - **OPEN — the innermost set a project worker knows about (musings):** (a) network **ingress/egress/fetch**;
    (b) **capabilities / capnweb** (resolve + fallthrough + wake substrate); (c) **running dynamic workers
    with capability binding** (confined config worker + `env.ITX`); (d) **the project Durable Object — what is
    actually in it?** (open).
  - **Egress ↔ secrets ↔ stream-paths coupling (musing):** today egress ties to secrets, which tie to stream
    paths. Make it **pluggable** — egress is _just a built-in provided capability `fetch`_ that happens to
    know about secrets (and thus their stream paths). The coupling lives _inside_ the fetch capability, not in
    the kernel — keeping the innermost surface small.
- **2026-08-03 (side-quest 3 DONE + deployed)** — Built + proved the **wake-on-call** live-capability
  mechanism in `spikes/capability-wake/` (generalizes #2386 from wake-on-append). A hibernatable **wake
  socket** (doorbell, `ctx.acceptWebSocket`) + an on-demand **capnweb RPC leg** (pinning, idle-torn-down).
  Proven in **real workerd** (Miniflare) **and deployed** (`capnweb-spike-wake.iterate.workers.dev`), 4/4: a
  registered provider is **dormant with zero pinning stub** (hibernation-eligible) → a call **wakes** it →
  the pinning leg is **torn down after idle** → repeatable. This is Jonas's "loads of live capabilities that
  cost nothing, woken on demand," and it **retires the red-team's 24/7-billing finding** and the
  `retainLiveCapabilityProvider` duped-stub pin. Caveats (in the spike README): actual eviction not
  observable in Miniflare (proves the _precondition_ — no live stub/timer while dormant); production idle =
  DO **alarm** not `setTimeout`; reconnect-races / same-key / dedupe still need the #2386 treatment; auth
  guardrails still apply.
- **2026-08-03 (side-quest 4 — FUSED + hardened, proven in PRODUCTION at fleet scale)** —
  `spikes/capability-fused/` fuses spike-2 (parent fallthrough) + spike-3 (wake-on-call) + the red-team
  hardening (**parent-by-name** → no retained stub → **leak gone**; **downward-only** resolution;
  **mutators behind a secret, off the tenant surface**), and is proven **only on deployed workers**
  (`capnweb-spike-fused.iterate.workers.dev`). Headline: **1000 IoT-style providers each holding a
  hibernatable wake socket; the DO HIBERNATED + was evicted while all 1000 stayed connected**
  (`incarnation 3→4`, `wakeSockets 1000→1000`), and **any single device woke on demand while the other 997
  never stirred**. **Real hibernation confirmed via `wrangler tail`:** a single **60.2s gap with ZERO DO
  events** during idle (no wallTime/CPU → not billed for duration), **0 exceptions**, all `200` except the 2
  expected `403`s (gated mutators); the only odd event was a benign tail-sampling notice, not a DO overload.
  Confirmed platform facts: hibernatable WS survive eviction (constructor re-runs; `serializeAttachment`
  survives); ping/pong doesn't wake; ~10s idle → hibernate. Open: connect-burst on a single DO wants
  per-tenant sharding + rate control (fleet filled to 1000 only via device auto-reconnect); idle→DO-alarm not
  `setTimeout`; port #2386's same-key/reconnect guards. (GB-s billing cross-check via Cloudflare MCP pending
  user auth.)
- **2026-08-03 (billing proof + platform lessons)** — Cloudflare DO analytics confirm the design at
  billing level. **5-min soak, 1000 WS held: 14–22 ms billed `activeTime`/min = ~0.47% wall-clock →
  ~99.5% hibernating**; the DO wakes ONLY on a call/poll, never spontaneously (`wakeCount=0`). Lessons
  banked (see `spikes/capability-fused/README.md`): (1) the earlier **`clientDisconnected` spike was
  self-inflicted** — bursting 1000 sockets onto ONE DO caused herd-drops + auto-reconnect churn (each drop =
  a `clientDisconnected` in the analytics _errors_ metric + odd mid-idle wakes); **staggered connect → 0
  reconnects, 0 disconnects** (⇒ production wants per-tenant sharding + connect pacing, the red-team's point,
  now measured); (2) **close gracefully (code 1000)** — the `web_socket_auto_reply_to_close` flag (default
  ≥2026-04-07) auto-finishes the handshake, avoiding client-side `1006`; (3) **NEVER `ctx.abort()` to keep
  clients** — verified live it CLOSES all hibernatable inbound sockets (`1006`, not re-attached) + 500s +
  `incarnation++`; that's the `{webSockets:"close"}` eviction mode. For "reset memory, keep clients" rely on
  **natural hibernation** (`{webSockets:"hibernate"}` default: sockets survive + re-attach, constructor
  re-runs). (4) a mass disconnect reads as N errors in DO analytics — benign; page on
  `scriptThrewException`/`exceededCpu|Memory`, not `clientDisconnected`.
- **2026-08-03 (fork 9 promoted → §8; innermost-core jam opened → §9)** — Folded all 4 spikes + the billing
  proof into a **recommended architecture** (§8): the hardened wake-based capability host (transport-dual
  RpcTarget · downward fallthrough-by-name, no retained parent stub · wake-on-call live mounts · gated
  mutators · constructive defaults · per-tenant + paced connects). Opened the **innermost-core** reasoning
  (§9): the unifying primitive is **"the domain object" = event-log ⊕ fold ⊕ RpcTarget ⊕ hibernatable wake**;
  stream and context are two interfaces over that shared substrate (don't merge); ITX = navigation of a
  context; **a project = the root context DO for a projectId**. Four sub-questions left open to jam.
