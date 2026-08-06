# Wayfinder map — the innermost core

**Effort:** find the irreducible primitives of the platform and the dependency graph between concepts —
where do _capability_, _running code_, _stream_, _context/ITX_, _project DO_, _auth_, and the _3–4 shells_
sit, and how are they implemented in terms of each other. Local Wayfinder convention (map + `issues/NN-*`).

Parent jam: `../jam-capability-provision.md` (§8 recommended arch, §9 innermost-core proposal). Proven
substrate: 4 spikes in `spikes/` (pipelining, fallthrough, wake, fused-1000-devices) + billing analytics.

---

## Notes (the material we're reasoning over)

**Jonas's framing (2026-08-03), captured faithfully:**

- **Running code is core.** "Capabilities are only relevant if you can run stuff in the context of the
  capabilities." The capability substrate is inert without an execution substrate that holds a context and
  calls it.
- **Auth is core to the capability substrate, and it's _harder_ than pure ocap.** Kenton's model: you can
  only obtain an RPC stub to something with exactly the authority you're allowed. But when capabilities are
  **dynamically provided**, we get **capability call-time narrowing** — authority is computed at resolve/call
  time, not frozen when a stub is minted. "I don't know exactly how that fits in."
- **Four shells now** (nested, "entangled in my mind"): (1) innermost = **a capability**; (2) **project** =
  has the capability substrate; (3) **control plane** = knows about multiple projects; (4) **product** =
  knows about Slack/GitHub/etc.
- **Multiple storage substrates:** stream + repo, **and KV + R2**. KV/R2 "will probably form a core part of a
  project, provided by the control plane" (or optionally not).
- **Event-sourcing is ~a law.** The high-level theory (see the higher design docs): a **self-improving
  digital organism**; in the abstract the whole thing is **a single ordered event log**. At scale that's
  untenable, so we structure it into **streams**, each with a total ordering of events — which lets us model
  logic with **functional programming + stream processors** (convenient, testable). _That's_ why we like it.
- **Control plane and product must be implemented in the SAME abstractions** (streams, contexts) as a
  project — their source code too. They should **nest in each other without being completely separate
  ideas**. "I don't know how we get that."
- **Egress/fetch:** sketch a few ways.
- **The real ask:** within the 3–4 large shells there are **more-core and less-core objects and a dependency
  graph of which concept knows about which**. And **every concept must know what a capability is and how to
  express it — including how to provide TYPES for capabilities so dynamically-run code can be type-checked.**

**Jonas's refinements (2026-08-03, second pass):**

- **Doorbell → PAGER.** It's not something the caller sets up — it's **given to you by the thing you're going
  to call**. A live capability **provides its own reach** (a pager). The caller just invokes; paging is
  internal. So the wake channel is part of a capability's _own provision_, not a separate concept.
- **Most devices won't be DOs — some could, and the capability system shouldn't care.** It's conceivable to
  implement something _like_ an ESP32 **in a Durable Object** that gets paged the same way. The paging
  mechanism is **uniform over device / browser / DO / BYO provider**.
- **Streams must inherit the pager/wake mechanism for FREE.** "How do we make it so that, without any extra
  work, streams automatically benefit from [the 1000-device mechanism]?" → the wake/pager must be a property
  of the **context/capability substrate**, so streams-as-capabilities get it automatically. → `09`
- **KV/R2 portability is THE proof point** (project code identical across deployments): → `08`
  1. Innermost project layer deployed in ONE Cloudflare account "over there" → `itx.kv` / `itx.r2` bind to a
     REAL KV/R2 in **that** account.
  2. In our hosted product, `itx.kv` "maybe can be the same thing."
  3. But hosted product has only ONE R2 / a finite number of KV+R2 namespaces for the WHOLE product.
  4. So we **prefix with project ID**.
  5. Projects in **our** account and projects in a **customer's BYO** account must **write exactly the same
     code.** "This is a real proof point for our architecture."
- **Rich auth (auth.iterate.com-style, project-created-while-you-authenticate) may be PRODUCT, not
  control-plane.** Self-hosting just the inner two spheres (project + control-plane) gets _simpler_ auth; the
  onboarding/emerge flow (ADR 0029) belongs to the paid product (outer shell). → refines `02`.

**Jonas's answers to the §9 sub-questions:**

- Q1 (device = mount-on-context vs own DO): _didn't understand — needs re-explaining._
- "Doorbell + attachment" analogy: _didn't understand — needs re-explaining._
- Q2 (event-sourced law or default): **~law** (see the organism theory above; nuance: KV/R2 are _also_
  storage substrates → is the law "logic is event-sourced" while KV/R2 are non-logic storage capabilities?).
- Q3 (control plane is a context too): **yes** — and product too; both in the same abstractions, nested.
- Q4 (egress/fetch): sketch options.

---

## Decisions-so-far

- **D1 — The unifying primitive is "the domain object":** an addressable, hibernatable, event-sourced
  `RpcTarget` = { event log ⊕ fold ⊕ RpcTarget surface ⊕ hibernatable wake }. Already literally true in
  apps/os (~10 domain DOs). Stream/context/repo/secret/agent differ only in fold + interface. (§9, proven.)
- **D2 — Two orthogonal substrates that compose:** the **event log** (storage) and the **context**
  (capability: resolve + downward fallthrough-by-name + wake). A context's own state is an event log; a
  stream is exposed as a capability. Neither is uniquely innermost — the domain object fuses them.
- **D3 — A project = the root CONTEXT for a projectId.** ITX = the capnweb navigation of a context's
  resolved capabilities. (§9.)
- **D4 — The recommended capability-host architecture is proven** (jam §8): transport-dual RpcTarget;
  downward fallthrough-by-name (no retained parent stub → no leak); wake-on-call live mounts; gated mutators;
  constructive defaults; per-tenant + paced connects. 1000 devices / one hibernating DO / ~99.5% idle,
  billing-confirmed.
- **D5 — Do NOT merge stream and context into one DO.** They share the event-log + wake _engine_, not the
  class (a context needs no product log beyond its mount fold; fusing = god-object). (grounding verdict.)
- **D6 — Never `ctx.abort()` to keep clients** (closes hibernatable sockets); rely on natural hibernation.
  Pace connects; close with code 1000. (Platform lessons, billing-verified.)
- **D7 — A live capability provides its OWN reach (a PAGER).** The wake channel is handed to the caller by
  the callee, as part of providing the capability — not set up by the caller. The consumer just invokes; the
  substrate pages if there's no live leg. Provider can be a device, a browser, a BYO worker, OR a DO — the
  capability system is indifferent. (Revises the "doorbell" framing.)
- **D8 — Deployment portability is a PROVIDER concern, not a code concern (the KV/R2 proof point).** `itx.kv`
  / `itx.r2` have a fixed interface; the _provider_ encodes the deployment reality — a dedicated namespace in
  a BYO account, OR a shared namespace with `<projectId>:` key-prefixing in our finite-namespace hosted
  account. **Project code is byte-identical across both.** This is the "location is a property of the
  provider" principle (from the Pi) applied to storage. A real proof point → `08`.

---

## Fog (unresolved — the frontier lives in `issues/`)

- Where exactly does **running code** sit, and is (context + execution) the real innermost pairing? → `01`
- How does **dynamic-provision auth / call-time narrowing** diverge from pure ocap, and where are the
  authorization boundaries (resolve-time? fallthrough hop? `onCall`?)? → `02`
- Is the **4-shell model = 4 nested contexts** (capability atom → project → control-plane → product, by
  parent fallthrough), and does that dissolve the "entanglement"? → `03`
- Are **stream / repo / KV / R2** all _storage capabilities_, and is event-sourcing the law for _logic_
  while KV/R2 are non-logic storage? → `04`
- What is a **capability**, fully? (callable + **type descriptor** for typechecking dynamic code +
  provenance/authority) — the "how to express a capability" requirement. → `05`
- Can **control-plane + product** be implemented in the _same_ abstractions (contexts + streams +
  processors), nested via fallthrough? → `06`
- **Egress/fetch** — a few concrete sketches. → `07`
- **KV/R2 deployment portability** — same project code, dedicated (BYO) vs shared+prefixed (hosted). The
  architecture's marquee proof point. → `08`
- **Streams inherit the pager/wake mechanism for free** — the wake substrate is a context property, not
  stream-specific. → `09`
- **The outbound boundary connection** (project → control-plane): how egress/mediated caps cross an account
  boundary performantly + authenticated; the fractal (outbound ≡ the inbound pager). → `10`

## Decisions-so-far (cont.)

- **D9 — Two kinds of capability: LOCAL-binding vs MEDIATED.** LOCAL (`itx.kv`/`itx.r2`/stream DO) = a
  binding in the local account, **no cross-shell connection at call time** (the control plane only
  _provisioned_ it). MEDIATED (metered egress, directory, product caps) = served by an outer shell, needs
  the boundary connection. Most of a project is LOCAL → fast; only outer caps cross. (`10`)
- **D10 — The boundary connection is ONE interface, TWO providers; outbound ≡ inbound pager (the fractal).**
  Same account → a Workers-RPC service binding (fast). Cross account → a **connection-holder DO** owning one
  standing (future-hibernatable) capnweb connection, exposing the same interface locally (handshake paid
  once). This is the pager (D7) pointed _outward_. Reconciles fork-9 (name→DO cheap, no leak) with perf
  (warm stub in exactly one DO, `onRpcBroken`-evicted). (`10`) _[Deferred by D11 — no cross-account topology
  for now; keep as the future data-path for a mediated cross-account cap.]_

- **D11 — LOCKED: only TWO deployment topologies for now (differ only in config).** (Jonas, 2026-08-03.)
  1. **Self-host all workers** (you run everything, incl. the control plane + MCP).
  2. **Iterate hosts all workers** — identical, plus **one extra outer sphere: the product worker**.
     No mixed "project in your account ↔ our control plane" topology; no cross-account dial; no
     connection-holder DO needed now. **Data residency is a per-capability PROVIDER OVERRIDE, not a deployment
     axis:** "bring your own streams" / "bring your own repos" = override the stream/repo collection RpcTarget.
     This collapses the four archetypes to two and defers the cross-account machinery (ADRs 0008/0009/0010/0013/
     0027 + level-2 0006). **LOCKED as ADR 0035** (`../DECISIONS.md`); full docs-simplification sweep in `11`
     (resolved). "It simplifies a lot of stuff."
- **D12 — KV/R2 = a projectId-prefixed RpcTarget; the prefix is AMBIENT, not a mode.** Once you're at the
  **project RpcTarget** (the inner shell), you always carry the `projectId`, so `itx.kv`/`itx.r2` prefix by
  it automatically. Self-host vs hosted is likely the _same_ impl (just `env.KV`/`env.R2` bindings) — you
  rarely want a project using our main account's KV. So NOT `kvMode` — just one prefixing RpcTarget over
  whatever binding is wired. (Revises `08`.)
- **D13 — Ingress & egress are `fetch` traversing a SHELL ONION (corrected 2026-08-03).** The shells nest
  (project ⊂ control plane ⊂ product) and network traffic goes through all present shells:
  - **Egress (inside→out):** project → control plane → **[product, when hosted]** → internet.
  - **Ingress (outside→in):** internet → **[product, when hosted]** → control plane → project.
    So **egress ALWAYS flows through the control plane** (ADR 0017 holds — NOT direct-fetch, even in
    self-host), and **through the product too when we host** — the product is the outermost network shell (the
    edge); the control plane is the edge in self-host. This is the §4 "fetch-middleware onion": ingress = outer
    calls inner, egress = inner calls outer. Reconciles "ingress/egress are just `fetch`" with "egress flows
    through the control plane": both are `fetch` through the onion; each outer shell adds its own concerns
    (product = metering/first-party keys/onboarding; control plane = routing/directory/provision). Made cheap
    by co-location (same-account service binding, no cross-account dial — a consequence of D11).
- **D15 — ONE streams namespace per deployment; two address tiers (project / global), one authority bit.**
  (Jonas, 2026-08-03: "our own hosted deployment should only have ONE streams namespace.") Retracts the
  three-tier nested-namespace idea. Matches apps/os today: DO names are faux URLs `{projectId}.iterate{path}`
  / `global.iterate{path}` (`DurableObjectNameCodec`); `assertCanAccessProject` gates project-tier (own id
  only) vs global-tier (admin/above-project). **Control-plane AND product code share the ONE `global.iterate`
  namespace at different paths** — the shell distinction is _code + authority_, NOT a separate stream store.
  A **context = a SCOPE (a lens), not an island** — but the scope is binary (own-project vs global), not a
  nest. Outer-authority code writes into a project's stream by naming `(projectId, path)` directly (the
  webhook door already does this); a project's RpcTarget is confined by construction (can't name `global`/
  other projects). "Two levels of global streams" = two _paths/purposes_ (cp directory vs product
  webhook-debug), not two namespaces. Only BYO-streams (D11 residency override) points a collection at an
  _external_ namespace. ⚠️ `events.iterate.com/*` = the event-TYPE vocabulary, a DIFFERENT namespace from the
  `.iterate` DO-address one — don't conflate. (`12` resolved.)
- **D16 — Keep `streams.get(path)`, NOT `streams[path]`.** (2026-08-03.) The Pi/BYO provided-stream case works
  with EITHER — `get`'s impl consults the mount table (Pi shadow) and falls through to the constructive DO
  default, so a path can still be a pluggable provider. So `[path]` is not _required_. `get(path)` wins on two
  things that matter: **(1) TypeScript for dynamically-run code** (`get(path): Stream` coexists with
  `list()`/`create()`; an index signature `[path]: Stream` would force _every_ member incl. `list` to be a
  Stream — breaks — hurting `05`'s typecheck requirement); **(2) disposal** — a `get()` RETURN is an
  independently-disposable stub, but a `[path]` PROPERTY READ yields an `RpcPromise` with **no own disposer**
  (capnweb README) — bad for streams that hold subscriptions/pagers. Uniformity of _mechanism_ is preserved:
  `get` is a typed, disposable facade over the same resolve/mount/fallthrough. `[path]` could be added as
  sugar but muddies types — skip it.
- **D17 — [DEFERRED post-v1 — superseded for now by D19].** _Jonas relaxed the "instant via KV" requirement
  (2026-08-04): the KV projection can't give instant usability (negative lookups are cached + writes take
  ≤60s), so v1 always hits the DO. Keep D17/D18 as the eventual read-scale path._
  The shadow map is a KV PROJECTION of the fold (source of truth = the event-sourced mount fold DO;
  KV = the fast read path).** (Jonas, 2026-08-03 — pulls §2a forward for the routing specifically, because
  it's read on the hot path and a DO there would be the chokepoint the red-team flagged.) A shadow entry is
  DATA that is **either self-contained** (`{kind:"itx-expression", expr}` — resolved with no DO touch) **or a
  POINTER** (`{kind:"live", ref}` — into the fold DO where the live stub lives, resolved via the pager; or
  `{kind:"durable-external"}` for BYO). Unshadowed path = **no KV entry** = constructive default. **How the
  collection gets it:** the project CONTEXT reads the project's shadow set once at build (one small KV read,
  usually empty), slices it to each collection (streams/repos/kv…); `get(path)` checks the in-memory slice
  (O(1)), no per-get I/O. **What if it changes:** provide/revoke updates the fold (source of truth) which
  rewrites the KV projection; readers pick it up within KV propagation (**≤60s global; `cacheTtl` min 30s**).
  **Revocation degrades gracefully** even with a stale entry — a stale `live` pointer resolves at the DO,
  which finds no provider → falls back to constructive default. Long-lived sessions can be invalidated by a
  mount-change **wake\*_ (same pager). Strong-consistency-sensitive reads bypass KV and hit the fold DO
  directly. `get` stays constructive & record-free for the 99% unshadowed case (fork-8). _(See D18 for who
  writes it + failure/ordering/drift semantics.)\*
- **D18 — [DEFERRED post-v1 with D17].** _The write-side mechanics for when the KV projection lands. Not v1._
  The mount-fold processor (in the capability-host DO) writes the projection; failures self-heal via
  at-head reconciliation; drift is observable, never silent.\*\* Grounded in Cloudflare KV/DO semantics +
  existing apps/os patterns (evidence below).
  - **Writer = the fold's OWN processor, co-located in the per-tenant capability-host DO. Single writer, one
    KV key per project.** Cloudflare's own guidance: _"write from a single process (Durable Objects) to avoid
    competing concurrent writes … last write wins"_ — so a single-threaded DO writing one key has **no
    concurrent-write race**. NOT a separate downstream processor (avoids a second DO/pin); NOT read-through.
  - **Write the FULL current shadow set, not deltas** ⇒ **idempotent + order-independent**. A lost, failed,
    retried, or out-of-order write is corrected by the next write (KV has no cross-write ordering; full-state
    writes don't need it). Sidesteps last-write-wins by making every write the complete truth.
  - **DEBOUNCED** (at most ~1 write/sec/key — KV's hard limit; over-rate → `429`). Mirrors apps/os's stream
    checkpoint (`stream-durable-object.ts:469-474,1108-1112`: debounced, "event rows are the durable truth,
    boot catch-up folds past a lagging checkpoint"). A flapping provider cannot exceed the KV write rate.
  - **Failure/eviction = at-head reconciliation, not a lost update.** The event-sourced fold is the durable
    truth; the KV write is a **droppable, restartable side effect**. Evicted between commit and write → the
    next incarnation's eventless at-head pass re-writes it — the capability host's EXISTING obligation
    machinery (`capability-host-durable-object.ts:63-67`, `delivery.caughtUp` re-drives). No new mechanism.
  - **Drift is OBSERVABLE:** stamp the projection value with the **fold offset it reflects** + a written-at
    timestamp. A reader/health-check compares KV-offset vs fold-head (or age vs a bound) → drift is
    detectable + bounded, satisfying "no silently tolerated drift."
  - **Revocation asymmetry (the safety-critical part):** **`live` mounts are DO-authoritative** — the KV
    entry is only a POINTER; resolving it hits the DO, which checks its live-stub map (keyed by connection;
    `onRpcBroken` removed a dead one) → a stale KV can **never** route to a dead provider (instant revocation
    at the DO, KV-lag-immune). **`itx-expression`/`durable-external` mounts are self-contained** → their
    revocation is bounded by (debounce + KV propagation ≤60s + reader re-read); revocation-sensitive ones must
    resolve DO-authoritatively, not via KV.
  - **Completeness requirement (why source-written, not read-through):** the projection is the COMPLETE
    per-project set, so **absence = authoritative "no shadow."** This DIFFERS from apps/os's
    `project-directory.ts` (a read-through cache where a miss consults the source — absence is NOT
    authoritative there). A shadow "set membership" needs completeness, so the source must write the whole set.
  - **Long-lived contexts:** live-shadow revocation always safe (DO-authoritative per `get`); **additions +
    expression/durable-shadow revocation** are unseen by a frozen slice → need a bounded re-read (per request,
    or `cacheTtl`-bounded ≤30s) or a mount-changed **wake**. See unresolved Q's.
- **D19 — LOCKED: the capability context is `ItxDurableObject`, always hit directly (strong consistency);
  capabilities are added frequently and MUST be instantly usable.** (Jonas, 2026-08-04.)
  - **HARD REQUIREMENT (write it loud):** capabilities are provided/revoked _frequently_, and a just-provided
    capability must be **instantly usable** — the very next resolve sees it. This is WHY we hit the DO and
    defer KV: KV caches negatives + propagates in ≤60s, so it _cannot_ be instant. The DO is single-threaded +
    strongly consistent → `provide` then `resolve` is instant. (Answers Jonas's negative-cache question: yes,
    a cached negative for a never-before-called path would break instant usability — the DO has no such cache.)
  - **ONE clean primitive, named `Itx`.** `ItxDurableObject` = the capability CONTEXT, one per scope (a
    project; the control plane; the product). It is the "domain object" (D1) for capabilities: a durable
    **mount table** + **resolve** (local mount → constructive default → **parent by name**, downward-only) +
    **live pagers** (the fused-spike wake mechanism) + provide/revoke mutators. Reached over BOTH transports
    via a thin `Itx` WorkerEntrypoint front (spike-2: `fetch` = capnweb, `get()` = Workers-RPC loopback);
    every capability call hits the DO (accepted cost now — the KV read-offload is D17/D18, later).
  - **Shells = nested `ItxDurableObject`s.** Each shell is an `ItxDurableObject` with a `parentName`;
    fallthrough is `env.ITX.getByName(parentName).resolve(name)` (same-account DO→DO). Project → control-plane
    → product → terminal (constructive default / nothing). Not a god-object (ADR 0018): built-ins are typed
    getters; the DO stays thin; capabilities are self-contained mount entries.
  - **The mount table is a FOLD, not a plain map (corrected 2026-08-04 — D20).** The host is event-sourced:
    `provide`/`revoke` APPEND `capability-provided`/`-revoked` events; a **stream processor** folds them into
    the live mount table (= apps/os `CapabilityHostProcessor`); `resolve` reads the fold. Still instant (fold
    in memory, event is the durable backing), now auditable/replayable and written like every domain object.
    Strong-consistency-sensitive resolves ALWAYS hit the DO (even after D17/D18, those stay DO-authoritative).
- **D20 — Coherence fixes (2026-08-04, Jonas caught the drift):**
  - **There is only `fetch`, not "egress".** One method `fetch(request)→response`, two directions: inbound =
    ingress (the project's fetch HANDLER), outbound = the project's fetch CAPABILITY (mediated by the control
    plane: metering / secret-substitution). "Egress" is retired as a separate noun — it was just "outbound
    fetch."
  - **Built-in vs provided is ONE mechanism.** All capabilities resolve via `resolve(name)` (mount → default
    → parent). "Built-in" = the kernel ships a **constructive default** for that name (`streams`→Stream DO,
    `kv`→binding, `fetch`→mediated door) AND a typed getter (TS + pipelining, spike-1). "Provided" = no
    default, exists only when mounted (Slack, Pi). Same resolve for both; built-in is not privileged in the
    mechanism.
  - **Execution is a capability (was omitted).** Running arbitrary code = `itx.workers.run(...)` → Worker
    Loader loads a worker with THIS itx bound as `env.ITX`. That's how userspace runs + reaches capabilities
    (ticket 01's (capabilities, execution) pairing). The host both OFFERS run-code AND IS running code (its
    fold). Two forms of execution, both first-class.
  - **The host, in one sentence:** a domain object = a stream of mount events, FOLDED by a processor into a
    mount table, exposed as `itx`, resolving (mount→default→parent), holding pagers, offering run-code. One
    object, several facets; not a god-object (each capability is a self-contained module).
- **D21 — itx is PATH-addressed, and paths + shells are ONE fallthrough chain; the chain bottoms out at real
  worker env bindings.** (Jonas, 2026-08-04.)
  - **The path IS the context.** An itx handle = "the capabilities **at path P** in project X." `/` = project
    root; `/agents/some-agent` = an agent; `/repos/y` = a repo. "Doing something in the context of an agent /
    a repo / a path" = holding the itx at that path. Already latent in apps/os (`itxForScope` fronts `/` and
    `/agents/…`; DO names are `{projectId}.iterate{path}`).
  - **The parent of a path is the enclosing path; the parent of `/` is the enclosing shell.** So within-project
    path fallthrough (`/agents/some-agent` → `/`) and cross-shell fallthrough (`/` → control-plane → product)
    are the SAME parent mechanism at different granularities — one uniform chain from a deep path out to the
    product. A deep context **inherits** everything provided above it by fallthrough.
  - **Agents / repos are capabilities provided at a path** — mounts born by events (capability-provision
    payloads on streams). Creating an agent = a `capability-provided` event at `/agents/some-agent`.
  - **THE FLOOR — where everything begins — is the real Cloudflare env bindings.** The constructive default
    for each built-in IS a real binding: `streams`→`env.STREAM`, `workers.run`→`env.LOADER`, `ai`→`env.AI`,
    `kv`→`env.KV`, `r2`→`env.R2`, `artifacts`→`env.ARTIFACTS`. A trusted **kernel project entrypoint** holds
    these and vends them as the default leaves; **userspace sees only `env.ITX`** and resolves down to them
    (never a raw binding). This is the north-star split: kernel DEFINES the capability interfaces; the
    reference impl BINDS them to real Cloudflare bindings; the abstract path/fallthrough/mount tree resolves
    DOWN to those leaves (or to an override). Swap the bindings (Miniflare/Pi) → same tree, different floor.
  - **`resolve(name)` at any path =** override mount → constructive default (a real env binding, path-scoped)
    → parent (inherit from the enclosing path, then the enclosing shell).
  - **RESOLVED (was OPEN FORK) — every path is its OWN capability-host DO** (`{projectId}.iterate{path}`).
    (Jonas, 2026-08-04, on `concrete-walkthrough.md`: "it's own DO.") `/`, `/agents/support-bot`, each
    repo/stream = its own `CapabilityHostDurableObject`. Not "coarse DOs with logical sub-contexts." Matches
    apps/os's per-`{projectId,path}` DO names.

- **D22 — `APP_CONFIG` is DEPLOYMENT-wide, NOT per-project; projectId comes from the DO name.** (Jonas,
  2026-08-04, on `concrete-walkthrough.md`: "there's only ONE worker deployment with one set of env vars for
  the entire hosted system with many projects.") So `env.APP_CONFIG` holds ONLY `{rootParent, defaults}` —
  identical for every project the worker serves; it has **no `projectId`**. The projectId is established at
  request time (ingress auth/routing → `assertCanAccessProject`) and carried by the **DO name**
  (`{projectId}.iterate{path}`, unforgeable). Per-project prefixes (`KvEntrypoint({prefix})`) are filled by
  the kernel from `this.projectId` (the DO name), never from config. Isolation = per-DO identity, not
  per-project config. `rootParent`/`defaults` are the ONLY things that differ self-host vs hosted vs BYO (D11).

- **D23 — "Execute code in a context" is the capability host's PRIMARY primitive, in TWO modes.** (Jonas,
  2026-08-04.) Every actor is code run with an `itx` bound to a path: the agent, the config worker, a stream
  processor, the `/api` handler.
  - **Mode 1 — live callback:** `host.run(async (itx) => …)`. A real function object; runs with `itx` in
    scope. For TRUSTED first-party code.
  - **Mode 2 — dynamic worker from a STRING:** `host.load("async (itx) => …")`. Source text → Worker Loader
    (`env.LOADER`) → CONFINED isolate whose only binding is `env.ITX`. For UNTRUSTED userspace code (agents,
    config worker, user processors). This is "running dynamic workers with capability binding" made literal.
  - **Userspace uses plain `fetch`, not `itx.fetch`** (Jonas: "that's what agents will automatically use"):
    a confined worker's `globalOutbound` → `itx.fetch`, so normal `fetch` IS the chained fetch. The `itx`
    param is for the other capabilities. **A `live` fetch capability (a mount at name `fetch`) is blessed**
    (Jonas: "pretty cool").
  - **DO naming: steal apps/os's `DurableObjectNameCodec` (`{projectId}.iterate{path}`) for now** — don't
    reinvent the name scheme yet (Jonas).

- **D24 — Ingress is concrete: an authed request → projectId at the door → DO by name → `host.run` the handler.**
  (Jonas, 2026-08-04, asked for the `os.iterate.com/api` walkthrough; see `concrete-walkthrough.md` §5b.)
  Request hits the outer shell (product in topology B), which authenticates and resolves the projectId from
  request+auth (NOT config), gets `{projectId}.iterate/`, and runs the `/api` logic as
  `host.run(async (itx) => handleApi(itx, request))`. The **kernel entrypoint** = ingress door + router +
  real-binding holder + code executor; userspace never runs there, only inside a context via `host.run`.
  Ingress = `fetch` inward through the shell onion; egress = `fetch` outward (D13). Same chain, both ways.
- **D25 — DO naming: adopt apps/os `DurableObjectNameCodec` (faux URLs), retire the `::` scheme.** (Jonas,
  2026-08-04, on `target-core.md`: "look at how apps/os does `#name = …`.") Names are `{projectId}.iterate{path}`
  (`global.iterate{path}` for the outer/`null` scope). The host DO is **`ItxDurableObject`** (file
  `itx-durable-object.ts`) to match `StreamDurableObject`, and reads its identity like every apps/os DO:
  `readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!, { allowNullProjectId: true })`. Supersedes
  the clean-room's current `projectId::path` (`stream-do.ts`). Settles the earlier "steal it" open question.
- **D26 — TWO workers + a SOLO inner core, ONE shared core wired.** (Jonas, 2026-08-04, on `target-core.md`:
  "merge the product and control plane worker"; the real split is "a single project worker without
  authentication and everything else — that's really the inner core.") **REVISED from three workers.**
  - **Product is folded into the control plane** — no separate product worker. First-party keys + metering
    become a **config-gated module** inside the control-plane `identity/` (on when hosted, off when self-host).
  - **The inner core = a single headless project worker** (no browser app, no auth of its own), **deployable
    with NO control plane at all.** It still exposes `itx.auth`, but its `fallback` (config) points at a
    **`DummyControlPlane` loopback entrypoint the project worker exports itself** (so solo stays ONE worker).
    Self-hostable + testable standalone. This finally answers "what is the innermost core."
  - **Why a whole `DummyControlPlane`, not a `DummyAuth`** (Jonas, 2026-08-04): the `fallback` is the whole
    outer-shell contract — `{ invokeCapability({path,args}) incl. auth; + egress delegation → terminal }` — not
    just auth. Solo swaps the ONE `env.CONTROL_PLANE` binding for the dummy, which implements that contract
    trivially (auth→ok, egress→terminal, invoke→not-found). The core's `ItxDurableObject` calls
    `fallback.invokeCapability` / delegates egress identically in every mode → **zero solo special-casing.**
    "Control plane is a capability provider to a project" made literal: real CP and dummy are two providers of
    the same `Fallback` contract (see D30).
  - **Three deployment modes, config-only:** (a) **solo** — project-worker alone, `fallback`=DummyControlPlane;
    (b) **self-host** — + control-plane, `fallback`=CONTROL_PLANE, `firstParty` off; (c) **hosted** — same two
    workers, `firstParty` on. Supersedes ADR 0035's "two topologies" framing with a cleaner solo/self/hosted axis.
  - **Same core in both**, from `packages/itx`. Shared `src/` skeleton = **`worker.ts`** (renamed from
    `index.ts`) + `wrangler.jsonc` + at most one module. project-worker = just the core; control-plane = core +
    `identity/`. Folder layout (two `apps/` vs one) + TanStack app placement = OPEN (out of scope for now).
- **D29 — `APP_CONFIG.fallback` (renamed from `rootParent`→`parent`→`fallback`) + the substrate inventory +
  `SecretDurableObject`.** (Jonas, 2026-08-04.) `fallback` = the enclosing shell a worker's root context falls
  back to; `{via:"terminal"}` ends the chain, `{via:"service-binding"}` = control plane,
  `{via:"loopback-entrypoint", entrypoint:"DummyControlPlane"}` = solo. The core's DO namespaces + classes +
  loopback entrypoints are enumerated together (`target-core.md` §2.1): `ItxDurableObject`/`ITX_HOST` (==
  apps/os `CapabilityHostDurableObject`), `StreamDurableObject`/`STREAM_DO`, **`SecretDurableObject`/`SECRET_DO`**
  (secrets need strong consistency — KV is eventual + 1-write/s/key, wrong for secrets), `RepoDurableObject`
  (deferred, domain fold); loopback leaves `KvEntrypoint`/`R2Entrypoint`/`ItxEntrypoint`/`StreamEntrypoint`/
  `SecretEntrypoint`. Core budget ≈ 1040 LOC (over 1000 by the Secret DO — accepted).
- **D27 — ONE shared `STREAM_DO` (and `ITX_HOST`) namespace across all three workers.** (Jonas, 2026-08-04:
  "same Streams DO namespace in the control plane worker that we also use in the project worker.") The DO
  classes are defined once (migrations in project-worker) and **cross-script-bound** into control-plane +
  product (the apps/os worker-split pattern). Scope is enforced by **which names each shell can construct**
  (`DurableObjectNameCodec`), not a second store: the control plane builds `prj_x.iterate/…` + `global.iterate/…`;
  a project's `Streams` builds only its own `{projectId}.iterate/…`. Concretely realizes D15 (one namespace).
- **D28 — TWO addressing schemes, mirroring apps/os + the spikes (CORRECTED — the earlier "one resolve order"
  was wrong).** (Verified against apps/os `rpc-targets.ts`/`itx/utils.ts` + `spikes/capability-fallthrough`,
  2026-08-04.)
  - **Built-in capabilities = typed `RpcTarget` getters** (`itx.streams`/`kv`/`secrets`/`egress`/`ai`),
    resolved _in the isolate_, pipelined natively. Userspace CANNOT shadow a built-in name
    (`rejectBuiltinCollision`).
  - **Dynamic (userspace) capabilities = a `path: string[]`** mounted by `provideCapability(input)` (event-
    sourced `capability-provided` events on the scope's stream — NOT KV) and dispatched by ONE generic
    `invokeCapability({ path, args })`. The dotted sugar `itx.a.b(x)` compiles via a **prototype hop** (not an
    instance Proxy — workerd#6873 brand check; our spike reproduced the crash) to that one call, pipelined.
  - **Asymmetry: reads fall back, writes stay local.** `invokeCapability`/`egress` follow `fallback`;
    `provideCapability` always mounts on the host you called.
  - **BYO-KV (Jonas: "swap out `env.KV` behind `itx.kv`") = a CONFIG-TIME backing choice** (`defaults.kv` in
    `APP_CONFIG` → `env.KV` vs an external `KvEntrypoint`), NOT a runtime capability-table override. The data
    model makes it possible via config, keeping the two mechanisms separate.
- **D30 — The `fallback` (renamed from `parent`; apps/os's real field name).** (Jonas, 2026-08-04: "why
  `parent` and not `fallback`/`super`?") A scope delegates OUTWARD to its `fallback` (a `CapabilityHost` stub,
  local or remote). `super` is the mental model but a JS keyword; `fallback` is what apps/os already calls it.
  The `Fallback` contract = `{ invokeCapability(callPath,args); + egress delegation }`. Solo swaps the one
  `env.CONTROL_PLANE` binding for a `DummyControlPlane` implementing it trivially (see D26/D29).
- **D31 — TWO path types + `callPath` = itx-expression string; mounts can be aliases (PROPOSED by Jonas,
  2026-08-04; one open tension).** `callPath` (an itx expression, `` `itx.${string}` ``) addresses a capability
  CALL — vs `streamPath` (`` `/${string}` ``) which is a resource path _inside_ a collection
  (`itx.streams.get(streamPath)`). `invokeCapability(callPath, args)` / `provideCapability({path: callPath, …})`.
  A mount is `live` (a stub) OR **`itx-expression`** (an ALIAS to another expression, merging apps/os's
  itx-expression type + a rudimentary `"itx.a.b.method('arg')"` parser). ONE mechanism yields shortcuts
  (`itx.appendToMainStream` → `itx.streams.get('/x').append`) AND built-in overrides (`itx.streams.get('/bla')`
  → your cap; BYO-KV via `itx.kv` → `itx.externalKv`) — subsuming D28's config-time-backing idea into "config
  installs trusted default mounts; userspace adds more." **OPEN TENSION (the core's last design question):**
  declared built-in getters win before the prototype hop and pipeline natively — so overrides only fire if each
  built-in consults the mount table, or the whole surface routes through `invokeCapability`; and
  `rejectBuiltinCollision` must relax to allow deeper-expression overrides. Not yet locked.
- **D32 — The capability host DO needs a NATIVE `fetch(request)`, a special case NOT dispatched via
  `invokeCapability`.** (Jonas, 2026-08-04.) A WebSocket upgrade (101) can only be returned from a handler
  named `fetch`, and a 101 can't cross an RPC boundary — so the stateless edge calls `host.fetch(request)`
  DIRECTLY for ingress + WS upgrades, and `ctx.acceptWebSocket()` (the wake socket, spikes 3-4 / PR #2386)
  attaches inside it. Distinct from the egress capability `itx.egress.fetch` (outbound HTTP through the
  fallback chain). Two fetches; don't conflate. (Consistent with [[project_websocket_dynamic_apps]] — WS can't
  cross RPC hops.)
- **D33 — MILESTONE: prove a WS-upgrade-capable fetch through the WHOLE stack FIRST (the walking skeleton).**
  (Jonas, 2026-08-04: "test quite early that a 'proper' fetch … with websocket upgrades … all the way through
  the whole stack.") Because a 101 can't cross an RPC hop, every fetch hop must be a native `.fetch()`
  (service-binding / DO-stub, both WS-capable), never `invokeCapability`. Two paths to prove: **ingress**
  (browser `wss://` → edge → `PROJECT_WORKER.fetch` → `ITX_HOST.get().fetch` → `ctx.acceptWebSocket()`) and
  **egress** (confined agent WS → `globalOutbound` → `itx.egress.fetch` → `fallback.fetch` → terminal). FOUR
  risk points to verify: (1) Worker Loader `globalOutbound` carries a WS upgrade; (2) service-binding `.fetch()`
  preserves WS; (3) DO-stub `.fetch()` preserves WS in our wiring; (4) egress secret-substitution middleware
  passes `webSocket`+101 through without touching the body. Any failure → the architecture changes. This is
  Step A's first target, before the capability model is built on top.
  - **✅ PROVEN 2026-08-04** on the POC account (`project-worker.iterate.workers.dev`, solo mode). Ingress WS
    (edge → DO-stub `.fetch` → `acceptWebSocket` → echo) AND egress WS (confined agent → `globalOutbound` →
    `EgressEntrypoint` → `DummyControlPlane` loopback → terminal → external echo, round-tripped) both green.
    All four risk points hold — incl. #4: with a real KV secret bound, the egress middleware rewrites the
    `Authorization` header on a WS-upgrade request AND the 101 still flows. Code: `apps/project-worker/src/`
    (`itx-durable-object.ts`, `worker.ts`, `core/egress.ts`, `core/config.ts`) + `WALKING-SKELETON.md`.
    **Platform facts learned:** outbound WS = `https://` URL + `Upgrade` header (not `ws://`); a worker can't
    WS its own hostname (loop protection); a no-props `ctx.exports.X` loopback stub is used directly as a
    Fetcher (calling it with args throws). NOT YET committed (awaiting Jonas per standing rule).
- **D34 — ONE npm package for the clean room; NO `packages/itx`. (Jonas, 2026-08-04.)** Reverses D26's
  `packages/itx` + separate-apps split: "have everything in one npm package still, like the control plane and
  the project worker — it's just easier." The whole clean-room lives in **one package** whose `src/` holds the
  shared core (`itx-durable-object.ts`, `stream-durable-object.ts`, `core/*`) AND both worker entrypoints
  (`worker.ts` = the project worker/inner core; `control-plane-shell.ts` = the shell), each deployed via its
  own wrangler config (`wrangler.jsonc`, `wrangler.control-plane.jsonc`). Both workers import the same core
  modules directly — the "write code the same way inner and outer" ideal (D26) achieved WITHOUT a package
  boundary. (Implemented as `apps/project-worker` across increments 1–11.) Resolves target-core §8 open Q #1.
- **D35 — Stateful dynamic workers = a DEDICATED runner DO (apps/os `StatefulWorkerDurableObject`), NOT a facet
  of the host; facet method RPC is NATIVE (`replayPath`), like apps/os — no fetch tunnel. (proven, increment 14,
  native 2026-08-05.)** The clean room mirrors apps/os's stateless/stateful `DynamicWorkerRef` split:
  **stateless** = a repo fn loaded per call (the `code` mount, content-addressed, no identity); **stateful** = a
  repo `DurableObject` class run by a **dedicated runner DO** (one instance per stateful capability, named
  `{projectId}::{path}::{callPath}`, hosting the user's class DIRECTLY as a facet `"target"` with its own
  isolated SQLite, abort+recreate on source change). The host forwards by name — a stateful worker is its own
  durable actor, so it gets its own DO, not a facet crammed into the per-context host. **(First cut wrongly made
  it a facet of the host DO — Jonas corrected this.)** **Facet-method RPC works natively; the earlier _"facet
  stubs cannot be transferred between Workers"_ (`DataCloneError`) was OUR bug, not an account/entitlement issue
  (same account `04b3` = apps/os prod).** Cause: we invoked via `facet[method].apply(facet, args)` — reading
  `.apply` off an RPC stub's method proxy is a capnweb pipelined remote path that serializes the facet stub,
  which a dynamically-loaded facet stub may never do (workerd `requireAllowsTransfer()` throws unconditionally
  for dynamic entrypoints). Fix = apps/os's `replayPath` exactly: `Reflect.apply(Reflect.get(facet, m), facet,
args)` — invokes `[[Call]]` directly, runs inside the owning DO, returns plain data, never serializes the
  stub. Binary-verified on one deployment: `fn.apply`→`NATIVE_FAIL`, `Reflect.apply`→`NATIVE_OK`. The
  `__HostedActor`/`/__itx_rpc` wrapper is deleted; WS/streaming lane = `/facet` → runner → the user class's own
  `fetch` (a Response passes by value). Loader cacheKey now folds in `CF_VERSION_METADATA.id` (`version_metadata`
  binding), mirroring apps/os so a redeploy mints a fresh loaded isolate (prevents a stale-isolate transfer
  error across rollouts — a real latent bug, not the native cause). Writeup:
  `apps/project-worker/FACET-RPC-INVESTIGATION.md`. **Follow-up DONE (2026-08-06): every dynamic worker gets
  `env.ITX`.** The stateful facet now gets `env.ITX` + `globalOutbound` = a stub to its OWNING capability host
  (reconstructed from the runner's `{projectId}::{path}::{callPath}` name) + an injected `itx.js`, exactly like
  the stateless `code` cap and the confined `load` agent — so a hosted `DurableObject` reaches sibling
  capabilities via `this.env.ITX.invokeCapability(..)`/`itxFromStub`. Mirrors apps/os (`env.ITX =
  ctx.exports.ItxEntrypoint({props})`). Proven (`itxbind-1`): `Counter.whoAmI()`→ correct `projectId`, a
  round-trip through `itx.kv` shows facet + host share the project store, and a second project's facet reaches
  its OWN host (isolation). (Deferred: facet alarms — workerd#6810.)
- **D36 — A dynamic worker's SOURCE is an itx EXPRESSION (data); the loader is repo-agnostic. (proven,
  increment 15, `itxexpr-1`.)** A mount's `code`/`stateful` kind carries `source: ItxExpression` (`(string |
[method,...args])[]`, mirroring apps/os `ItxExpression`), not a file path. The loader resolves it by
  `evaluateItxExpression(itxRoot(invoke), source)` → a `{ name: source }` modules map → `LOADER.get` — it knows
  only "evaluate an expression to get modules," never "repo." The expression is a small two-way codec
  (`core/itx-expression.ts`, ~55 lines: capture=encode, evaluate=decode via `Reflect.get`/`Reflect.apply`;
  reads+calls only, JSON args; pipelining deferred). Behind the expression, a built-in **file reader**
  (`itx.files.read`) returns the modules; v1 PROVIDES a hello (no repo/KV — since the clean room doesn't bundle,
  there's nothing expensive to cache, so no level-2 artifact cache; the real repo-at-a-ref reader slots in
  behind the same capability + expression later). The stateful runner **dropped `ITX_KV`** — it resolves source
  through the host (`env.ITX`) like everything else. Two caches, apps/os-shaped: level-1 = the loader isolate
  cache (deploy-version + content-hash); level-2 (build artifact) intentionally absent until there's a bundler.
- **D37 — WebSocket upgrades pass THROUGH the capability graph via a FETCH LANE, addressed by a serialized
  `ItxExpression` in a header. (proven, increment 16, `wscap-1`.)** `invokeCapability` (RPC) can't carry a 101;
  its sibling `#fetchCapability` forwards a `Request` to a FETCH-SHAPED capability via native `.fetch()` hops, so
  a WS upgrade rides through. A request carrying `x-itx-cap` (a serialized `ItxExpression` or a bare callPath) is
  routed FIRST, before ingress-echo. Fetch-shaped kinds: a new `web` mount (a dynamic worker default-exporting
  `{ fetch }`, loaded + `worker.getEntrypoint().fetch(request)` — its `accept()`ed 101 flows back out natively)
  and a `stateful` facet (its `/facet` fetch). Alias re-resolves; a deep path falls back to its PARENT PATH (a
  native DO→DO fetch — 101 survives). **This is what apps/os cannot do** (its quarantined
  `live-capability-websocket.e2e.test.ts` pins `Could not serialize object of type "WebSocket"` — a provided cap
  is reachable only by RPC replay). apps/os keeps a WS-capable fetch lane (`x-iterate-worker-dispatch`)
  physically separate from the capability tree and carries a build **ref**; the clean-room advance is that the
  capability **address** itself (an `ItxExpression`, now string-serializable) rides the header — one lane. **Open
  (D37-next):** a WS to an EXTERNAL live capnweb provider (ESP32/Pi) needs a **frame bridge** (browser WS frames
  ⇄ capnweb messages) — a 101 can't cross capnweb natively; the same `x-itx-cap` routes to the bridge.
- **D38 — Clients & connections: the principal attach operation is `.connect`. (proven, increment 17,
  `clients-1`.)** A **client** = a caller-chosen `path` (also its stream address) with **0..N connections** (an
  array). `.connect(info, capabilities?, inbox?)` (a capnweb method on `/connect`) attaches one: `capabilities`
  = a retained `RpcTarget` (the itx half, FANNED OUT over the client's connections via `Promise.all`), `inbox` =
  a retained `processEventBatch(batch)` stub (the stream half); both optional, both die with the socket.
  `exclusive` pins a fixed connectionKey → reconnect knocks out the old (`replaced`). The runtime table
  (`#clients` on the project ROOT host) is authoritative for "open now" + holds the live stubs; presence facts
  (`client/connection-opened`/`closed`) land on the client's OWN stream; death = `onRpcBroken`. itx surface (flat
  v1): `itx.clients.list` / `get(path)` / `call(path, capPath[], args)` (fan-out) / `append(path, event)` (+push
  to inboxes). **Built by COMPOSITION** on the existing capnweb/live-mount/wake substrate — the design's
  apps/os-shaped stream-`openConnection` + processors + collections aren't in the clean room yet. **Deferred:**
  the reduced-state `ClientProcessor` + `ClientCollectionProcessor` roster (needs the processor spine — v1 reads
  the runtime table, authoritative for liveness); full stream-wide push delivery (v1 delivers on
  `itx.clients.append`); the pipelined `itx.clients.get(path).capabilities.x.y()` ergonomic surface. Decisions
  followed: capabilities = RpcTarget not fetch door (Q11); per-connection description (Q3); `[]`+`Promise.all`
  (Q4); exclusive (Q6); shared `/clients/browser` + `user` in `openedBy` (Q7).
- **D14 — Cost/billing is USERSPACE, not a control-plane primitive.** Budgets/spend limits are a key PRODUCT
  concern but implemented in userspace: a **stream processor that consumes cost-bearing events** across
  streams and computes spend/budget. Can live on the product shell (for now), or the project shell (as a core
  feature), never really the control plane. **Self-host = YOLO, don't track money** (you can run the innermost
  project alone). (Jonas.)
