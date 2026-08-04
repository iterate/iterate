# Red-team 5 — SECURITY / AUTHORITY / CONFINEMENT / SHADOWING

Adversarial review of the uniform-capability-host design in
`spikes/capability-fallthrough/` (`capability-host.mjs`, `graph.mjs`, `gateway.mjs`) and the
jam that specifies it (`apps/os/docs/simplification/wayfinder/jam-capability-provision.md`,
esp. §4 "full shadowing on purpose; risk parked"). Domain: how an **attacker** breaks
confinement.

**Bottom line up front:** the design as spiked is _wide open_ — not "parked risk," but an
absent authority model. I wrote a PoC (`redteam-poc.mjs`, runs against the spike's own graph +
transport) and **all six attacks land against a peer holding nothing but an unauthenticated stub
to the project host.** Run it:

```
cd spikes/capability-fallthrough && node redteam-poc.mjs
```

```
ATTACK LANDS  1. resolve('egress') hands back the control-plane's egress stub
ATTACK LANDS  2. bottom layer resolves iterate.* mounted 2 layers up
ATTACK LANDS  3. provide('auth', always-yes) is callable UNAUTHENTICATED over RPC
ATTACK LANDS  3b. setParent(attacker) is callable UNAUTHENTICATED over RPC
ATTACK LANDS  4a. provide() shadows the parent's egress (local mount wins)
ATTACK LANDS  4b. setParent() MITMs every unresolved capability
```

The load-bearing facts these rest on (evidence, once, so each theory can cite them):

- **F1 — every public method of a `CapabilityHost` is wire-callable, no auth.**
  `resolve`, `provide`, `setParent`, `whoami` are ordinary public methods on an `RpcTarget`
  subclass (`capability-host.mjs:35-73`). capnweb's server-side `followPath` (dist
  `index.js:734-738`) evaluates `value[part]` on an `rpc-target`: own instance props throw, but
  **any prototype method or getter is returned and callable**. There is no allowlist. The spike
  has literally zero `if (caller is authorized)` anywhere in the host.
- **F2 — property access _is_ `resolve()` server-side.** Unknown-member access routes through the
  `fallthroughProto` proxy's `get` → `receiver.resolve(prop)` (`capability-host.mjs:83-88`), and
  `resolve` climbs `this.#parent.resolve(name)` on any miss (`:65-73`). So `remote.egress` and
  `remote.resolve("egress")` are the same authority, and both walk the whole ancestor chain.
- **F3 — the door is cross-origin and unauthenticated by construction.** `newWorkersRpcResponse`
  "accepts cross-origin requests" and sets `Access-Control-Allow-Origin: *`; security "rests
  entirely on in-band authorization" (dist `index.js:3425-3435`). WS upgrades always permit
  cross-site (no Origin check anywhere in the entry path). `gateway.mjs:41` hands
  `projectHost(env)` **directly** as the capnweb main — no `authenticate()` gate at all.
- **F4 — capnweb is object-capability: a received stub is fully usable and re-delegable.** README
  §"map" line 326: _"a malicious peer can use these stubs for anything, not just calling your
  callback."_ Stubs pass **by reference** (`typeForRpc` → `"rpc-target"`, dist `:63-70`); if Alice
  receives a stub she can hand it to Carol. `resolve()` returns `hit.cap.dup()`
  (`capability-host.mjs:68`) — a duplicate that stays alive until _all_ dups are disposed (README
  §"Duplicating stubs"), and capnweb has **no cross-connection GC** (jam §6).

---

## Ranked attack theories

### 1. (CRITICAL) The capability-layer mutators are public and unauthenticated over the wire

- **Attacker capability:** an RPC stub to any capability host (i.e. anyone who reaches `/api`, or
  any worker/DO with the host binding). No credential.
- **Exploit path:** call `host.provide(name, evilStub)`, `host.setParent(evilStub)`,
  `host.resolve(name)`, `host.whoami()` directly. F1 says they're just methods; there's no
  `authorize()` in front of any of them.
- **Evidence:** `capability-host.mjs:40-73` (no auth); PoC attacks 3/3b/4a return `true`/mutate.
  `provide`/`setParent` are _mutators of server-side authority state_ exposed with the same
  visibility as a read.
- **Severity:** CRITICAL. This is the master defect — provisioning (a trust-boundary operation)
  and using are the same surface.
- **PoC:** done — `redteam-poc.mjs` attacks 3, 3b.
- **Mitigation:** provisioning must **not** be reachable on the tenant-facing host at all. Split
  the class: a tenant gets a _use-only_ facet (resolve-of-granted-names, nothing else); `provide`
  /`setParent`/mount-table mutation live on an inside-the-trust-boundary control facet the CP
  holds and the tenant never receives. "No guards on provide" is not survivable for untrusted code.

### 2. (CRITICAL) Unbounded upward resolution = confused deputy / privilege escalation up the chain

- **Attacker capability:** a stub to the bottom (project) host — the layer that "eventually runs
  untrusted user code."
- **Exploit path:** `resolve(name)` on a miss does `this.#parent.resolve(name)` with **no ACL, no
  namespacing, no per-consumer scoping** (`:65-73`). The project therefore resolves the _union of
  every capability every ancestor holds_, by name: `egress` (CP), `iterate`/`flavor`/`brandName`
  (mounted two layers up), and — the moment the CP mounts them — `auth`, `directory`, `secrets`,
  `kv`, `db`, admin. The `#parent` field is private, but `resolve()` is a public oracle over it,
  so "the parent stub is an upward authority reference" is fully realized: holding the child grants
  the parent's authority.
- **Evidence:** PoC attack 1 (`resolve('egress')` from the project returns the CP's egress stub and
  fetches with it) and attack 2 (`project.iterate.flavor.flavorPrompt()` + `resolve('brandName')`
  reach a capability mounted two layers up). This is the design's _headline demo_ (`graph.mjs:69`,
  `runDemo`) — the intended feature and the vulnerability are the same line.
- **Severity:** CRITICAL. Least-privilege is inverted: authority is monotonic _upward-union_,
  reachable from the least-trusted layer.
- **PoC:** done — attacks 1, 2.
- **Mitigation:** resolution must be **downward-only and per-consumer-scoped**. The parent must not
  be a blanket `resolve(anything)` oracle; replace it with an explicit grant table keyed by _which
  child_ is asking (the child's identity must be bound to the stub it holds, not passed as an
  argument). A capability a child was never granted must be unreachable _by name_, not merely
  undocumented.

### 3. (CRITICAL, conditional) One shared capability-host DO + full shadowing = cross-tenant poisoning

- **Attacker capability:** one malicious/compromised project among many tenants.
- **Exploit path:** the jam **locks** "initially just route everything through a durable object …
  a capability-host DO is the single source of truth _and_ the resolver" (§4, "One DO now"). If
  that DO is shared across projects and `provide`/`setParent` mutate it (F1), a tenant can
  `provide()` a shadow that a _sibling_ then resolves, or `setParent(evil)` to swing the shared
  fallthrough. Combined with theory 2, one tenant poisons the authority every other tenant reads.
- **Evidence:** jam §4 "One DO now"; §2a "everything through one DO." The spike **hides** this —
  `gateway.mjs` builds a _fresh_ graph per `/api` request (`buildGraph` at `:24`), so per-connection
  isolation is accidental, not designed. The spike proves pipelining, **not** isolation; nothing in
  it exercises shared mutable authority.
- **Severity:** CRITICAL if the "one DO" plan is taken literally with untrusted tenants.
- **PoC:** partial — attacks 4a/4b prove `provide`/`setParent` change resolution semantics in the
  shared host class; a two-tenant harness against one shared instance would make it total.
- **Mitigation:** per-tenant host instances; a tenant's shadowing confined to its own subtree; no
  tenant may ever write a mount another tenant or an ancestor reads. If the DO is shared, the mount
  table must be partitioned by tenant with writes authorized by tenant identity.

### 4. (HIGH) `egress` is ambient control-plane authority, freely re-delegable (capability leak → SSRF + secret exfil)

- **Attacker capability:** untrusted project code that legitimately holds `egress`.
- **Exploit path:** `Egress` performs the real outbound call and comments that a real CP "would
  substitute secrets / origin-pin here" (`graph.mjs:34-37`) — i.e. egress carries the CP's outbound
  identity + secrets. By F4 the project can (a) hand the egress stub to a third party (a browser it
  serves, another account, the Pi) who then makes CP-privileged, secret-bearing requests the CP
  never authorized, and (b) drive SSRF into CP-internal origins. `resolve()` returns a `dup()`
  (`:68`) so the leaked handle outlives the request and — no cross-connection GC (F4) — is never
  reclaimed.
- **Evidence:** PoC attack 1 fetched `https://victim.internal/exfil` through the CP egress stub and
  got the (stand-in "SECRET") body back. README §326 + `:63-70` establish re-delegation.
- **Severity:** HIGH (CRITICAL once egress actually injects platform secrets).
- **PoC:** attack 1 is the SSRF half; the re-delegation half is a 3-party capnweb harness (hand the
  resolved stub to a third session) — cheap to add.
- **Mitigation:** attenuate at provision — per-project origin allowlist, no shared secret embedded in
  a passable stub, membrane-wrap so the handle is revocable and non-re-delegable. Ambient authority
  handed to untrusted code over an object-cap transport is inherently leaky; attenuate or don't hand
  it over.

### 5. (HIGH) Cross-origin, unauthenticated WebSocket exposes the host to any web page

- **Attacker capability:** any origin that can load JS in a victim's browser, or any internet host.
- **Exploit path:** open a WS to `/api`; capnweb accepts cross-site with `ACAO:*` and no Origin
  check (F3). In the spike you immediately get `provide`/`setParent`/`resolve` on the project host
  (theories 1-2). Cookies don't help the defender _or_ the attacker here: `ACAO:*` blocks credentialed
  reads and SameSite=Lax won't ride a cross-origin WS — so the real CP's cookie auth
  (`session.ts`, `SameSite=Lax`) contributes nothing over this door; only _in-band_ auth counts.
- **Evidence:** dist `:3425-3435`; `gateway.mjs:41` hands the raw host as `localMain` with no
  in-band gate. The real CP (`app.ts:255`) does it right — `new Os(request,env)` + `authenticate()`
  — but the jam's model wants the _project host itself_ to be the navigable thing, and that host
  exposes mutators.
- **Severity:** HIGH.
- **PoC:** the spike's `run-workerd.mjs` Test 1 already connects a browser-equivalent WS client and
  drives the host; point `redteam-poc.mjs`'s attacks at that session to weaponize.
- **Mitigation:** never expose a capability host as `localMain`; always front it with an
  `authenticate()` that returns an already-scoped, use-only facet. Add an Origin allowlist for
  browser callers even so.

### 6. (HIGH) Identity ≠ capability authorization — no second gate behind `authenticate()`

- **Attacker capability:** any authenticated-but-low-privilege caller (e.g. anonymous, which
  `Os.authenticate()` grants first-class: `api.ts:110`).
- **Exploit path:** `authenticate()` establishes _who_ you are, but `resolve(name)` never consults
  that identity — it resolves by name up the chain regardless (theory 2). So even with the real CP's
  door in place, once you reach the project shell every capability is name-addressable with no check
  that _this_ caller may hold _that_ capability. The gate answers "who," the capability layer needs
  "may this who have this cap," and that check does not exist.
- **Evidence:** `resolve` (`:65-73`) takes only a name; no `caller`/`session` parameter anywhere.
  Compare `api.ts:51-58` where `projects.get()` _does_ gate on `dir.access(...)` — the capability
  host has no equivalent.
- **Severity:** HIGH — it makes the door's auth cosmetic for anything behind it.
- **Mitigation:** bind caller identity to the facet at `authenticate()` time and have every resolve
  consult a per-caller grant set (see theory 2 mitigation). Note the existing `api.ts` comment
  admits grants are "still a known gap … a key inherits its owner's directory authority" — the
  capability layer widens that gap.

### 7. (HIGH) `setParent` has no `dup()` → any peer can permanently brick a host's fallthrough (DoS)

- **Attacker capability:** a stub to the host.
- **Exploit path:** `provide()` dups live stubs to survive param-disposal (`:54`) but `setParent()`
  does **not** (`:40-43`) — it stores the raw param. capnweb disposes a callee's param stubs when the
  call completes (README §"Automatic disposal"), so after a remote `setParent(x)` the stored
  `#parent` is a **disposed** stub; every subsequent miss throws `This RpcImportHook was already
disposed`. One unauthenticated call blackholes all fallthrough. On the shared DO (theory 3) that's
  cross-tenant DoS.
- **Evidence:** observed live — the first `redteam-poc.mjs` run (before I worked around it) failed
  attack 3 with exactly `Error: This RpcImportHook was already disposed.` The inconsistency between
  `provide` (dups) and `setParent` (doesn't) is right there at `:40` vs `:54`.
- **Severity:** HIGH for availability (trivial, unauthenticated, persistent).
- **Mitigation:** irrelevant once `setParent` is removed from the tenant surface (theory 1); if kept
  anywhere, it must `dup()` and be authorized.

### 8. (MEDIUM) Leaked/dup'd stubs outlive sessions and pin DOs (no cross-connection GC)

- **Attacker capability:** any holder of a resolved capability.
- **Exploit path:** `resolve` returns `dup()`s (`:68`); retain and/or re-delegate them (F4). With no
  cross-connection GC (jam §6), the underlying targets — and the DOs backing them — stay resident
  indefinitely. This both (a) keeps leaked _authority_ live past the session that should have bounded
  it and (b) is a resource-exhaustion / cost-amplification lever (pinned DOs, the exact "never
  hibernates" pin the jam frets about in §0/§2d).
- **Evidence:** `:68`; README §"Duplicating stubs"; jam §6 "no cross-connection GC."
- **Severity:** MEDIUM (authority-lifetime + availability/cost).
- **Mitigation:** capability handles must be revocable (membrane with a kill switch) and their
  lifetime bound to an explicit grant, not to stub GC.

### 9. (MEDIUM) `has() => true` + resolve-by-name = capability enumeration despite no list API

- **Attacker capability:** a stub to the host.
- **Exploit path:** there's no `list()`, but the proxy's `has() => true` (`:89-91`) makes every name
  look present and `resolve(name)` climbs the chain, so an attacker brute-forces guessed names —
  `secrets`, `admin`, `directory`, `db`, `kv`, `platformSecrets`, `auth` — and anything that exists
  _anywhere up the chain_ resolves. No deny-by-default; discovery is free.
- **Evidence:** `:89-91`; theory 2.
- **Severity:** MEDIUM (amplifies 2/6 by removing the need to know names).
- **Mitigation:** deny-by-default per-caller grant table; a non-granted name must reject identically
  whether or not it exists (no oracle).

### 10. (MEDIUM) No runtime type checking on `provide`/`resolve` (README warns) — type confusion & name collisions

- **Attacker capability:** a caller that can reach `provide`.
- **Exploit path:** `provide(name, cap, kind)` validates nothing (`:51-57`). `kind` is attacker-set:
  provide a plain value as `"live"` (no `.dup`, stored raw, later returned as if a live stub) or a
  stub as `"static"` (returned by-copy semantics confused). Names can be non-strings (numbers key the
  Map fine). Capability names that collide with a real method (`provide`, `resolve`, `whoami`) or an
  `Object.prototype`/`RpcTarget.prototype` member are silently unresolvable-as-capabilities (the
  proxy's `Reflect.has(target,prop)` short-circuits, `:85`) — a namespace footgun a shadow can
  exploit to make a cap _appear_ unbindable.
- **Evidence:** `:51-57`, `:85`; README repeatedly warns "no runtime type checking."
- **One thing that IS safe (state it plainly):** classic prototype-pollution is **blocked** —
  `#caps` is a `Map` (immune to `__proto__` keys) and capnweb's `followPath` neutralizes any
  `Object.prototype` name to `undefined` before dispatch (dist `:720-722`), while `constructor` is in
  `RESERVED` (`:19-22`). So `__proto__`/`constructor`/`prototype` injection through the wire does
  _not_ pollute. Don't waste mitigation budget there.
- **Severity:** MEDIUM.
- **Mitigation:** validate `name` (string, charset), `kind` (enum), and reject names colliding with
  machinery.

### 11. (MEDIUM, latent) `.map()` record-replay captures privileged stubs for the peer

- **Attacker capability:** any peer you send a `.map()` callback to.
- **Exploit path:** the streams-as-capabilities direction (jam §2c, "consumer registers a sink,
  provider pushes batches") and any pipelined convenience over the boundary invite `.map()`. README
  §326 is explicit: stubs _captured_ by the callback "will be sent to the peer" and "a malicious peer
  can use these stubs for anything, not just calling your callback." So a first-party helper that
  `.map()`s with a callback closing over an `egress`/`secrets`/parent stub hands that authority,
  fully usable, to the untrusted side.
- **Evidence:** README §"map" 313-326; jam §2c push/pull hybrid.
- **Severity:** MEDIUM (latent — depends on whether first-party code uses `.map()` across the
  boundary; the design's streaming plans make it likely).
- **Mitigation:** forbid `.map()` callbacks that capture privileged stubs across the trust boundary;
  lint/review rule; prefer explicit attenuated handles.

### 12. (MEDIUM) Same mutators exposed across the NATIVE Workers-RPC boundary to co-tenant workers

- **Attacker capability:** any worker/DO with the `HOST_DO` binding (co-tenant, or a compromised
  first-party worker).
- **Exploit path:** `gateway.mjs:51` — `env.HOST_DO.getByName("singleton").project()` returns the
  host over native RPC; the caller pipelines `.setParent()/.provide()/.resolve()` exactly as over
  capnweb (native RPC exposes public prototype methods; `RpcTarget` is the same class per jam §6).
  `"singleton"` = a **shared** instance, so this is theory 3 over the native transport.
- **Evidence:** `gateway.mjs:50-54`; jam §6 "capnweb's `RpcTarget` _is_ the `cloudflare:workers` one."
- **Severity:** MEDIUM (needs the binding, but the binding is same-account trusted-ish — still, F1
  means no defense-in-depth if that worker is compromised).
- **Mitigation:** as theories 1/3 — no mutators on the returned facet; per-name DO, not a singleton.

### 13. (LOW) `whoami` is an unverified self-report — host-identity spoofing

- **Attacker capability:** anyone who can `provide`/`setParent` a host.
- **Exploit path:** a host's identity is a constructor string returned by `whoami()` (`:35-37`);
  nothing binds it to anything verifiable. A shadowed or attacker-supplied host can claim
  `whoami() === "control-plane"`, so any code that trusts `whoami` to decide trust is spoofable.
- **Evidence:** `:35-37`.
- **Severity:** LOW (only bites if `whoami` is used for authorization — don't let it be).
- **Mitigation:** never authorize on `whoami`; identity must come from the transport/grant, not the
  object's self-description.

---

## Is "full shadowing with no guards" survivable? What's the minimum before untrusted code?

**Shadowing itself is the _least_ dangerous part of this design.** A local mount beating a parent
mount (`resolve` checks `#caps` first, `:66-70`) is fine _if_ hosts are per-tenant and resolution is
downward-only — a tenant shadowing _its own_ view of `egress` only hurts itself. What is _not_
survivable is the combination the spike actually ships:

1. **Mutators (`provide`/`setParent`) are wire-reachable and unauthenticated** (theory 1). Fatal.
2. **Resolution climbs the parent chain and returns any ancestor capability by name, with no
   per-caller scope** (theories 2, 6, 9). Fatal — this is the real "upward authority reference."
3. **A single shared host across tenants** (theories 3, 12). Fatal at multi-tenant scale.

Mandatory guardrails before _any_ untrusted project code touches this — none optional:

- **G1. Two facets, not one class.** Tenants receive a **use-only** facet (resolve-of-granted-names).
  `provide`/`setParent`/mount-mutation live on a control facet the CP holds and never hands down.
- **G2. Downward-only, per-caller-scoped resolution.** No blanket parent `resolve(name)` oracle.
  Caller identity is bound to the facet at `authenticate()` time (not passed as an argument), and
  every resolve consults an explicit grant set. Non-granted names reject _identically_ whether or not
  they exist.
- **G3. Per-tenant host isolation.** Never one shared mutable DO across tenants; shadowing confined to
  the tenant's own subtree; no tenant write is visible to another tenant or to an ancestor.
- **G4. Attenuated, revocable, non-re-delegable ambient authority.** `egress`/`secrets`/`auth` are
  membrane-wrapped, origin/scope-limited, and revocable — because capnweb _will_ re-delegate any
  stub you hand out (F4), and dup'd handles outlive the session with no GC.
- **G5. In-band auth at the door + Origin allowlist.** Never expose a host as `localMain`; front it
  with `authenticate()` returning an already-scoped facet.

With G1-G5, "shadowing anywhere" is safe _because_ shadowing can no longer reach across a tenant
boundary or up the authority chain. Without them, "risk parked" means "unauthenticated total
compromise shipped."

---

## Top 3 scariest (return value)

1. **Unauthenticated capability mutators over the wire** (theory 1) — `provide`/`setParent`/`resolve`
   are public `RpcTarget` methods with no auth; anyone holding the host stub owns it. PoC: attacks 3/3b.
2. **Unbounded upward resolution on a shared DO** (theories 2 + 3) — `resolve(name)` climbs the parent
   chain and returns _any_ ancestor capability by name with no per-caller ACL; the design's own demo
   is the exploit, and the locked "one shared DO" turns it cross-tenant. PoC: attacks 1, 2, 4.
3. **`egress` = re-delegable ambient CP authority** (theory 4) — a secret-bearing outbound capability
   handed to untrusted code over an object-cap transport that lets it be passed to any third party,
   dup'd, and never GC'd → SSRF + secret exfil. PoC: attack 1 (SSRF half).

Survivable only with: two facets (mutators off the tenant surface), downward-only per-caller-scoped
resolution, per-tenant isolation, and attenuated/revocable ambient authority. Shadowing is fine;
_"no guards on resolve/provide/parent"_ is not.
