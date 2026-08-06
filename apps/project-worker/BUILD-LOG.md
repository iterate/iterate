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

**Commit** `5e4451e35` (native RPC + tunnel deleted; supersedes the earlier tunnel cut `7228d45bd`/`0e3bec07a`).
Bring apps/os's stateless/stateful dynamic-worker split into the clean room, lightest possible (Jonas). The
stateless half already existed (`code` mount = a repo fn); this adds the **stateful** half and proves both.

- **Stateless** (`code`) — a repo file exporting `(itx, ...args) => result`, loaded per call, content-addressed,
  no durable identity. (apps/os "stateless" ref, function-shaped.)
- **Stateful** (`stateful`) — a repo file exporting a `DurableObject` class (`className`), run by a **dedicated
  runner DO** `StatefulWorkerDurableObject` (apps/os's architecture — NOT a facet of the capability host). ONE
  runner instance per stateful capability, named `{projectId}::{path}::{callPath}`, hosting the user class as a
  single facet `"target"` with its **own isolated SQLite**. On a source change the facet is **aborted +
  recreated against the same storage** (new code, state kept). The capability host just forwards by name
  (`env.STATEFUL_WORKER.getByName(name).invokeCapability(...)` / `.fetch(...)`).
  - **Why a dedicated runner DO and not a facet-of-the-host** (Jonas's correction — the first cut wrongly made
    it a facet of `ItxDurableObject`): a stateful worker is its own durable actor (identity, storage,
    lifecycle), so it deserves its own DO; the host shouldn't accumulate N facets; and it's workerd's prescribed
    "parent … constructs the dynamic worker and forwards to it" shape.
- **The facet-method-RPC transport is NATIVE (`replayPath`, like apps/os) — no fetch tunnel.** The runner
  loads the user's `DurableObject` class DIRECTLY (`getDurableObjectClass(className)` → `ctx.facets.get`) and
  calls its methods with `Reflect.apply(Reflect.get(facet, method), facet, args)`. **Root cause of the earlier
  _"Durable Object Facet stubs cannot be transferred between Workers"_ failure (`DataCloneError`): the clean
  room invoked via `facet[method].apply(facet, args)`.** Reading `.apply` off an RPC stub's method proxy is a
  capnweb _pipelined remote path_, and passing the facet stub as an arg makes workerd serialize it — which a
  dynamically-loaded facet stub may never do (`requireAllowsTransfer()` throws unconditionally for dynamic
  entrypoints; workerd `server.c++` `throwDynamicEntrypointTransferError`). `Reflect.apply` invokes `[[Call]]`
  directly and never serializes the stub; the call runs INSIDE the owning DO and returns plain data. The prior
  "account-level entitlement" hypothesis was **WRONG** — same account (`04b3` = apps/os prod), the bug was the
  `.apply`-on-stub idiom in our own code. Binary-verified on the SAME deployment: `fn.apply` → `NATIVE_FAIL
DataCloneError`; `Reflect.apply` → `NATIVE_OK`. (The `__HostedActor`/`statefulDoRunner` fetch-tunnel wrapper
  is deleted.) WS/streaming lane unchanged = `/facet` → runner → the user class's own `fetch` (a `Response`
  passes by value). **Also:** loader cacheKey now folds in `CF_VERSION_METADATA.id` (`version_metadata`
  binding), mirroring apps/os so a redeploy mints a fresh loaded isolate — prevents a stale-isolate transfer
  error across rollouts (a real latent bug, not the native cause).
- **Proven** (deployed `project-worker`, native-only): a `Counter extends DurableObject` (SQLite) →
  `itx.counter.increment(2/3/5)` → **2, 5, 10** (NATIVE RPC lane through the runner DO); `GET /facet` →
  `{value:10, via:"facet-fetch-lane"}` (fetch lane, same storage); put a **v2** source → `itx.counter.value`
  **STILL 10** (facet aborted+recreated, SQLite survived) and the new `itx.counter.hello()` →
  `"hello from counter v2, value=10"`; native **survives a parent redeploy** on the same ctx (value 10 →
  `increment(5)` → 15); and the stateless pair `itx.greet("world")` still returns its repo-fn result.
  Full writeup: `apps/project-worker/FACET-RPC-INVESTIGATION.md`.
- **DONE — every dynamic worker now gets `env.ITX` (Jonas: "all dynamic workers must have env.ITX binding just
  like apps/os").** The stateless `code` cap and the confined `load` agent already got `env: { ITX: self }`;
  the stateful **facet** runner passed `env: {}`. Fixed: `StatefulWorkerDurableObject#facet` now mints a stub to
  the OWNING capability host (`ITX_HOST.getByName(stringifyName({projectId, path}))`, reconstructed from the
  runner's own `{projectId}::{path}::{callPath}` name) and passes `env: { ITX: host }` + `globalOutbound: host`
  - injects `itx.js`. So a hosted `DurableObject` class calls sibling capabilities with
    `this.env.ITX.invokeCapability("itx.x", [..])` (or `itxFromStub(this.env.ITX).x.y(..)`), and a plain `fetch()`
    egresses through the host. Mirrors apps/os (`env.ITX = ctx.exports.ItxEntrypoint({props})`).
  * **Proven** (deployed, `itxbind-1`, ctx `prj_itxbind`): `Counter.whoAmI()` (via `env.ITX`) → `{projectId:
"prj_itxbind"}`; `whoDotted()` (via injected `itx.js`) → same; `bumpKv("hits")` ×2 round-trips through
    `itx.kv` → 1 then 2, and the HOST reads the SAME key → `"2"` (facet + host share the project-prefixed KV);
    a SECOND project's facet `whoAmI()` → `{projectId: "prj_other"}` (isolation — each facet reaches ITS OWN
    host, never a sibling's).
- **Deferred:** alarms for facets (workerd#6810 — apps/os keeps them on the outer DO). Added a `/version` smoke
  marker (workers.dev propagation lags ~1-2min; **DO code lags the worker code by a further ~minute** — poll a
  behavioral probe, not just `/version`).

---

## Increment 15 — a dynamic worker's SOURCE is an itx EXPRESSION (the loader is repo-agnostic)

**Commit** `0a6dc89a1`. Jonas: "I want to build an interpreter — it's a simple two-way codec over a narrow
subset of JS," and "the dynamic worker loader shouldn't know about repos; the file reader is responsible."

- **`core/itx-expression.ts` — the codec (~55 lines).** A capability call as DATA: `ItxExpression =
(string | [method, ...args])[]` (a bare string = property read, a tuple = call; relative to the itx root;
  stores the NAME never captured authority — deleting it IS revocation). Mirrors apps/os `ItxExpression`. Two
  directions: `captureExpression()` (encode — drive a proxy, read back steps) and `evaluateItxExpression(root,
expr)` (decode — walk with `Reflect.get`/`Reflect.apply`), plus `itxRoot(invoke)` (a root whose dotted access
  compiles to `invoke("itx.a.b", args)`). Narrow ON PURPOSE (a codec, not a language): reads + calls only, JSON
  args; multi-hop pipelining deferred (v1 = one terminal call).
- **The mount carries a source EXPRESSION, not a file path.** `code` = `{ source: ItxExpression }`, `stateful` =
  `{ source, className }`. Both lanes resolve modules by `evaluateItxExpression(itxRoot(invoke), source)` → a
  `{ name: source }` map, then `LOADER.get`. The loader knows only "evaluate an expression to get modules" — no
  repo/KV knowledge. The stateful runner **dropped its `ITX_KV` binding + `#source`**: it resolves source
  through the host (`env.ITX`) like everything else. cacheKey = deploy-version + `hash(JSON.stringify(modules))`.
- **v1 "file reader" = `itx.files.read(path)`, a built-in that PROVIDES a hello** (no repo/KV — Jonas: "since
  we're not bundling, delete the source KV and provide a hello"). Returns `{ "cap.js": <source> }`. The real
  repo-at-a-ref reader slots in behind the SAME capability + the SAME source expression later; the loader never
  changes. No level-2 artifact cache (nothing expensive to cache without a bundler) — only the loader's own
  level-1 isolate cache.
- **Proven** (deployed `itxexpr-1`, ctx `prj_expr`): STATELESS — mount `itx.greet` with
  `source: ["files",["read","/hello.js"]]`, call `itx.greet("world")` → `"hello world"` (the loader evaluated
  the expression). STATEFUL — mount `itx.counter` with `["files",["read","/counter.js"]]`,
  `increment(2)` durable across runs, `value` consistent, `whoAmI()` → `{projectId:"prj_expr"}` (env.ITX
  intact). NEGATIVE — a bad source path throws cleanly _through_ the codec (`itx.files: no file "/missing.js"`).
- **Deferred / next:** the real repo-backed `itx.files` reader (refs + globs + `deref-then-key`), and
  `captureExpression` on the userspace path (config workers write `itx.files.read(...)` as sugar). `itx.repo`/
  `itx.kv`/`#configure` left intact (separate concerns — not the dynamic-worker source path).

---

## Increment 16 — WebSocket upgrades pass THROUGH the capability graph (the fetch lane)

**Commit** `0d50b29fe`. Jonas: "we could not have an ESP device connect to a project and present a website with
WebSocket functionality — we really want that. Now that we can serialise an ItxExpression as a string in an
HTTP header, we could reach a fetch-shaped capability by hopping between fetch functions." This is the thing
apps/os cannot do (proven by its quarantined `apps/os/e2e/vitest/live-capability-websocket.e2e.test.ts` — a
provided capability is reachable only by RPC replay, and a 101 can't serialize across an RPC hop:
`Could not serialize object of type "WebSocket"`).

- **The fetch lane = the fetch-shaped sibling of `invokeCapability`.** A request carrying `x-itx-cap` (a
  capability address — a serialized `ItxExpression` **or** a bare callPath) is routed by `#fetchCapability` to a
  fetch-shaped capability via NATIVE `.fetch()` hops, so a **WS upgrade (101) passes straight through** (a 101
  can't cross an RPC hop, but it rides a fetch). Checked FIRST in `ItxDurableObject.fetch` so a cap WS never
  hits ingress-echo. apps/os keeps its fetch lane (`x-iterate-worker-dispatch`) physically separate from the
  capability tree and carries a build **ref**; the clean-room advance is that the capability **address itself**
  (an `ItxExpression`) rides the header — one lane, addressed like everything else.
- **New `web` mount = a FETCH-SHAPED dynamic worker** (`{ type: "web"; source }`) whose entry `cap.js`
  default-exports `{ fetch(request, env) }`. `#fetchWeb` loads its modules (same source-expression path as
  code/stateful) and forwards the request to `worker.getEntrypoint().fetch(request)` — the entrypoint can
  `accept()` a WebSocket and return a 101, which flows back out through the native binding call. `stateful`
  facets are reached the same way (their existing `/facet` fetch lane). Alias re-resolves; a deep path falls
  back to its PARENT PATH (a native DO→DO fetch — the 101 survives the hop).
- **A live capnweb provider (external device) is explicitly 501 for now** — a 101 cannot cross capnweb, so a WS
  to a device needs a **frame bridge** (browser WS frames ⇄ capnweb messages). That is the next increment; the
  same `x-itx-cap` header routes TO the bridge. (apps/os hit the identical wall: its capnweb fork can tunnel a
  socket across a session as a stream pair, but the next internal workerd RPC hop re-refuses it.)
- **Proven** (deployed `wscap-1`, ctx `prj_wscap`): provide a `web` cap `itx.site`
  (`source: ["files",["read","/site.js"]]`); **`GET /cap?cap=["site"]` → 200 HTML**; **a WS upgrade to
  `/cap?cap=["site"]` echoes `site-echo:hello-from-eyeball`** — the 101 travelled edge → host DO →
  `#fetchCapability` → loaded web worker → `accept()` → back, addressed only by the serialized expression in a
  header (this IS apps/os's quarantined "DESIRED" test B, working). Ingress echo still works (a separate
  handler); a WS to a bogus cap refuses the upgrade without hanging.

---

## Increment 17 — clients & connections (the principal operation is `.connect`)

**Commit** `7aac3db0b`. Jonas handed a "Clients & connections" design (`clients-and-connections-design.md`) and
asked to bring it into the clean room with `.connect` as the principal operation. The design is apps/os-shaped
(stream `openConnection`, processors, collections); the clean room has none of that delivery/processor spine —
but it DOES have the substrate the design's "core move" needs (capnweb `/connect`, live-mount retention, wake
sockets, `onRpcBroken` death, thin streams), so this is composition on what exists.

- **`.connect` (the principal operation)** — a capnweb method on the `/connect` surface. A client attaches with
  `connect(info, capabilities?, inbox?)`: `info = { path, description?, user?, exclusive? }`, `capabilities` = a
  retained `RpcTarget` (the itx half, fanned out over all a client's connections), `inbox` = a retained stub
  with `processEventBatch(batch)` (the stream half). Both duped, both die with the socket. A client has **0..N
  connections** (an array), keyed by its caller-chosen `path` (also its stream address). `exclusive` pins a
  fixed connectionKey so a reconnect **knocks out** the old connection (`replaced`).
- **The runtime table is authoritative.** Connections live in `#clients: Map<path, ClientConnection[]>` on the
  project ROOT host — "who is connected now" + where the live stubs physically are. Presence facts
  (`client/connection-opened` / `connection-closed { replaced | departed }`) land on the client's OWN stream
  (`StreamDurableObject` at its path). Death = `onRpcBroken` on a retained stub → drop + close fact.
- **The itx surface (flat, v1):** `itx.clients.list` (roster), `itx.clients.get(path)` (client + connections
  metadata), `itx.clients.call(path, capPath[], args)` (**FAN OUT** over connections' `capabilities`,
  `Promise.all`, `[]` if none — a direct capnweb dispatch, never `.apply`), `itx.clients.append(path, event)`
  (append to the client's stream + push to connected inboxes). Resolved only on ROOT; a deep context fails over
  to its parent → root. The ergonomic `itx.clients.get(path).capabilities.x.y()` is pipelined sugar for later.
- **Design decisions followed:** capabilities = an RpcTarget not a fetch door (Q11); `description` per-connection
  (Q3); `[]` + `Promise.all` fan-out (Q4); `exclusive` in v1 (Q6); one shared `/clients/browser`, `user` in
  `openedBy` (Q7); no extra ACL (Q8); both `capabilities` + `inbox` optional (Q10).
- **Deferred (need the processor/delivery spine, not built yet):** the reduced-state `ClientProcessor` +
  project-level `ClientCollectionProcessor` roster (v1 reads the runtime table — the design itself says the
  table is authoritative for "open now" and reduced state may briefly overcount); full stream-wide push delivery
  (any append anywhere → subscribers) — v1 delivers on `itx.clients.append`; static offline-capability discovery
  (Q5). Death detection needs a retained stub, so a presence-only client that passes NEITHER
  capabilities nor inbox won't auto-drop until eviction (documented).
- **Proven** (deployed `clients-1`, ctx `prj_clients`, real capnweb Node clients): `.connect` two browser tabs
  on `/clients/browser` + an exclusive desk-robot with an inbox → `itx.clients.list` shows browser=2/robot=1;
  **fan-out** `itx.clients.call("/clients/browser", ["navigate"], [url])` ran `navigate` in BOTH tab processes
  (2 results); **inbox** `itx.clients.append` to the robot pushed to its `processEventBatch`; **death** — closing
  a tab's socket dropped it to 1 connection; **exclusive** — reconnecting the robot replaced the old (still 1).

---

## Increment 18 — capnweb at the EDGE, the DO doesn't pin: `connect → itx`, `itx.clients`, don't-pin

**Commit** `134aff35f`. Supersedes increments 6 + 17 (a clean break — no backcompat). Jonas pointed at two
worktrees: `dont-pin-capability-host` (PR #2424 — the transport) and `client-and-connections` (the `itx.clients`
API), and said use those APIs exactly, keep it simple, and implement `.connect`/`.clients` WITHOUT the stream-
connection machinery. Two hard rules landed together: **capnweb terminates ONLY in the stateless worker** (never
a DO), and a **connected client does not pin the DO**.

- **`/api` on the worker = the ONE capnweb entrypoint.** `newWorkersWebSocketRpcResponse` terminates the session
  against a `ProjectSession` (`core/itx-surface.ts`). It reaches the `ItxDurableObject` only over **Workers RPC**.
  The DO dropped its `capnweb` import, `ProviderControl`, `/connect`, `/register`, and all retained-stub state —
  it is now **pure Workers-RPC**.
- **`connect → itx` (get + presence).** `ProjectSession.get()` → the project `Itx` (the iterate-context stub);
  `ProjectSession.connect({ path, description, capabilities?, connectionKey? })` → the same `Itx`, plus the
  client is registered at `path` and its live `capabilities` are provided. Every connected client provides
  capabilities by connecting; `itx.provideCapability({type:"live"})` adds more. Both return exactly the itx.
- **The don't-pin transport (`core/hibernatable-pager.ts`).** The client's `capabilities` stub is retained in the
  stateless RELAY (the /api worker). The relay opens a **Hibernatable Pager** (a WS the DO accepts via
  `ctx.acceptWebSocket`, attachment `{ socketId }`) and records only `{ socketId }` in the DO — **no stub**. On an
  invocation the DO sends a `wake` **Page**; the relay hands back a short Workers-RPC **Invoker** leg for the
  burst; at quiescence the DO drops the leg and sends `idle`. So the DO holds a live reference only mid-call and
  hibernates in between (the 1000-idle-devices property).
- **`itx.clients` with NO stream-connection machinery.** A `.connect` client connection is just a live-capability
  lease tagged `{ path, connectionKey }`. `ClientCollection.get(path) → Client`; `Client.invokeCapability({path,
args})` **fans out** over the connections at a path (`Promise.all`, `[]` if none); `Client.connections()`,
  `getConnection(key) → ClientConnection` (single-target + `close()`), `ClientCollection.list()`. Reconnect under
  the same `connectionKey` replaces the dead predecessor. The apps/os stream `openConnection` + processors +
  presence-fact delivery are NOT ported (Jonas: implement it without them).
- **Proven** (deployed `connect-1`, real capnweb Node clients): dial `/api`, `connect` two tabs on
  `/clients/browser` → `whoami()` = `{projectId}`, `clients.list()` shows 2 connections; **fan-out**
  `clients.get(path).invokeCapability(navigate)` ran in BOTH tab processes (2 results); **DON'T-PIN** — after the
  call drained, `/state` = `{ pagers:2, leases:2, activeLegs:0, dormant:true }` (the DO holds NO leg while two
  clients stay connected); `itx.provideCapability({type:"live"})` → a `CapabilityProvision` with a relay-local
  `__leaseActive()`, and `itx.myComputer.ask()` reached the provider through a short leg; **death** — closing a
  tab's `/api` socket reconciled its lease → roster dropped to 1.
- **Deferred:** `processEventBatch` (the stream-inbox half — it IS delivery machinery, out of scope here); the
  full session/auth chain (`authenticate → Session → projects.get`; the clean room addresses by projectId via
  `/api?ctx=`); the pipelined `itx.a.b(x)` sugar (client-side over `invokeCapability`); lease reconciliation
  across a deploy (v1 reconciles on `webSocketClose`).

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
