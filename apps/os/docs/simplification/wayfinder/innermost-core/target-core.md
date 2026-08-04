# Target clean-room core — files, responsibilities, and the actual APIs

The **smallest core** that embodies everything we decided (the capability host — `provideCapability` +
`invokeCapability` + capability paths + a `fallback`; two run modes), plus the deployment modes it unlocks —
crucially a **solo headless project worker** as the inner core.

This mirrors the capability host we already proved — `spikes/capability-fallthrough`,
`spikes/capnweb-pipelining` — and apps/os (`rpc-targets.ts`). It is **not** a new resolver.

Answers: files/responsibilities/APIs → §2–§4; is Stream part of this? → §5; auth + solo/self-host/hosted → §6;
~1000 lines? → §7. Annotate freely.

---

## 1. The shape in one breath — **two workers, and a solo inner core**

**The inner core is a single project worker — deployable with NO control plane at all.** Headless: no browser
app, no auth of its own. It still exposes `itx.auth`, but its `fallback` (config) points at a
**`DummyControlPlane` loopback entrypoint the project worker exports itself** — so solo is genuinely one worker,
nothing else to deploy. That is the innermost thing, and it's what tests and headless deployments run.

Wrap it in the control plane and you get the product:

```
 ┌─ control-plane worker ── core + identity module ── D1 directory, OAuth AS, login, routing,
 │     fallback of ↓                                   first-party keys + metering (hosted only, config-gated)
 └─ project-worker ──────── core (the inner core) ──── runs userspace code confined
       fallback → env.CONTROL_PLANE, OR → its own DummyControlPlane loopback entrypoint when solo
```

- **Product folded into control-plane** (your call): no separate product worker. First-party keys + metering
  are a **config-gated module** inside the control plane — on when hosted, off when self-hosted.
- **Same core code in both workers.** control-plane = core + an `identity/` module; project-worker = just the
  core. "Write code the same way in outer and inner layers," literally.
- **Three deployment modes, one code, config-only differences:**

  | Mode                  | Workers             | project-worker's `fallback`                                     | first-party keys |
  | --------------------- | ------------------- | --------------------------------------------------------------- | ---------------- |
  | **Solo (inner core)** | project-worker only | `{ via:"loopback-entrypoint", entrypoint:"DummyControlPlane" }` | none             |
  | **Self-hosted**       | + control-plane     | `{ via:"service-binding", binding:"CONTROL_PLANE" }`            | off              |
  | **Hosted (Iterate)**  | + control-plane     | `{ via:"service-binding", binding:"CONTROL_PLANE" }`            | on (config)      |

- **ONE shared `STREAM_DO`/`SECRET_DO`/`ITX_HOST` namespace** across both workers — defined once (migrations in
  project-worker), cross-script-bound into control-plane (§5). Scope = which names each shell can construct.

> **Terminology locked:** `fallback` (not `parent`). Bonus — **apps/os already calls this field `fallback`**
> (the scope's birth-certificate `fallback`), so this is the existing name, not a coinage.

---

## 2. The shared core (`packages/itx/src/`) — the ~1000 lines

| File                       | Responsibility                                                                                                                                                                                                            | ~LOC      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `names.ts`                 | Re-export apps/os `DurableObjectNameCodec` (faux URLs `{projectId}.iterate{path}`, `global.iterate{path}` for the `null`/outer scope) + `resolveIngress(request)`.                                                        | 60        |
| `config.ts`                | `AppConfig` (deployment-wide: `fallback` + `defaults` + optional `firstParty`, **no projectId**), `FallbackRef`, `ProvideCapabilityInput`.                                                                                | 80        |
| `itx-durable-object.ts`    | **`ItxDurableObject`** (== apps/os `CapabilityHostDurableObject`) — one per `{projectId, path}`. Event-sourced mount table + `invokeCapability`/`provideCapability`/`revokeCapability` + `run`/`load`. Holds `#fallback`. | 230       |
| `itx.ts`                   | **`Itx`** (== apps/os `ProjectRpcTarget`, minted by `itxForScope`) — the surface handed to code as `env.ITX`+`globalOutbound`: typed built-in getters + the prototype hop for dynamic capabilities.                       | 140       |
| `capabilities.ts`          | The **built-in capabilities** (typed `RpcTarget`s): `Streams`+`StreamHandle`, `Secrets`, `Kv`, `R2`, `Egress` (the fetch chain), `Ai`, `Auth`.                                                                            | 300       |
| `loader.ts`                | `loadConfined(...)` — string → Worker Loader confined isolate with `env.ITX`+`globalOutbound`.                                                                                                                            | 60        |
| `stream-durable-object.ts` | **`StreamDurableObject`** — thin append/read event log (depth deferred, §5).                                                                                                                                              | 90        |
| `secret-durable-object.ts` | **`SecretDurableObject`** — strongly-consistent per-project secret store behind `itx.secrets` (KV is wrong here: eventual + 1-write/s/key).                                                                               | 80        |
|                            | **core total**                                                                                                                                                                                                            | **~1040** |

### 2.1 Substrate inventory — DO namespaces, classes, and loopback entrypoints (one place)

| Substrate          | DO class                                              | namespace binding | loopback entrypoint (props)          | v1?                                     |
| ------------------ | ----------------------------------------------------- | ----------------- | ------------------------------------ | --------------------------------------- |
| itx context / caps | `ItxDurableObject` (== `CapabilityHostDurableObject`) | `ITX_HOST`        | `ItxEntrypoint({ projectId, path })` | ✅                                      |
| streams            | `StreamDurableObject`                                 | `STREAM_DO`       | `StreamEntrypoint({ projectId })`    | ✅ thin                                 |
| secrets            | `SecretDurableObject`                                 | `SECRET_DO`       | `SecretEntrypoint({ projectId })`    | ✅                                      |
| repos              | `RepoDurableObject`                                   | `REPO_DO`         | `RepoEntrypoint({ projectId })`      | ⛔ deferred (domain fold over a stream) |
| kv                 | — (`env.KV`)                                          | —                 | `KvEntrypoint({ prefix })`           | ✅                                      |
| r2                 | — (`env.R2`)                                          | —                 | `R2Entrypoint({ prefix })`           | ✅                                      |
| ai                 | — (`env.AI`)                                          | —                 | —                                    | ✅                                      |

Loopback entrypoints are **props-parameterized, trusted** (`ctx.exports.<E>({props})`); the per-project prefix
is filled by the core from the DO's own projectId, never from userspace. Repo is a **domain object** (a fold
over a stream) — v1.1, not the core.

---

## 3. The two workers — identical skeleton, different wiring

Both workers import the core from `packages/itx` and share the same `src/` skeleton: **`worker.ts`** (entry) +
`wrangler.jsonc` + at most one extra module.

_(Open question — folder layout: control-plane + project-worker as two `apps/` folders is my assumption; could
also be one app with two entrypoints. TanStack Start browser apps are **out of scope for now** — wherever they
live, they call the control-plane `/api`; wire later.)_

### 3.1 `apps/project-worker` — the inner core (runtime). **Owns the DO migrations.**

- **Entry points:** default `fetch` in **`worker.ts`** (ingress door + router: `resolveIngress` → `ITX_HOST`
  DO → `host.fetch`); `WorkerEntrypoint ProjectRunner` (same-account dial target); a **`DummyControlPlane`
  WorkerEntrypoint** used as the `fallback` in solo mode (§3.4); re-exports the DO classes `ItxDurableObject`,
  `StreamDurableObject`, `SecretDurableObject` (holds their migrations).
- **Bindings:** `LOADER`, `ITX_HOST`/`STREAM_DO`/`SECRET_DO` (own namespaces + migrations), `KV`, `R2`, `AI`,
  service binding `CONTROL_PLANE` (absent in solo mode), var `APP_CONFIG`.
- **Extra module:** none. Just the core. **Self-hostable standalone (solo mode).**

### 3.2 `apps/control-plane` — the identity shell (the fallback) + folded-in product. _(identity module EXISTS.)_

- **Entry points:** default `fetch` in **`worker.ts`** (OAuth 2.1 AS wrap → app: login/session/`/authorize`/
  `/api`/`/__ingress`); MCP; runs its OWN `ItxDurableObject` for the `global.iterate/…` outer scope
  (project-created events, webhook ingress).
- **Bindings:** D1 `DB`, `OAUTH_KV`, service binding `RUNNER`→project-worker, **cross-script bindings to the
  shared `ITX_HOST`/`STREAM_DO`/`SECRET_DO` namespaces** (no migration — project-worker owns them), var
  `APP_CONFIG`.
- **Extra module:** `identity/` — OAuth AS + D1 directory + login (big, already built, **not core**) + the
  **first-party module** (platform keys + metering), config-gated on/off.

### 3.3 The `APP_CONFIG`s — `fallback` forms the chain

```jsonc
// project-worker (solo)               // project-worker (with control plane)   // control-plane
{                                      {                                        {
  "fallback": {                          "fallback": {                            "fallback": { "via": "terminal" },
    "via": "loopback-entrypoint",          "via": "service-binding",              "defaults": { …same real bindings… },
    "entrypoint": "DummyControlPlane" },   "binding": "CONTROL_PLANE" },          "firstParty": {           // hosted only
  "defaults": {                          "defaults": { …same real bindings… }       "secrets": ["exa","openai"],
    "kv":      {"entrypoint":"KvEntrypoint"}, }                                      "metering": true
    "r2":      {"entrypoint":"R2Entrypoint"},                                      }
    "streams": {"binding":"STREAM_DO"},                                         }
    "secrets": {"binding":"SECRET_DO"},
    "ai":      {"binding":"AI"} }
}
```

**`fallback`** = the enclosing shell this worker's root context (`/`, or `global/` for the control plane) falls
back to when it can't resolve a capability / handle a hostname itself. `{via:"terminal"}` ends the chain (real
internet + real bindings). Self-host vs hosted differ in exactly one field: control-plane's `firstParty`.
`defaults` carry no prefix — filled per-DO from the projectId.

### 3.4 The fallback contract — why `DummyControlPlane`, not `DummyAuth`

The `fallback` is not "auth." It is the **whole outer-shell contract** the project delegates outward — it _is_
a `CapabilityHost`, so its contract is exactly the host's outward-facing methods:

```ts
interface Fallback {
  // what env.CONTROL_PLANE (or the dummy) exposes
  invokeCapability(call: { path: string[]; args?: unknown[] }): Promise<unknown>; // capability fallthrough (incl. auth)
  // + egress delegation: the built-in `Egress` calls fallback's egress until it reaches terminal
}
```

Stubbing only auth would leave egress-termination and capability-fallthrough undefined in solo. So solo swaps
the **one `env.CONTROL_PLANE` binding** for a `DummyControlPlane` — a loopback `WorkerEntrypoint` the project
worker exports itself (so solo stays one worker) — implementing that contract trivially:

- `invokeCapability({ path:["auth","gate"], … })` → `{ ok: true }` (local admin, no login)
- egress → terminal (straight to the real internet; no first-party keys, no metering)
- `invokeCapability(anythingElse)` → not found (solo inherits no outer capabilities)

The core's `ItxDurableObject` calls `fallback.invokeCapability` / delegates egress **identically in every mode**
— it never knows whether its fallback is the real control plane or the dummy. **No solo special-casing anywhere
in the core.** "The control plane is a capability provider to a project," made literal: the real control plane
and the dummy are two providers of the same `Fallback` contract.

---

## 4. The APIs — the capability host we proved

### 4.0 Two kinds of path (Jonas — they are NOT the same thing)

- **`callPath`** — an **itx expression** naming a capability CALL: `"itx.slack.chat.postMessage"`. Typed to
  start with `itx.`. This is what `invokeCapability` / `provideCapability` address.
- **`streamPath`** — a plain path INTO a stream/collection: `"/some/important/stream"`, passed as an _argument_
  to a built-in: `itx.streams.get(streamPath)`.

```ts
type ItxCallPath = `itx.${string}`; // a dotted capability expression  (the dispatch address)
type StreamPath = `/${string}`; // a resource path inside a collection (an argument)
```

**Two addressing schemes coexist, exactly as apps/os:**

- **Built-in capabilities** — typed `RpcTarget` getters with real names (`itx.streams`, `itx.secrets`,
  `itx.kv`, `itx.egress`, …). Each returns a real `RpcTarget` → resolved _in the isolate_, pipelined natively.
- **Dynamic (userspace) capabilities** — addressed by a **`callPath`**, dispatched through ONE generic
  **`invokeCapability(callPath, args)`**. The dotted sugar `itx.slack.chat.postMessage(x)` compiles (via the
  prototype hop, §4.3) to `invokeCapability("itx.slack.chat.postMessage", [x])` — one pipelined round trip.

**Mounts are itx expressions too (merged with apps/os's `itx-expression` type) — the elegant part (Jonas):** a
mount at a `callPath` is either a **`live`** stub OR an **`itx-expression`** (an ALIAS to another expression).
One mechanism gives you both:

- **alias / shortcut:** mount `"itx.appendToMainStream"` → `"itx.streams.get('/some/important/stream').append"`.
- **override a built-in navigation:** mount `"itx.streams.get('/bla')"` → your own capability (granular BYO —
  §4.5). ⚠️ Open tension (§8): built-in getters win _before_ the prototype hop, so honoring a mount at a
  built-in sub-expression needs either the built-in to consult the mount table, or the surface to route
  everything through `invokeCapability`. This is the core's last open design question.

### 4.1 `itx-durable-object.ts` — the capability host DO

```ts
export class ItxDurableObject extends DurableObject<Env> {
  // == apps/os CapabilityHostDurableObject
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!, { allowNullProjectId: true });
  //     → { projectId: string | null, path: string, props }   ('global.iterate…' → projectId: null)
  #fallback: CapabilityHostStub | null; // the host this scope falls back to (§4.4). local OR remote stub.

  /** THE single dynamic dispatch. `callPath` is an itx expression ("itx.a.b"). Longest-prefix match in the
   *  local (event-sourced) mount table; a `live` mount dispatches, an `itx-expression` mount re-enters the
   *  evaluator (alias); else fall back to `#fallback.invokeCapability(...)`. Pipelines in one hop. */
  invokeCapability(callPath: ItxCallPath, args?: unknown[]): Promise<unknown>;

  /** Mount a capability at a `callPath` on THIS scope (writes stay LOCAL — §4.4). Emits a `capability-provided`
   *  event on this scope's stream (event-sourced, NOT KV). Returns a revocable handle. */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision>;
  revokeCapability(input: { path: ItxCallPath; providedAtOffset?: number }): Promise<void>;

  /** Execute code in this context. Mode 1: LIVE callback (trusted). Mode 2: STRING → confined worker. */
  run<T>(fn: (itx: Itx) => Promise<T>): Promise<T>;
  load(source: string, args?: unknown): Promise<unknown>;

  /** NATIVE fetch — a SPECIAL CASE, not a capability. A WebSocket upgrade (101) can ONLY be returned from a
   *  handler named `fetch`, and a 101 can't cross an RPC boundary — so the stateless edge calls
   *  `host.fetch(request)` DIRECTLY for ingress + WS upgrades, NEVER via `invokeCapability("itx.fetch", …)`.
   *  This is where `ctx.acceptWebSocket()` (the wake socket, spikes 3-4 / PR #2386) attaches. Distinct from the
   *  egress capability `itx.egress.fetch` (outbound HTTP through the fallback chain — §4.4). */
  fetch(request: Request): Promise<Response>;

  whoami(): ProjectProps;
  // DEFERRED (spikes 3-4): webSocketMessage/webSocketClose — the wake socket, accepted inside fetch() above.
}

type ProvideCapabilityInput =
  | { path: ItxCallPath; type: "live"; capability: unknown; instructions?: string }
  | { path: ItxCallPath; type: "itx-expression"; expression: ItxCallPath; instructions?: string };
//   itx-expression = an ALIAS: resolving `path` re-enters the evaluator at `expression`.
//   e.g. path:"itx.appendToMainStream" → expression:"itx.streams.get('/some/important/stream').append"
//   A rudimentary parser evaluates "itx.a.b.method('arg')" (merges with apps/os's ItxExpression).
```

### 4.2 `itx.ts` — the surface (`Itx` == apps/os `ProjectRpcTarget`, minted by `itxForScope`)

```ts
export class Itx extends RpcTarget {
  // apps/os: IterateRpcTarget<"Project">
  get streams(): Streams;
  get secrets(): Secrets;
  get kv(): Kv;
  get r2(): R2; // built-ins: typed,
  get egress(): Egress;
  get ai(): Ai;
  get auth(): Auth; // resolved in-isolate

  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision>; // shortcut → this scope's host
  invokeCapability(call: { path: string[]; args?: unknown[] }): Promise<unknown>; // shortcut → this scope's host
  whoami(): ProjectProps;

  // + the PROTOTYPE HOP (§4.3): any UNKNOWN dotted root → invokeCapability({ path, args }).
}

export function itxForScope(p: {
  projectId: string | null;
  path: string;
  host: CapabilityHostStub;
}): Itx;
```

`itx.egress.fetch(request)` is the egress chain. **Plain `fetch()` in confined code** → `globalOutbound` →
`itx.egress.fetch`, so LLM-written agent code just calls normal `fetch` (§4.4 chain applies).

### 4.3 The prototype hop — ergonomic dynamic dispatch that still pipelines (the workerd#6873 rule)

`installPrototypeInvokeCapabilityFallback(Itx, …)` inserts a Proxy **into the class's prototype chain** (NOT a
Proxy wrapping the instance):

```
instance ──▶ Itx.prototype ──▶ Proxy(hop) ──▶ (fallback)
```

Declared members win before the hop; an **unknown dotted root** falls through into a path-accumulating proxy
that fires `invokeCapability({ path, args })` on `apply`. It MUST be a prototype hop, not an instance wrapper:
workerd RPC **brand-checks a method's result** to classify it for pipelining; a bare `Proxy` fails the brand
check (workerd#6873) → _"the RPC receiver does not implement the method."_ The hop keeps instances genuine
`RpcTarget`s (`instanceof` holds; passed by reference). Guard `then`→`undefined` + RESERVED/probe keys — our
spike reproduced the disconnect-crash when this was wrong (`has()` claiming `Symbol.dispose`). This is exactly
`spikes/capability-fallthrough/capability-host.mjs` and apps/os `installPrototypeInvokeCapabilityFallback`.

### 4.4 `fallback` — reads fall back, writes stay local (the apps/os asymmetry)

- **Reads fall back:** `invokeCapability` (and `egress.fetch`) resolve locally, else call the SAME method on
  `#fallback` — one hop, pipelines onward. Chain: `/agents/x` → `/` → control-plane (or DummyControlPlane) →
  terminal. **Egress** is one built-in that internally delegates to `fallback.egress`, substituting THIS
  shell's secrets on the way out (project key at `/`, first-party key at the control plane) — the fetch
  middleware chain, unbypassable because userspace has no raw fetch. **Two fetches, don't conflate them:** the
  egress capability here (outbound HTTP) vs the DO's native `fetch` (§4.1 — ingress + WS upgrades, called
  directly by the edge, never through `invokeCapability`).
- **Writes stay local:** `provideCapability` ALWAYS mounts on exactly the host you called. To mount elsewhere,
  address that host explicitly (`itx.capabilityHosts.get(path).provideCapability(...)`).

### 4.5 Overriding a built-in (BYO-KV, shortcuts) — mount an itx-expression at its `callPath` (Jonas's unification)

Because mounts live at `callPath`s, you override a built-in by mounting at its expression — one mechanism for
everything:

- `provideCapability({ path: "itx.streams.get('/bla')", type: "live", capability: myStream })` — BYO-stream for
  that path.
- `provideCapability({ path: "itx.kv", type: "itx-expression", expression: "itx.externalKv" })` — BYO-KV /
  residency (D11).
- `provideCapability({ path: "itx.appendToMainStream", type: "itx-expression", expression: "itx.streams.get('/x').append" })`
  — a shortcut.

This **subsumes** the earlier "config-time backing" idea: config just installs the _trusted default_ mounts at
construction; userspace adds more at its own scope. ⚠️ **TENSION (the one thing left, §8):** declared built-in
getters win _before_ the prototype hop and pipeline natively, so a mount at a built-in sub-expression only fires
if (a) each built-in consults the mount table for its sub-path, or (b) the whole surface routes through
`invokeCapability`. And the `rejectBuiltinCollision` rule (apps/os blocks shadowing a built-in _name_) has to
relax to allow deeper-expression overrides — decide the granularity.

---

## 5. Streams — API in, depth out, one shared namespace

- **In the core:** `itx.streams.get(path)` is a built-in backed by a **thin** `StreamDurableObject` (append/read).
- **ONE shared namespace across both workers.** DO classes defined once (migration in project-worker),
  cross-script-bound (`STREAM_DO`/`SECRET_DO`/`ITX_HOST`) into control-plane. Names via `DurableObjectNameCodec`
  (`{projectId}.iterate{path}`, `global.iterate{path}` for the outer scope). **Scope = which names a shell can
  construct:** the control plane builds `prj_x.iterate/…` + `global.iterate/…` (append `project-created`, route
  a webhook in); a project's `Streams` builds only its own. Cross-project naming is _unexpressible_, not checked.
- **The mount table already lives here.** apps/os stores capability mounts as `capability-provided` events on
  the scope's stream. So `ItxDurableObject`'s table IS a stream fold — streams and the capability host are the
  same substrate at the storage layer, even though we keep them as distinct classes (D5).
- **NOT in the core (deferred):** processors/folds beyond the mount reducer, KV checkpoints, at-head
  obligations, the domain-object DOs (agent/repo). Lands behind the same `StreamHandle` API.

---

## 6. What gets demonstrated — solo / self-host / hosted + auth

### 6.0 PROVE FIRST — a "proper" fetch (WebSocket upgrades and all) through the WHOLE stack

This is the **walking skeleton**, built before anything else, because WS is the riskiest thing to thread: a
101 can't cross an RPC boundary, so **every hop a fetch takes must be a native `.fetch()`** (service-binding
fetch / DO-stub fetch — both WS-capable), NEVER `invokeCapability`. If a hop can't carry the upgrade, we learn
it on day one, not after building the capability model on top.

- **Ingress (browser → agent):** `wss://…` → edge `fetch` → `env.PROJECT_WORKER.fetch` (service binding) →
  `ITX_HOST.get(name).fetch` (DO stub) → `ItxDurableObject.fetch` → `ctx.acceptWebSocket()` (or forward to a
  confined agent's own fetch). Prove: a browser holds a live WS to an agent. _(This IS the wake-socket
  mechanism, spikes 3-4 — same fetch path.)_
- **Egress (agent → external WS):** confined agent `new WebSocket("wss://echo…")` → `globalOutbound` →
  `itx.egress.fetch` → `fallback.fetch` (`env.CONTROL_PLANE` service binding) → … → terminal
  `globalThis.fetch` → the real external WS. Prove: an agent opens an outbound WS through the whole fallback
  chain, secret substitution intact.

**The four risk points to verify explicitly (any failure changes the architecture):**

1. Worker Loader `globalOutbound` carries a WS upgrade — confined `fetch()` returns 101 + `webSocket`.
2. Service-binding `.fetch()` preserves WS worker→worker (project → control-plane → …).
3. DO-stub `.fetch()` preserves WS (known-good hibernatable pattern — but prove it in _our_ wiring).
4. The egress secret-substitution middleware passes the `webSocket` + 101 through **without touching the body**
   (it's easy to accidentally consume/deny an upgrade while rewriting headers).

### 6.1 Then: solo / self-host / hosted + auth

**Same core, three modes, config-only differences (§1 table, §3.3).**

**Solo (the inner core), headless:** deploy project-worker alone; `fallback` = its own `DummyControlPlane`.
Prove: `host.load(src)` runs a confined agent; `itx.streams`/`kv`/`secrets` work; a userspace
`provideCapability(["my-tool"], …)` + `itx.myTool()` round-trips through `invokeCapability`; `fetch(...)`
reaches the internet via `egress` → `fallback` → terminal; `itx.auth.gate` returns `{ok:true}` via the dummy.
**Unit tests + headless target — one worker, no browser, no control plane.**

**Auth (with control-plane):**

1. **Authed browser → narrowed project.** control-plane `/api` resolves user → authorized `projectId`;
   project-worker runs with `itx` bound to `{projectId}/`. A second project's DO name is **unnameable**.
2. **Public vs private apps** via `itx.auth.gate` (falls back through to the real control plane).
3. **Confined isolation** — an agent at `prj_acme` can't resolve `prj_other`'s `kv`/`streams`/`secrets`.
4. **Outer-writes-inner streams** on the shared namespace — control plane appends `project-created` into
   `prj_acme.iterate/…`; the project can't name `global.iterate/…`.

**Self-host vs hosted — the killer proof:** a confined agent runs
`fetch("https://api.exa.ai/…", { headers: { Authorization: "Bearer {{secret:platform:exa}}" }})`.

- **Hosted:** unresolved at `/`, then **substituted at the control-plane egress** (its `firstParty` is on) with
  Iterate's Exa key + a **metering event**. Works.
- **Self-host:** control-plane's `firstParty` is off → placeholder stays unresolved → fails unless the project
  brought its own `{{secret:project:exa}}`. First-party keys are purely a config-gated module in the fallback —
  project code unchanged.

---

## 7. Can it be ~1000 lines? — honest budget

**~1040 LOC across ~13 small classes in 8 core files** (§2). Over 1000 by the Secret DO (KV is wrong for
secrets). It holds ONLY because these stay out:

- **`apps/control-plane/identity/`** (OAuth 2.1 AS + CIMD + DCR + D1 directory + login + first-party module) —
  big, already exists, the identity shell.
- **Stream-processor machinery** beyond the mount reducer (checkpoints, obligations, domain DOs incl. Repo) —
  §5, deferred.
- **Wake sockets / live capabilities** (spikes 3-4) — deferred; `provideCapability` + `live` stay as the API.
- **MCP server, TanStack browser apps** — out (§3 open question).

**PORTED (not rewritten):** the prototype-hop + `invokeCapability`/`provideCapability` shape from apps/os
`rpc-targets.ts` + our spikes; secret substitution from `apps/kernel/src/egress.ts`; the loader glue from
`kernel.ts`+`dynamic.ts`; DO naming from apps/os `DurableObjectNameCodec`. New work is mostly assembly, not
invention — the hard parts are already proven.

---

## 8. Open questions to settle before coding

1. **Core home:** a workspace package `packages/itx` (my assumption), or `apps/project-worker/src` imported
   relatively by the control plane?
2. **Folder layout (your note):** two `apps/` folders, or one app with two entrypoints? TanStack apps —
   out of scope for now.
3. **DO always, or DO only when needed?** D19 says every dynamic `invokeCapability` enters `ItxDurableObject`
   (built-in getters resolve in-isolate without a hop). Confirm that split.
4. **How mount-overrides of built-ins fire (the last core design question).** Jonas's `callPath`-as-itx-
   expression unifies aliases + overrides + dynamic caps into ONE mount mechanism. But apps/os built-in getters
   win _before_ the prototype hop (and pipeline natively). To honor a mount at `itx.streams.get("/bla")`,
   either (a) each built-in consults the mount table for its sub-path, or (b) the surface routes everything
   through `invokeCapability` (losing the in-isolate fast path). Also: relax `rejectBuiltinCollision` to allow
   deeper-expression overrides while still forbidding wholesale name theft? Pick the resolution rule.
5. **Which worker owns the migrations** for the shared namespaces — project-worker (assumed).
