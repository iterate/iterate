# Build log — clean-room inner core (project-worker, solo)

Chronological log of every increment: what was built, how it was proven, the platform facts learned, and the
commit. Design ref: `apps/os/docs/simplification/wayfinder/innermost-core/target-core.md`. Deploy target: the
POC account: `project-worker.iterate.workers.dev` (the inner core) + `iterate-control-plane.iterate.workers.dev`
(the shell, from increment 11).

Convention: each increment ends at a **working gate** — typecheck green + proven on the deployment + committed.

---

## Increment 1 — WS-capable fetch through the whole stack (the walking skeleton)

**Commit** `42ee5d3ba`. **Why first:** a 101 can't cross an RPC hop, so every fetch hop must be a native
`.fetch()`; if that fails anywhere, the architecture changes (target-core §6.0 / D33).

- Built `ItxDurableObject` (native fetch → `acceptWebSocket` + echo), the edge router, `EgressEntrypoint`
  (project egress door: secret-sub → fallback), `DummyControlPlane` (solo fallback), `core/egress.ts`,
  `core/config.ts`.
- **Proven:** ingress WS (`/ws` → DO-stub fetch → acceptWebSocket → echo) + egress WS (`/egress-test`:
  confined agent → globalOutbound → EgressEntrypoint → DummyControlPlane → terminal → external echo). All four
  §6.0 risk points green, incl. #4 (secret substituted into a WS-upgrade request, 101 still flows).
- **Platform facts:** outbound WS = `https://` URL + `Upgrade` header (not `ws://`); a worker can't WS its own
  hostname (loop protection); a no-props `ctx.exports.X` stub is used directly as a Fetcher.

## Increment 2 — capability model in the DO (invokeCapability + provideCapability + fallback)

**Commit** `ee6f270f4`.

- `ItxDurableObject.invokeCapability(callPath,args)` — built-in (in-place) → local mount → fall back to the
  enclosing shell. `provideCapability({path,type})` — mount at a callPath, persisted to DO storage
  (`itx-expression` alias + `static`). "Reads fall back, writes stay local" (§4.4). DO reaches its fallback via
  a self service-binding `FALLBACK` → `DummyControlPlane` (a DO can't mint ctx.exports loopbacks).
- **Proven** (`/call`, `/provide`): built-in whoami, provide+resolve an alias, a persisted static mount,
  fall-through to DummyControlPlane (`auth.gate` → ok), a genuine miss throwing at the terminal.
- **Platform fact:** workers.dev version propagation lags across colos for a minute+; smoke tests right after
  deploy must retry past stale responses.

## Increment 3 — execution in the DO (host.load), with intra-DO re-entrancy

**Commit** `88a947f2f`.

- `ItxDurableObject.load(source)` (target-core §4.1 mode 2 / D23) loads `source` as a confined dynamic worker
  whose only binding is `env.ITX` = `globalOutbound` = a **self-stub** to THIS host
  (`env.ITX_HOST.getByName(this.ctx.id.name)`). The agent's `itx.*` calls resolve against its own capability
  host; its plain `fetch()` routes to the host too.
- **Proven** (`/load`): a confined agent ran INSIDE the DO and called back via `env.ITX.invokeCapability(...)`
  — `itx.whoami` (built-in) → `{projectId:"prj_demo"}`, `itx.auth.gate` → fell back to DummyControlPlane →
  `{ok:true}`. Result `{"who":…,"auth":{"ok":true},"ranInContext":true}`.
- **Platform facts:** a **DO self-stub passed as a loaded worker's `env` value is RPC-callable** (the agent
  calls the DO's public methods). **Intra-DO re-entrancy does NOT deadlock** — the agent calling back into the
  DO while the DO awaits `load` works (the input gate is open during the await). A DO stub is also accepted as
  `globalOutbound`. (Calling a method the DO doesn't implement fails with workerd's "receiver does not
  implement the method" — the same brand-check family as #6873.)

## Increment 4 — egress unified into the DO (the DO is now the single host)

**Commit** `5ebf3708a`.

- `ItxDurableObject.fetch` for a NON-WS request now IS the egress door: substitute the project's own secrets
  (`env.SECRETS_KV`, keyed by the DO's own projectId) → delegate to `env.FALLBACK.fetch` (→ terminal). WS
  upgrades still accept (ingress). So one DO does ingress WS + egress + capabilities + execution.
- Because a DO-loaded agent's `globalOutbound` is a self-stub, its plain `fetch()` now egresses through its
  own host with secret substitution — no separate egress entrypoint needed for loaded agents.
- **Proven** (`/load`): the agent's `fetch("https://postman-echo.com/get", {Authorization:"Bearer {{secret:project:demo}}"})`
  returned `status:200` with the reflected header `Bearer sk-demo-REALVALUE-9x8y7z` — the substituted secret
  came out the far side. Ingress WS still green.
- **Note (deferred):** WS-egress from a DO-loaded agent is ambiguous with WS-ingress at `DO.fetch` (same
  Upgrade header); a marker will disambiguate. Agents egress over HTTP today. The worker's `EgressEntrypoint` +
  `/egress-test` remain as the WS-egress proof.

## Increment 5 — real built-in capabilities: itx.kv (project-prefixed) + itx.secrets.set

**Commit** `5b604bfbe`.

- `invokeCapability` now resolves built-ins in-place (target-core §4.0): `itx.kv.{get,put,delete,list}` over
  `env.ITX_KV`, keyed `${projectId}:${k}` — the prefix comes from the DO's OWN (unforgeable) projectId.
  `itx.secrets.set(name,value)` writes `secret:${projectId}:${name}` to `env.SECRETS_KV` (write-only from
  userspace; the egress door reads it via placeholder). `/call` now passes `?args=<json array>`.
- **Proven** (`/call`): put→get round-trips `"hello-from-prj_demo"`; `list` strips the prefix; **isolation** —
  `ctx=prj_other` reading the same key returns `null` (a different DO name → a different prefix → invisible).
  This is the D8 portability proof point: byte-identical project code, isolated in a shared namespace, and
  swappable for a BYO KV by config.

## Increment 6 — live capability providers over capnweb (device/browser/worker as provider)

**Commit** `ef552c3c3`. Adds the `capnweb` dep (`@iterate-com/capnweb`, mirroring kernel).

- `ItxDurableObject.fetch` at `/connect` serves a capnweb `ProviderControl` surface
  (`newWorkersRpcResponse`). A provider calls `provideCapability(callPath, <live RpcTarget>)`; the DO keeps the
  stub (`.dup()`) in an in-memory `#liveMounts` map (a live pin; lost on eviction — wake-on-call is later).
- `invokeCapability` checks live mounts first (longest dotted-prefix; the remaining segment is the method):
  a call to `itx.myTool.echo` dispatches `stub.echo(...)` back over the provider's socket (target-core §4.1
  "live" / D7).
- **Proven:** a node provider connected (`newWebSocketRpcSession`), provided `itx.myTool` (echo + add), then an
  HTTP `/call?path=itx.myTool.echo` returned `"echo-from-provider:hi"` and `itx.myTool.add [2,3]` → `5` — the
  invocations travelled back to the provider. capnweb bundles into the pure-play worker with no nodejs_compat.

## Increment 7 — the ergonomic Itx surface (client-side prototype hop)

**Commit** `e4393cf69`.

- `core/agent-runtime.ts` exports `ITX_SURFACE_MODULE`, injected into every loaded agent as `itx.js`. It wraps
  the raw `env.ITX` host stub in an accumulating Proxy so `itx.a.b(args)` compiles to
  `stub.invokeCapability("itx.a.b", [args])` (target-core §4.2/§4.3). Plain Proxy in the agent's own isolate
  (never crosses a wire → no #6873 brand-check); pipelining is a later refinement.
- **Proven** (`/load`): the demo agent now calls `itx.whoami()` / `itx.auth.gate()` and plain `fetch()` — all
  green (`{"who":…,"auth":{"ok":true},"egress":{…,"seenAuth":"Bearer sk-demo-…"},"ranInContext":true}`). The
  injected `itx.js` + a relative `import "./itx.js"` resolve inside Worker Loader.

## Increment 8 — itx.streams (a real per-path event log, project-prefixed)

**Commit** `96c59c22d`.

- `stream-durable-object.ts` — a minimal `StreamDurableObject` (append + monotonic AUTOINCREMENT offset +
  poll-based replay; the delivery spine and the canonical event shape are deferred). `invokeCapability`
  dispatches `itx.streams.append` / `itx.streams.read` to `env.STREAM_DO.getByName("${projectId}:${path}")` —
  project-prefixed like itx.kv, so a project can only ever name its OWN streams. Added a v2 migration + the
  STREAM_DO binding.
- **Proven** (`/call`): two appends → offsets 1,2; `read` replayed both with `createdAt`+payload; `read` after
  offset 1 → only offset 2; isolation — `ctx=prj_other` reading `/events` returned `[]`.

## Increment 9 — path-addressed contexts + parent-path fallthrough (deep `/agents/x`)

**Commit** `<pending>`.

- `core/names.ts` — a minimal faux-URL codec (`{projectId}.iterate{path}`, mirroring apps/os), + `parentPath`.
  The DO parses `{projectId, path}` from its (unforgeable) name; the worker canonicalizes any `ctx` so bare
  `prj_demo` and full `prj_demo.iterate/agents/x` map to the right DO.
- `invokeCapability` fallback is now two-level (target-core §4.4 / D21): a deep path falls back to its **parent
  path** (another context DO → it inherits everything provided above it); the **root** falls back to the
  **shell**. Recurses until resolved or the terminal throws.
- **Proven** (`/call`): `whoami` at `/agents/x` parses `projectId:"prj_demo"`; a static cap provided at the
  root is resolved BOTH at the root AND at `/agents/x` (inherited via fallthrough); a different project's
  `/agents/x` can NOT inherit it (falls through its own root → shell → not found).
- **Platform note:** DO _code_ propagates slower / more skewed than worker code after a deploy — poll for a
  code-version marker (e.g. `whoami` parsing) before smoke-testing.

## Increment 10 — wake-on-call: 1000 devices provide capabilities WITHOUT pinning the DO

**Commit** `<pending>`. Ports spike-4 (ContextDO) into the clean room.

- A device connects a **hibernatable** wake socket at `/register?connectionKey=&caps=`
  (`ctx.acceptWebSocket(_, ["wake"])` + `serializeAttachment({connectionKey, caps})`). It does NOT pin the DO
  and survives hibernation — 1000 of them cost ~nothing while idle. The RPC leg (`/connect`, capnweb) is the
  only pin.
- `invokeCapability`: live mount → **WAKE** (page the hibernatable socket that declares the cap; the device
  dials its RPC leg back + re-provides; then dispatch) → local mount → fallback. After `IDLE_MS` the RPC leg is
  torn down (`{type:"idle"}` → the device closes it), so the DO can hibernate again. A durable `incarnation`
  counter + `/state` give observability.
- **Proven** (node "device"): registered a wake-socket-only device, then `/call itx.myTool.echo` **paged it on
  demand** → dialed the RPC leg → dispatched → `"echo-from-provider:hi"`. `/state` showed
  `{wakeSockets:1, liveMounts:1, dormant:false}` during the call, then `{wakeSockets:1, liveMounts:0,
dormant:true}` after idle — the device stays registered while **nothing pins the DO**. (Full
  99.5%-idle-over-minutes at 1000-scale is spike-4's billing proof; identical mechanism.)
- **Billing-analytics verification (2026-08-04):** held **50** hibernatable wake sockets on one DO, then queried
  the Cloudflare GraphQL DO analytics (`durableObjectsPeriodicGroups`) for the `project-worker` ITX_HOST
  namespace. Per-minute: `maxWebSockets:50` at connect, yet `activeTime` **12–415 ms/min (<1% of each minute)** —
  the connections do NOT pin the DO; it hibernates while holding them. Confirms the no-pin claim at the billing
  level on the clean-room DO (spike-4 saw 14–22 ms/min at 1000 sockets — identical mechanism, so it scales).

## Increment 11 — the control-plane join (a real second worker as the shell; the shell onion)

**Commit** `<pending>`. First multi-worker topology (self-host / hosted).

- `control-plane-shell.ts` + `wrangler.control-plane.jsonc` — a SECOND worker `iterate-control-plane`
  (`ControlPlaneShell`): `fetch` substitutes **platform / first-party** secrets (`{{secret:platform:NAME}}`
  from `PLATFORM_SECRETS_KV`) then hits terminal; `invokeCapability` is the outer capability fallthrough
  (auth). Minimal — no DOs/loader; the fallback contract only.
- The project worker's `FALLBACK` service binding now points at `iterate-control-plane#ControlPlaneShell`
  (self-host) instead of its own `DummyControlPlane` loopback (solo). So a project's egress passes DO
  (project-secret sub) → control-plane worker (platform-secret sub) → terminal, and the auth fallthrough hits
  the real control plane.
- **Proven** (`/load`): an agent's `fetch` carrying BOTH `{{secret:project:demo}}` and `{{secret:platform:exa}}`
  → `seenProjectSecret:"Bearer sk-demo-REALVALUE-9x8y7z"` (substituted at the DO) +
  `seenPlatformSecret:"Bearer platform-exa-key-FIRSTPARTY-42"` (substituted at the SEPARATE control-plane
  worker) + `auth:{ok:true}`. Secret substitution accretes OUTWARD through the shell onion (D13).
- **Topology note:** this is self-host/hosted (two workers). Solo = the same project worker with `FALLBACK` →
  its own `DummyControlPlane` (one worker). Same code, config-only difference (D26).

## Increment 12 — cross-script DO sharing: the control plane writes into a project's stream (D27)

**Commit** `<pending>`.

- The control-plane worker binds the project worker's `StreamDurableObject` namespace **cross-script**
  (`{ class_name:"StreamDurableObject", script_name:"project-worker" }` — no migration; the class is owned by
  project-worker). So there is ONE shared streams namespace across both workers.
- `control-plane-shell.ts` `/emit` names `${projectId}:${path}` directly (the SAME name a project's
  `itx.streams` builds) and appends — the outer→inner write (project-created events, routed inbound webhooks).
- **Proven:** `iterate-control-plane/emit?projectId=prj_demo&path=/inbox&type=project-created` →
  `{wroteInto:"prj_demo:/inbox", offset:1}`; then the PROJECT read its own `/inbox`
  (`itx.streams.read`) and saw `{type:"project-created", payload:{by:"control-plane"}}`. Outer reaches in; a
  project can only name its own streams (inner→outer is unexpressible — increment 8's isolation).

---

## Increment 13 — repo + config worker + dynamic capabilities expressed in terms of the repo

**Commit** `<pending>`. A really-lightweight version (Jonas).

- **`itx.repo.{get,put,list}`** — the project's file store (where config + capability code lives). Lightweight:
  a `${projectId}:repo:` view over `env.ITX_KV` (a real content-addressed RepoDurableObject can slot in behind
  the same API later).
- **`code` mount kind** — a dynamic capability whose implementation is a repo file:
  `provideCapability({ path, type:"code", module:"/tools/x.js" })`. On invoke, `#runCode` loads that repo file
  and runs its `(itx, ...args) => result` default export confined (env.ITX = self-stub), returns the result.
- **`itx.provideCapability`** is now also a built-in call path (so agents / the config worker register
  capabilities ergonomically via the `itx.a.b()` surface). **`itx.configure`** loads `/worker.js` from the repo
  and runs it — the config worker, which registers the project's dynamic capabilities in terms of the repo.
- **Proven** (`/call`, fresh `prj_repo`): put `/tools/greet.js` + `/worker.js` → `itx.greet` misses →
  `itx.configure` ran the config worker (`{configured:["itx.greet -> /tools/greet.js"]}`) → `itx.greet("world")`
  returned `"hello world (from a repo-defined capability)"`. The whole loop: repo → config worker → dynamic
  capability (code from the repo) → invoke.
- **Note:** `itx.repo.list` is KV-`list` eventually-consistent (~60s); `get`-based ops (`configure`, code caps)
  read writes immediately. A `RepoDurableObject` (sqlite) would list instantly — deferred.

---

## Increment 14 — stateful + stateless dynamic workers (lightest version of apps/os's model)

**Commit** `<pending>`. Bring apps/os's stateless/stateful dynamic-worker split into the clean room, lightest
possible (Jonas). The stateless half already existed (`code` mount = a repo fn); this adds the **stateful**
half and proves both.

- **Stateless** (`code`) — a repo file exporting `(itx, ...args) => result`, loaded per call, content-addressed,
  no durable identity. (apps/os "stateless" ref, function-shaped.)
- **Stateful** (`stateful`) — a repo file exporting a `DurableObject` class (`className`), hosted as a **facet**
  of THIS `ItxDurableObject`: `ctx.facets.get("facet:<callPath>", () => ({ class }))`. The facet gets its **own
  isolated SQLite** `ctx.storage`, durable across calls. On a source change the facet is **aborted + recreated
  against the same storage** (new code, state kept) — apps/os's version-marker pattern.
- **The workerd constraint (found the hard way, binary-confirmed):** a stub to a Worker-Loader facet is
  **non-transferable across the Worker boundary** — _"Entrypoints to dynamically-loaded workers cannot be
  transferred to other Workers … have the parent Worker expose an entrypoint which constructs the dynamic
  worker and forwards to it."_ `facet.fetch()` works (a `Response` passes **by value**); a custom facet-**method**
  result gets pipelined, and the pipeline hands the caller a facet-stub reference → thrown. This is the SAME
  reason WS/ingress already lives on the fetch lane (D32). **So BOTH lanes are a plain `fetch` into the facet:**
  a host-owned `__HostedActor` wrapper subclass adds a `/__itx_rpc` fetch-dispatch (the RPC lane tunnels
  `{method,args}` and returns the result by value); the `/facet` native fetch is the WS/streaming lane into the
  user class's own `fetch`. The user still just writes normal methods.
- **Proven** (deployed `project-worker`, fresh `prj_facet_l`): a `Counter extends DurableObject` (SQLite) →
  `itx.counter.increment(2/3/5)` → **2, 5, 10** (RPC lane); `GET /facet` → `{value:10, via:"facet-fetch-lane"}`
  (fetch lane, same storage); put a **v2** source → `itx.counter.value` **STILL 10** (facet aborted+recreated,
  SQLite survived) and the new `itx.counter.hello()` → `"hello from counter v2, value=10"`; and the stateless
  pair `itx.greet("world")` still returns its repo-fn result.
- **Deferred:** a facet reaching BACK into its host via `itx` (env is empty for now — the DO-stub-in-env path
  needs the same non-transferable-stub care); alarms for facets (workerd#6810 — apps/os keeps them on the outer
  DO). Also added a `/version` smoke marker (workers.dev propagation lags ~1-2min; **DO code lags the worker
  code by a further ~minute** — poll a behavioral probe, not just `/version`, before trusting a stateful smoke).

---

## Status after increment 13 — the inner core end to end

A single `ItxDurableObject` is the host for a `{projectId, path}` context: **ingress WS**, **egress** (project
secret-sub → fallback → terminal), the **capability model** (`invokeCapability`/`provideCapability` +
parent-path-then-shell fallback), **execution** (`load` a confined agent bound to its own host), **built-ins**
(`itx.kv`, `itx.secrets.set`, `itx.streams` — all project-prefixed + isolated), **live providers** (capnweb
`/connect` → dispatch back to a device/browser/worker), the **ergonomic `itx.a.b()` surface**,
**path-addressed contexts** (faux-URL names; deep paths inherit from their parent path), and **wake-on-call**
(1000 devices provide capabilities via hibernatable wake sockets without pinning the DO), and the CONTROL-PLANE JOIN (a real second worker as the shell; platform secrets substituted at the outer shell). Proven on `project-worker.iterate.workers.dev` + `iterate-control-plane.iterate.workers.dev`.

**Next (candidates):** cross-script DO sharing so the control plane names/writes project streams (D27); the
global/`__null__` outer-scope context on the control plane; extracting the core into `packages/itx` (D26) so
the control plane runs the same core; billing-analytics verification of hibernation at 1000-scale.
