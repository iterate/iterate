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

## Increment 19 — don't-pin PROVEN at 1000, and hibernation-safe by extracting a `LeaseServer`

**Commit** `7bd5bfec6`. Jonas: prove the DO really doesn't pin (1000 clients for minutes, then call one or two),
and cook the code down. Both, and they turned out to be the same fix.

- **The correctness fix (also the simplification): leases live in the Pager socket ATTACHMENT, not memory.** My
  increment-18 leases were an in-memory `#leases` map — which is **lost when the DO actually hibernates**, so a
  woken DO couldn't route a call. Now each lease is stamped into its hibernatable Pager socket's attachment;
  leases are **derived** from the surviving sockets (`pagerSockets` + `pagerAttachment`), so a fresh incarnation
  reads them straight back — nothing to reconcile. This is exactly the hibernation-survival property that makes
  the 1000-scale proof pass.
- **Extracted `core/lease-server.ts` (`LeaseServer`).** The whole don't-pin mechanism (records, wake/activate,
  acquire/invoke/release, fan-out, reconcile) moved out of the DO into one focused class the DO delegates to via
  a thin facade. `hibernatable-pager.ts` gained `pagerSockets` / `stampPager` and a generic `PagerRecord`. The
  DO dropped ~120 lines and is now a thin dispatcher (499 lines); the lease logic is 283 lines in one place.
- **PROVEN — the DO really doesn't pin** (deployed `leaseserver-1`, `prj_thousand`, real capnweb Node clients):
  **1000 clients connected** → `/state` = `{ pagers:1050, leases:1050, activeLegs:0, dormant:true }`. Held **180s
  idle**, then called `ping()` on **exactly two** (`/clients/c7`, `/clients/c42`) → `pong:7`, `pong:42`, and only
  those two clients' processes were touched. **incarnation went 4 → 11 during the hold — the DO truly HIBERNATED
  and was reconstructed ~7 times while 1000 clients stayed connected**, and every call still resolved (leases
  survived in the sockets). Back to `dormant:true` after. Definitive: 1000 connected, DO evicted repeatedly, only
  the two named clients woken.

---

## Increment 20 — cook down `worker.ts` (drop the increment 1–4 scaffolding)

**Commit** `10bdee661`. Jonas: keep cooking the code down. `worker.ts` was mostly walking-skeleton scaffolding
now superseded by `/api` + the capability model + the DO's real egress path. Removed the `EGRESS_WS_AGENT` /
`ITX_CALLBACK_AGENT` demo agents, `EgressEntrypoint` + `resolveFallback`, and the `/egress-test`, `/egress-debug`,
`/load`, `/provide` routes (the WS-through-stack + secret-substitution mechanics still live in `core/egress.ts`
and the DO's egress, just no longer behind ad-hoc proof routes). What remains is the real edge: `/api` (capnweb),
`/cap` (fetch lane), `/facet`, `/state`, `/call`, plus `DummyControlPlane` (solo fallback). **`worker.ts`: 273 →
96 lines.** Re-proven end to end (deploy `cooked-1`): the full connect/clients/provideCapability/don't-pin/death
proof still passes unchanged.

---

## Increment 21 — name it what it is: a **hibernatable stub**

**Commit** `dc1a299f2`. Jonas: "what is a lease-server? that needs a better name — is it really some kind of
hibernatable rpc stub?" Yes. workerd has no native hibernatable _outbound_ stub (retaining one pins the DO —
the whole problem), so this emulates one: the DO holds only a `{ socketId }` record on a hibernatable Pager and
materializes a real short-lived RPC leg on demand. So it IS a hibernatable stub. "Lease" was wrong (implies a
time-bound, renewable grant; this is just "alive while its socket is") and "server" said nothing.

- Renamed `core/lease-server.ts` → **`core/hibernatable-stub.ts`**; `LeaseServer` → **`HibernatableStubs`**;
  `LeaseRecord` → **`Stub`**; methods read honestly now (`park`, `invoke`, `activate`, `drop`, `all`, `state`).
- **Split so the mechanism stands alone.** `HibernatableStubs` is now provider-AGNOSTIC — it knows only
  `{ socketId }` + opaque meta and how to invoke a stub on demand (166 lines, was 290). The capability/client
  _semantics_ (what a stub represents, roster, fan-out) moved to the DO, where they belong — it's the capability
  host: `parkCapability` / `parkClient` / `activateStub` / `dropCapability` / `#capabilityStub` / the `itx.clients`
  methods, each a thin call into `#stubs`. `/state` fields renamed `leases`/`activeLegs` → `stubs`/`active`.
- Re-proven (deploy `stubs-1`): connect → itx, clients fan-out, `provideCapability(live)`, `dormant:true` while
  connected, and death all pass unchanged.
- **Known-fragile (design Q4, deferred):** `itx.clients` fan-out is `Promise.all`, so one dead-but-not-yet-
  reconciled connection rejects the whole call. Fine for v1; make it per-connection-tolerant when a real caller
  is burned.

---

## Increment 22 — cook-1: delete the pre-skeleton runner + the `web` mount + demo routes; deep facet dispatch; ONE fetch door

**Commit** `dce86527b`. First cook-down increment of the clean-room platform ("cook-1"): six deletions/collapses,
each proven on the deployment.

- **Deleted `src/index.ts` + `src/config-worker.ts`** — the pre-skeleton two-worker runner
  (`ProjectRunner`/`ProjectEntrypoint`/`ProjectAuth`, `CONFIG_WORKER_SOURCE`, the POST `/serve` cross-account
  dial) — and the "keep a live RUNNER binding resolving" re-export in `worker.ts` (backcompat cruft; prod is
  resettable). Cascade into the July control plane (repo-side only, NOT redeployed): the `RUNNER` service
  binding + the `PROJECT_WORKER_URL`/`RUNNER_DIAL_SECRET` HTTP dial removed from its wrangler/env;
  `dialProjectWorker` deleted; `/__ingress` still resolves host→project + stamps membership but returns 503
  `project dial removed (clean-room cook-1)`. **The DEPLOYED `control-plane` worker's runner dial is now dead
  until its own next increment.** `prove-twoworker.mjs`/`prove-apps.mjs` marked SKIP (one-line comments).
  `@v3/shared/dial` deleted (`StampedCaller` moved into control-plane ingress — its one consumer).
- **Deleted the `web` mount kind** — a fetch-shaped worker is just a `code` (stateless) mount whose `fetch`
  you call. `#fetchWeb` folded into `#fetchCapability`'s `code` branch (load via LOADER, mainModule `cap.js`,
  `getEntrypoint().fetch(request)`, a distinct `code-fetch:` cacheKey — same modules, different entry shape);
  the RPC lane keeps `#runCode`. The Mount union is 4-way: `itx-expression | static | code | stateful` (the
  further collapse to expressions-only is jam-gated).
- **Route collapse.** The edge surface is exactly `/version`, `/api` (capnweb), `/cap` (THE one fetch door),
  `/state`. Deleted `/call`, `/ws`, `/facet` at the worker AND, in the DO's `fetch`, the `/facet` branch + the
  hibernatable ingress-echo demo (`acceptWebSocket ["echo"]` + the `webSocketMessage` echo). The stateful
  fetch/WS lane rides `x-itx-cap` through `#fetchCapability`'s stateful branch — verified `/facet` carried
  nothing the cap lane doesn't (same source/class headers, same runner forward).
- **Deep dotted facet dispatch** (`StatefulWorkerDurableObject.invokeCapability`). `input.method` may be
  dotted (`"counters.add"` — the host's join-with-`"."` wire format is KEPT); previously a single
  `Reflect.get(facet, method)` missed and threw. Now: split on `"."`, walk intermediates with awaited
  `Reflect.get(receiver, seg)`, `Reflect.apply` on the terminal — receiver-preserving, exactly apps/os
  `replayPath` (live-capability.ts). The ⚠️ Reflect.apply GOTCHA block is preserved and extended with the
  segment-walk line. The seeded `Counter` gained a nested `counters` sub-object so the deep call is provable.
- **Deleted the no-op `idle` page.** `wake` is the only Page; at quiescence the DO silently drops its leg (the
  relay kept its retained provider either way — the record on the socket is the source of truth).
- **Small deletions:** unused `captureExpression` (the encode half; the codec is being redesigned in a jam);
  the itx-DO's three near-identical `LOADER.get` option-object blocks collapsed into one 10-line `#worker`
  helper (the stateful runner's stays where it is); project-worker's dead `RUNNER_DIAL_SECRET` var dropped.
- **Proven** (deployed `cook-1`, fresh `prj_cook1`, real capnweb Node clients — **13/13 PASS**):
  `connect() → itx → whoami` = `{projectId:"prj_cook1"}`; `itx.kv` put/get round-trips `"cook1-value"`; a live
  cap provided by client A invoked from client B (`echo-from-provider:hi`, `add(2,3)→5`) with `/state` =
  `{stubs:2, active:0, dormant:true}` (don't-pin intact); the seeded site as a **code** mount through the ONE
  door — `GET /cap?cap=["site"]` → 200 HTML AND a WS upgrade through `/cap` → `site-echo:hello-from-eyeball`
  (the web→code fold, a 101 through the graph); stateful shallow `increment(2)→2` AND the NEW deep
  `counters.add(3)→5`, `value()→5` (the segment walk); `/call` + `/ws` fall through to the help text, a bare
  WS to `/ws` gets no 101, `/version` + `/state` intact. (The ~50-client don't-pin mini-proof was skipped —
  the `prove_1000.mjs` harness didn't survive the scratchpad and was not rebuilt, per instruction; increment
  19's 1000-scale result stands.)
- **Net:** `index.ts` −175, `config-worker.ts` −53, `shared/dial.ts` −23, `worker.ts` 99→72,
  `itx-durable-object.ts` 578→554, `itx-expression.ts` 66→47, control-plane `ingress.ts` 79→40;
  `stateful-worker-durable-object.ts` 146→158 (the walk + its comment).

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

## Increment 23 (crisp-1): the codec + processors + routing table — the full resolved architecture

- **What:** the expression codec (both halves: JS-subset string grammar ⇄ structured steps; holes
  `?`/`?0`/`?name`/`...?`; match/substitute/evaluate/apply; frozen-wins spread-merge; terminal-fetch
  lane rule), the processor layer with the apps/os-mirrored API (defineProcessorContract,
  StreamProcessor reduce/processEvent, the five concurrency rules incl. strict per-event barrier +
  one-persist-per-batch + at-head pass + version-bump refold), and the capability host REBUILT as
  `IterateContextStreamProcessor` — reduced state IS the routing table (shadow stack: newest
  same-pattern wins, revoke-by-offset restores; longest-bound-pattern specificity; default-deny;
  `roots` in scope ONLY for config seeds — event provenance can't spell the physical layer).
- **The merge:** `StreamDurableObject` is THE parent (SQLite log + registry + every hibernatable
  socket + the fetch door + egress). Old ItxDurableObject + StreamDurableObject deleted
  (migrations v4-v7 incl. the 10061 two-step + shell re-point); `Roots` = the primordial scope;
  `provide(live)` = park + mount `pattern ⇒ itx.clients.get(socketId)` (the R13 desugar);
  dynamic workers = `itx.workers.get({type, source})` through seeds (Mount union deleted).
- **Naming (Jonas):** the DO is the STREAM; the iterate context is a PROCESSOR on it. Facet
  hosting of processors (ctx.facets.get + configure(parentName) + both kinds) is the NEXT
  increment — the registry is host-agnostic on purpose so processors don't change when it moves.
- **Proven:** 62 unit tests; live 16/16 on `crisp-1` (seeds, kv, live-cap with DO dormant,
  shadow stack override/restore/deny, mounted worker HTML + WS 101 via /cap, stateful deep
  dotted + env.ITX callback, clients fan-out). Live-only bugs: private-field declaration order;
  missing files/repo seeds; fetch-lane errors now surfaced with status.

## Increment 24 (facet-1): THE FACET SPINE — processors in real workerd facets

- `processor-facet.ts`: generic `ProcessorFacet` DO class hosted via `ctx.facets.get` on the
  Stream DO — identity via durable first-contact `configure({parentName, projectId, path, slug})`
  (plain data in the facet's own kv; survives restarts), back-channel BY NAME re-resolved per call,
  drive via `deliver(events, head)`; the SAME host-agnostic registry runs inside the facet.
  Demo built-in: `tally` (counts events by type, consumes "\*").
- Stream DO: `enableProcessor(slug)` (idempotent, durable slug list), post-commit drive of every
  enabled facet (FIRE-AND-FORGET on purpose — an awaited drive deadlocks if a facet processor
  appends; reads stay correct because `facetSnapshot` catches up from the log first),
  `facetSnapshot(slug)`, `/state.facetProcessors`.
- Proven live (prj_facet\*): cold catch-up of a pre-enable event; 3 provided + 1 revoked folded at
  offset 4; /state lists the facet; DO dormant. Deploy `facet-1`.
- NEXT: userspace (loader-loaded) facet processors through the same map; moving the
  iterate-context processor itself into a facet (needs the clients-view RPC facade on the parent);
  the hibernation-with-facet e2e (the dual-mode task's required test).

## Increment 25 (review-2): review round 1 findings fixed — 4 real bugs + regressions

- ⚠️ **await-your-own-append deadlock** + ⚠️ **cursor-gap skipping**: delivery is now
  CURSOR-DRIVEN (the committed batch is only a wake-up; every processor reads its own contiguous
  batch from its persisted cursor out of the log) and `deliver` never awaits a chain that is
  already mid-batch. Restores apps/os runner semantics (contiguity + safe self-append).
- ⚠️ **concurrent cold invokes** on one hibernatable stub now share the pending wake (`arrived`
  promise) — the second borrower no longer clobbers the first's resolver (which hung it forever).
- ⚠️ **resolver recursion guard**: `itx.x ⇒ itx.x` (or a re-missing default route) errors loudly
  at depth 32 instead of burning the DO; depth threads through the scope proxy + resolveCurrent.
- Stateless loader cacheKeys now fold in CF_VERSION_METADATA.id (the stale-isolate family the
  stateful runner documents); dropped the double catch-up before snapshots.
- +3 regression tests (65 total); live re-proof green on `review-2` (facet spine + full crisp).
- Round-1 backlog (SIMPLIFY/CLARITY, not yet applied): shared walkSteps in evaluate/apply; dedupe
  hashSource/deepEqual; delete ItxCallPath + explicit-empty-seeds semantics; stale runner-name
  comments; micro dead code (identical-branch ternary, #maybeWord alias, itx-surface path build).

## Increment 26 (polish-3): round-3 polish — the logged SIMPLIFY/CLARITY backlog applied

- `expression.ts`: ONE shared `walkSteps` (the receiver-carrying step walk) now backs both
  `evaluate` and `apply`'s remainder replay (the loop existed twice, verbatim); and a REAL BUG:
  `substituteArgList`'s `highest` scan now finds numbered `?n` holes RECURSIVELY (nested in
  objects/arrays) — `f({ a: ?0 }, ...?)` used to splice args[0] twice because the top-level-only
  scan never saw the nested hole (`$`-escapes stay inert). Micro: printValue's identical-arm
  ternary collapsed; `#maybeWord` (a pure alias of `#word`) inlined.
- Dedupe: ONE `hashSource` (new `core/hash.ts`; the Stream DO + the stateful runner import it);
  ONE structural deep-equal — `jsonEqual` exported from `core/events.ts` is now also the
  literal-arg matcher in expression.ts (its private `deepEqual` twin deleted).
- `core/config.ts`: dead `@deprecated ItxCallPath` deleted; DEFAULT_SEEDS now apply ONLY when
  APP_CONFIG is entirely absent — an explicit `{"seeds": []}` is DENY-ALL (previously it silently
  re-granted every default, which inverted the operator's intent).
- `stateful-worker-durable-object.ts`: stale header comments fixed — the runner name is
  `{projectId}::{path}::{className}:{sourceHash}`, set by StreamDurableObject's `#workersView`
  (the `{callPath}` suffix + `ItxDurableObject` mentions were pre-crisp-1 fossils).
- `itx-surface.ts` ClientConnection.invokeCapability: the head/rest/mid/last contortion is now
  `[...path.slice(0,-1), [path.at(-1), ...args]]`, with a loud guard for an empty path.
- +5 tests (70 total: nested-hole rest scan, config seed semantics). No deploy — rides
  increment 27.

## Increment 27 (userfacet-1): USERSPACE facet processors — loader classes on the facet spine

- `enableProcessor(slug, ref?)`: an optional `{ source, className }` ref makes the processor
  USERSPACE — the class arrives via the Worker Loader (source resolved through this context's own
  dispatch, the same repo-agnostic resolution as dynamic workers) instead of the built-in
  `ProcessorFacet` map. Durable record shape: `{ slug, ref? }[]` (was `string[]`; prod is
  resettable, no backcompat).
- The CONTRACT is duck-typed, uniform for both kinds: `configure(identity)` (may no-op),
  `deliver(events, head)`, `snapshot()`. The userspace class reaches its context via `env.ITX`
  (the parent stub) or the injected `itx.js`.
- Loader wiring mirrors the stateful runner's proven pattern: cacheKey
  `procfacet:{deployId}:{ctxName}:{slug}:{sourceHash}`, injected `itx.js`, `env.ITX` +
  `globalOutbound` = the parent by name, abort+recreate the facet on source-hash change (the
  VERSION_KEY marker pattern, keyed per slug — storage kept). The parent only ever calls the
  duck-typed methods directly (`facet.deliver(...)`), which is Reflect.apply-safe by construction.
- Demo `/user-tally.js` in HELLO_FILES: `UserTally extends DurableObject`, own cursor + counts in
  its own facet storage; `snapshot()` catches up from the stream via `env.ITX.read(cursor)` so
  reads are never stale despite fire-and-forget drives.
- Proven live (prove_userfacet.mjs): fresh ctx → enable user-tally (by source expression) + the
  built-in tally → 2 provides + 1 revoke → BOTH facets fold identically (provided:2, revoked:1,
  own cursor at offset 3); `/state` lists both. Deploy `userfacet-1`.

## Increment 28 (ictx-facet-1): the iterate context IS a facet — the parent is log+sockets+doors

- `IterateContextStreamProcessor` moved INTO the built-in `ProcessorFacet`
  (FACET_PROCESSORS["iterate-context"]). The Stream DO now delegates
  `invoke`/`invokeCapability`/`provideCapability`/`revokeCapability` and the whole `x-itx-cap`
  fetch branch to the facet (`#ictx()`: lazily enabled on first use, configured ONCE via a
  durable marker, added to the driven set so every commit drives it like any other facet). The
  in-DO `#registry`/`#capHost`/`#capReads`/`#roots`/`#clientsView`/`#workersView` wiring is
  DELETED — append no longer awaits any delivery (all processors are facets, all fire-and-forget;
  reads catch up from the log first, which keeps read-after-write).
- SOCKETS STAY PARENT-SIDE, forever: a public stub FACADE (`stubInvoke`/`stubFanOut`/`stubList`/
  `stubConnections`/`stubClose`) wraps the HibernatableStubs registry, and the facet's
  `itx.clients` view is thin RPC wrappers over exactly those five (parent resolved BY NAME per
  call — `roots-builder.ts` facetClientsView).
- ONE `buildRoots(deps)` (`roots-builder.ts`) assembles Roots for either host: kv/secrets/loader/
  fallback from the (inherited) worker env, the workers view (moved out of the DO verbatim),
  HELLO_FILES (own module `hello-files.ts`) — what varies (`invoke`, `context`, `clients`) is
  injected. The facet builds context stubs BY NAME (its own path resolves to the parent — the
  parent IS the stream) and wires `resolveCurrent` to a LOCAL loop (catchUp → snapshot →
  resolve; the recursion never hops back through the parent).
- The fetch lane is NATIVE facet fetch: the parent forwards `x-itx-cap` requests with
  `facet.fetch(request)` and the 101 tunnels (the stateful runner proved the pattern; now the
  main WS proof rides it: parent DO → iterate-context facet → loader worker).
- NO platform wall: all three live proofs pass IDENTICALLY on `ictx-facet-1`, first run — full
  crisp (16/16 incl. WS 101 via /cap, stateful deep dotted + env.ITX callback, live-cap
  park+alias, shadow stack, don't-pin dormant), facet spine cold catch-up, userspace + built-in
  tally side by side. 70 unit tests untouched (the processor is host-agnostic — that was the
  point). `/state` drops the in-DO `processors` list (facetProcessors + stubs remain).

## Increment 29 (ictx-facet-1, no code change): hibernation-with-facets e2e — proven, with a platform finding about long-idle relays

The required test (prove_hibernate.mjs / prove_hibernate3.mjs): fresh ctx → 2-3 capnweb clients
connect WITH capabilities (pagers parked) → enable tally + user-tally (+ iterate-context, the
capability host itself) → one provide → hold with sockets open and ZERO traffic → the DO must
evict + reconstruct (incarnation grows) → stubs still parked → cross-client invoke works.
**8 runs, ~70 min of holds. Every assertion PROVEN — but never all in one run**, and the reason
is a real workers.dev property, not a bug in the spine:

- **HIBERNATION WITH FACETS: PROVEN, 4 times.** incarnation grew 1→2 (480s hold), 2→3 (2×330s),
  1→2 (340s), 1→2 (2×340s) with `facetProcessors: [tally, user-tally, iterate-context]` listed,
  pagers parked, `dormant:true` throughout. Post-eviction, EVERYTHING rebuilds: facetSnapshot
  folds correctly from durable identity + the log in every run; dispatch through the rebuilt
  iterate-context facet works (surviving clients' calls executed the fan-out).
- **Stubs survive eviction:** runs with an eviction ended with a stub still parked (stubs=1) and
  readable — consistent with increment 19's 1050-pager × 7-eviction proof (that machinery is
  unchanged; sockets never left the parent).
- **Cross-client invoke after a LONG hold: PROVEN** (echo through wake→leg→invoke after 8-11 min
  holds, 3 runs) — but in those runs the eviction happened not to fire.
- **The platform finding, CORRECTED by independent re-measurement (2026-08-18,
  `research/ws-lifetime-analysis.md` — the paragraph below supersedes this increment's original
  claim):** actor eviction and edge-socket death are INDEPENDENT, not coupled — a DO evicted and
  reconstructed (incarnation 1→2) while its relay's client socket stayed open for 28 minutes,
  and 30s client→edge heartbeats did NOT keep the actor warm (its DO evicted too; the earlier
  keepalive correlation was a confound). What kills an idle relay is probabilistic reclaim of
  the idle edge invocation: 14 deaths at 158–1203s (median ~5.6 min, no fixed constant, always
  1006/no close frame), with different-aged sockets co-dying <2.5s apart — per-process
  recycling, not an idle timer. WS pings don't protect (3×); unrelated HTTPS to the same worker
  doesn't protect (2×); only on-socket application traffic did (30s `session.get()`, 28 min,
  0 deaths). A non-Cloudflare idle control survived the whole window (local network exonerated).
  The pager hop is independently mortal as well — a live client socket is not evidence the
  parked provider is still reachable; reconnect heals both hops. Controls (bare ctx +
  sockets-only ctx, no facets) both evicted at 300s, so facets do NOT prevent hibernation —
  that part of the original finding stands.
- **Design stance (owner, 2026-08-18): socket death is FINE.** Clients endeavour to reconnect
  the moment a socket dies (parkClient replaces by connectionKey); Cloudflare reclaiming idle
  edge invocations is exactly why the platform is cheap, and we want it that way. NO keepalive
  machinery. One future option, deliberately not built: when an inbound hibernatable
  capability's pager is gone, the host could wait a few seconds for the provider to reconnect
  before failing the invoke — keyed by connectionKey/capability path, NOT the dead socketId
  (reconnect mints a fresh socketId).

## Increment 30 (kenton-1): the Kenton-bar review — simplicity/clarity/elegance pass

- Full findings (incl. what was deliberately NOT changed): `REVIEW-KENTON.md`. Net −49 lines.
- **One honest way per thing:** ONE `pathProxy` (core/expression.ts) replaces the three verbatim
  accumulating proxies (itx scope symbol, facet clients view, stateful-worker proxy); ONE
  `confinedWorker` (core/agent-runtime.ts) replaces the three verbatim loader wirings and states
  the confinement invariant once (`itx.js` injected; `env.ITX` + `globalOutbound` = the owning
  context); ONE `ExpressionSchema` (the codec owns its wire schema); ONE `disposeStub`;
  `#ictx()` enables through `enableProcessor` instead of re-implementing it;
  `ProcessorFacet.snapshot` reads through `registry.reads` instead of the registry's private
  storage key (also: empty-stream state is now schema-initial, not `{}`).
- **Two real bugs:** the must-use rule's `walkHoles` had its own hole detector that descended
  into `$`-escapes (disagreeing with match/substitute; now classifies via the shared `holeKind`,
  +regression test); the user-tally demo folded the DELIVERED batch — a dropped fire-and-forget
  drive would have left a permanent gap (now folds from its own cursor on every wake).
- **Honest signatures:** `registry.deliver()` is nullary (it ignored both params since delivery
  went cursor-driven in increment 25; the duck-typed facet contract keeps `deliver(events,
head)` — userspace processors really use them); Env interfaces trimmed to what each class
  touches; itx-surface params typed `string | Expression` (inline `import()` casts deleted).
- **Fail early:** a Stream DO / stateful runner reached without a name now throws instead of
  fabricating a `"?"` project / garbage host stub.
- **Subtractive:** `isFetchTerminal` (nothing consulted it — the lane is header-driven and
  `resolveFetch` normalizes), `parentPath`, `registry.names`, the unused public `itx` getter,
  the empty `processEvent` override, the redundant per-batch refold, `CF_VERSION_METADATA.tag`.
- 70 unit tests green (−1 dead spec, +1 regression); typecheck clean. Deploy `kenton-1`:
  all three live proofs ALL PASS first run (crisp 16/16, facet spine, userspace + built-in
  tally side by side).

## Increment 31 (annotations-1): the owner's Plannotator verdicts on REVIEW-KENTON

Six annotations, six resolutions (detail: `REVIEW-KENTON.md` § RESOLVED):

- **Bare `itx(...)` is now a LOUD ERROR at all three doors** — the parser rejects `itx(1)`, a
  zero-segment `pathProxy` apply throws (so every dotted view shares the rule), and `route`
  closes the hand-crafted `[["itx", …]]` Expression door. One greppable message: "cannot call
  the scope symbol itself — name a capability first". The bare-PATTERN default route
  (`{ pattern: "itx", … }` claiming whole missed calls) is untouched — the rule is about
  CALLING the scope symbol, not naming it.
- **`Itx.whoami()` deleted** — `invokeCapability({ path: ["whoami"] })` is the one door; the
  seed and `roots.whoami` are unchanged. Proof harness updated.
- **HibernatableStubs errors carry the socketId** (all five throws).
- **`waitUntilProcessed` KEPT with evidence:** apps/os `rpc-targets.ts` has ~25 production call
  sites — it is THE read-your-writes barrier (append → waitUntilProcessed → snapshot), not
  incidental complexity. Its home after the registry collapse is a jam-doc question.
- **Registry shape + `configure`** → next design leg, jam doc at
  `apps/os/docs/simplification/wayfinder/innermost-core/processors-jam.md` (streams, stream
  processors, dynamic worker loading; direction: facets-only + base class, future
  own-DO placement woken the same way).

72 unit tests green (+2), typecheck clean. Deploy `annotations-1`: crisp proof 16/16 first run.

## Increment 32 (lessons-1): the two APPLY verdicts from the Kenton cross-reference + the WS-lifetime correction

From `research/kentonv/lessons-for-clean-room.md` (28 lessons; 19 ALIGNED, 7 DISCUSS, 2 APPLY):

- **APPLY 1 — inherited built-ins are not capability surface** (the workerd PR #1028 exposure
  doctrine, enforced at THE dispatch point): `stepGet` in core/expression.ts replaces bare
  `Reflect.get` in `walkSteps` and the stateful runner's dotted walk — the three magic names
  never resolve, and anything IDENTITY-equal to an Object/Function.prototype built-in reads as
  missing (identical error to a genuinely absent step, so callers cannot probe). Identity-based
  on purpose: descriptor walks would break Proxy views (pathProxy, capnweb/Workers-RPC stubs).
  Own overrides still pass. The parser's name blacklist stays as client-side convenience;
  the structured-Expression and dotted doors it never covered are now closed. +2 tests.
- **APPLY 2 — a DO that never writes must never mint storage** (the workerd PR #6101 doctrine):
  the Stream DO constructor no longer touches storage. `#touch()` — called from append,
  enableProcessor, parkCapability, parkClient — runs the named-id guard BEFORE the first write,
  creates the events table, and bumps the incarnation once per WRITING incarnation (the
  hibernation tell survives; workless constructions no longer count, which is the point).
  `read()` answers `[]` on a virgin stream without creating the table; `/state` is read-only
  (a probed ctx reports incarnation 0 forever and leaves nothing behind — verified live:
  two probes of a fresh ctx, no storage, incarnation stays 0).
- **The 7 DISCUSS lessons await the owner** (front-door `?ctx=` introduction; facet-fold vs
  parent-durability output-gating; and five more — see the lessons file).
- Also this increment: BUILD-LOG increment 29's platform finding CORRECTED per the independent
  WS-lifetime measurement (`research/ws-lifetime-analysis.md`) — see the amended increment-29
  section: eviction and socket death are INDEPENDENT; keepalives were a confound; owner's
  stance recorded (ephemeral sockets, reconnect-on-close, NO keepalive machinery).

74 unit tests green (+2), typecheck clean. Deploy `lessons-1`: crisp 16/16, facet spine,
userspace + built-in tally side-by-side — ALL PASS first run.

## Increment 33 (verdicts-1): the owner's 9 jam-appendix verdicts — small approved items applied

- **`authenticate()` shipped as the introduction door, deliberately a NO-OP** (owner: "implement
  .authenticate() now but it should not actually do anything… call it on the main rpc stub and
  get an authenticated session"): `ProjectSession.authenticate(credentials?)` returns the
  session; the real check lands there later without changing any caller.
- **ONE non-resetting depth budget** (`deeper`, cap 64, lives beside `jsonEqual` in
  core/events.ts) guards every recursive JSON walk: the parser's `#value`, `substituteValue`,
  the boundary-arg hole scan, the must-use walk, `jsonEqual`. Never resets at argument
  boundaries (the receiver-side-limits rule). +1 test.
- **The loader cacheKey is now documented as a DOLLAR AMOUNT** at `confinedWorker` — the
  apps/os PR #2504 incident (~3.9M per-request-nonce identities ≈ $7.8k/3wk at
  $0.002/worker/day, cold ~5MB isolate builds per dispatch) plus the binding-liveness tension
  the nonce papered over. Our keys stay deploy × context × content hash; NEVER a nonce,
  timestamp, request id, or offset.
- **Remote processors deleted from the jam plan** (owner: "for now just assume all processors
  run in a facet"); the routing-table circularity worry recorded for whenever remote returns.
- Doctrine closed: whole-project trust is deliberate (attenuation = context granularity).
- IN FLIGHT (two research agents): cloudflare/os + workerd error taxonomy + what capnweb
  preserves in transit → `research/error-handling.md`; workerd facet output-gating + issue
  #6800 idle-billing don't-trigger rule → `research/facet-gating-and-idle-billing.md`.

75 unit tests green (+1), typecheck clean. Deploy `verdicts-1`: crisp proof 17/17 first run
(including the new authenticate() check).

## Increment 34 (verdicts-2): coded errors — the cloudflare-os steal (research verdict for jam B6)

Research (`research/error-handling.md`, runtime-verified): capnweb coerces custom error NAMES
and drops subclass identity, but preserves ALL own enumerable properties across the wire — and
with enhanced_error_serialization own props survive native Workers-RPC hops too. cloudflare-os
(github.com/cloudflare/cloudflare-os) uses exactly that channel: plain Error + a `code`
own-property via Object.assign, defined once, read with `"code" in error` — never name,
instanceof, or message regex. workerd stamps its own flags (`.retryable`, `.overloaded`,
`.durableObjectReset`) on the same channel.

Stolen: `core/errors.ts` (`codedError`/`errorCode`, SCREAMING_SNAKE codes, ~25 lines).
Three call sites: default-deny throws `NO_CAPABILITY_MATCH`; idempotency conflicts throw
`IDEMPOTENCY_CONFLICT` + `data.existingOffset`; the fetch lane's 404 now classifies BY CODE
(the message-regex fragility the owner flagged is gone). Human messages verbatim — the code
rides beside them, never instead. 75 tests green; deploy `verdicts-2`: crisp 17/17, live
fetch-lane miss = 404 by code.

## Increment 35 (pump-3): THE COLLAPSE + THE SDK + THE PUMP + EPHEMERALS + QUIESCE (jam increments 1+2)

The owner's go: "implement the cleanest possible version of all we said." Four suites live
ALL PASS (crisp 17/17, facet spine, userspace SDK tally, the NEW ephemeral suite 9/9).

- **The registry is DEAD.** `StreamProcessor` (core/processor.ts, 446→~370 lines and now
  dependency-free, types only) is a PURE class that IS its own runner: the five rules, the
  cursor, refold, `wake()`, `processEventBatch(events, window)`, `snapshot()`,
  `waitUntilProcessed()`. The durable objects around it are thin shells: the built-in
  `ProcessorFacet` and the injected userspace `ProcessorFacetRunner` are each five one-line
  forwards plus construction. `runnerHooks`, `reads()`, `catchUp(name)`, `register()` — gone.
- **DELIVERY IS PUSH-FIRST with the scan-window proof.** Append assigns offsets from ONE shared
  sequence, commits durable rows, then PUSHES `processEventBatch(batch, {scannedAfterOffset,
scannedThroughOffset})` into every facet row, fire-and-forget. Contiguous window → fold with
  ZERO log reads (proven in unit tests); gap → cursor-driven repair; stale → no-op. `deliver`
  and every nudge concept are dead.
- **EPHEMERAL EVENTS, end to end** (owner: "we absolutely must have ephemeral events"):
  `ephemeral: true` on the envelope (idempotencyKey rejected, loud both locally and across
  capnweb); offsets consumed from the shared sequence, bodies NEVER in the log (no ring —
  pushes deliver them; nothing can redeliver, by design); THE one deliberate write per append
  batch (`maxAssignedOffset` kv — offset reuse is a corruption class); ephemeral-only windows
  persist NOTHING processor-side; "_" never sweeps — naming the type is the opt-in; refolds are
  durable-only. Live: 3 chunks + 2 marks, named consumer folds all 5, "_" tally sees marks
  only, both cursors at 5 over the holes.
- **THE SDK** (owner: "the base class is part of our SDK… isolates absolutely get zod and
  userspace contract schemas"): build-sdk.mjs bundles src/sdk.ts (base class + the zod
  contract helper + zod itself, 308 KiB min) into a generated module injected as
  `processor.js`; the generic `ProcessorFacetRunner` DO rides beside it as `runner.js`.
  Userspace writes EXACTLY what built-ins write — user-tally went from a 17-line hand-rolled
  cursor loop to a contract + reduce on the base class; `ref.className` → `ref.export`.
- **THE #6800 QUIESCE:** 60s after the last append/materialization, the parent's alarm aborts
  every facet (`ctx.facets.abort` — storage kept, next push rebuilds; loss-free per the
  output-gate research). Alarm arming is deduped (one write per quiet-period start, never per
  append). Facet stubs are never retained across bursts.
- **`Itx.invoke(expression)`** — the generic client door for FULL expressions (mid-path call
  args: `itx.streams.get('/').append({...})`), found missing when the ephemeral proof tried to
  ride the fetch lane with a non-fetch terminal (the 500s that "failed" were the terminal-fetch
  rule working; the appends themselves committed).
- Parent `read()` now answers `{events, scannedThroughOffset}` — the scan-window proof on pulls.

79 unit tests green (the registry suite rewritten class-direct with a DO-faithful in-memory
pump; +push-door and ephemeral blocks), typecheck clean.

## Increment 36 (push-1): PUSH MODE — the stream-held cursor + retry/skip/halt ladder (jam increment 3)

- **One push mode replaces three apps/os receiver kinds** (itx-call/webhook-post/copy-to-stream):
  a row `{name, target, consumes?, onFailingEvent}` whose `target` is an itx PATH expression —
  the sender turns the terminal segment into the call `(events, window)` per durable batch, and
  the AWAITED call resolving IS the ack (20s watchdog). Push rows never see ephemerals; their
  cursor still advances over ephemeral offsets via scan windows. Verbs: `subscribe` /
  `unsubscribe` / `resumeSubscription` (DO + Itx); `/state` reports every row's cursor + ladder.
- **The ladder, no dead-letter on purpose** (apps/os proves halt+skip+audit suffices): bounded
  retries (1s·2^n, cap 30min, ±20% jitter, 15 attempts) → poison isolation (`skip`: pin the
  batch to 1; 3 failures → skip + `subscription-event-skipped` audit fact on the stream) → HALT
  (audited via `subscription-delivery-halted`, resumable). One in-flight delivery per row; the
  commit path never awaits a subscriber; retries ride the (deduped) alarm.
- **The stateless `processEvent` worker is one row, not a subsystem:** live proof — digest.js
  (a plain code cap) driven at `itx.digest.run`, 3 marks digested; a POISON mark pinned, failed
  3×, skipped with the audit fact, and the good mark behind it delivered; row alive at the head
  with `skipsSinceSuccess: 1`. ALL PASS first run.

## Increment 37 (address-1): THE FACET ADDRESS (jam increment 4)

- **`facetInvoke(slug, path, args)`** — ONE generic parent door: facet resolved locally (facet
  stubs are non-transferable; the walk happens where the stub lives), `stepGet`-guarded dotted
  walk, terminal `Reflect.apply`. A facet hosts a durable object with ANY methods; processor is
  a role.
- **`roots.facets` + one seed (`itx.facets ⇒ roots.facets`)**: every facet is an ordinary
  address — `itx.facets.get('tally').snapshot()`, aliasable (`itx.counts ⇒ …`), shadowable,
  probe-resistant (inherited built-ins read as missing through the address too). The barrier
  verb rides it: `itx.facets.get(slug).waitUntilProcessed({offset})`.
- **`facetSnapshot` is now sugar over the address** (Itx-side; the dedicated DO door died).

Whole-board regression on `address-1`: crisp 17/17, facet spine, userspace SDK, ephemeral 9/9,
push 6/6 — ALL PASS. 79 unit tests, typecheck clean.

## Increment 38 (verdicts-4): the hunt's approved fixes

- **Print/$-escape round trip fixed** — printing no longer unwraps `$`; `{ $: ?0 }` round-trips
  (frozen data can never become a live hole). +1 test.
- **THE LADDER RESTRUCTURE (owner-approved as conceptually simpler):** one retry ladder to a
  per-row `maxAttempts` (default 15); ONLY at exhaustion does `onFailingEvent` speak — halt
  halts, skip drops exactly the pinned event with the audit fact. And a clean delivery resets
  the WHOLE ladder including `skipsSinceSuccess` — consecutive now means consecutive. A target
  outage and a poison event ride the same predictable ladder. (The push proof deliberately
  subscribes with `maxAttempts: 2` — full-default poison isolation takes hours by design.)
- **Fetch-lane guard:** a terminal `fetch(...)` carrying expression args is a LOUD error
  (the Request rides in as the runtime arg); the silent drop is gone. All fetch shapes
  re-verified: bare terminal, explicit `.fetch`, WS 101, facet fetch, stateful fetch.
- **THE RESURRECTION PASS (owner: "fix this then"):** the first alarm of each incarnation asks
  every facet for a snapshot — a behind facet gap-repairs from its own durable cursor, a
  caught-up one no-ops; quiesce/abort waits for a later pass so it never races a fold it just
  revived. An eviction mid-batch with no follow-up traffic now self-heals (the append-armed
  alarm survives eviction).
- Dead code out: `#running` (unreadable), numeric holes in the must-use walk (meaningless —
  a numeric hole in a pattern binds nothing). Runtime floor noted: workerd ≥ 2026-07-02
  (older alarm-woken-DO name bug not worked around, per owner).

80 unit tests green; deploy `verdicts-4`: full board ALL PASS (crisp/facet/userspace/
ephemeral/push incl. the new consecutive-skip-reset assertion/facet-address).

## Increment 39 (entry-1): the IterateContextEntrypoint — loaded workers never hold a raw DO stub

Owner (2026-08-18): for restorable/KV-cached capability futures, "I wouldn't do
env.CONTEXT.getByName — I would go through an iterate context entry point for now just to get
ahead of that."

- **`IterateContextEntrypoint`** (new, ~80 lines): a props-parameterized loopback
  WorkerEntrypoint (`ctx.exports.IterateContextEntrypoint({ props: { contextName } })`) that is
  now EVERY confined dynamic worker's whole world — `env.ITX` and `globalOutbound` at all three
  loader sites (stateless code caps via roots-builder, userspace processor facets, the stateful
  runner). Surface = exactly what loaded code speaks: invokeCapability / invoke / append /
  read / fetch, each forwarding to the owning Stream DO by name TODAY — a swappable
  implementation detail, not the stub's identity.
- Why now (the doctrine): (1) THE INTERPOSITION POINT for the KV-cached-capabilities future —
  DO-free capabilities get served right here without waking the DO, when we build that;
  (2) Kenton-aligned persistence-ready — ctx.exports-minted stubs are exactly what the shipped
  persistent-stub machinery can store and replay (raw getByName env-binding stubs can NEVER
  be stored); a future `[restore]` lands on this class and resolves through the ROUTED door,
  keeping deletion-is-revocation for stored stubs; (3) matches apps/os verbatim (its loaded
  workers get `env.ITX = ctx.exports.ItxEntrypoint({props})` — we were behind both).
- The stateful runner's #hostStub split into #hostName (the codec name) + #hostStub (module
  resolution only); the hosted class's env.ITX rides the entrypoint.
- Also this session: verified LIVE that production Cloudflare accepts
  `allow_irrevocable_stub_storage` (deployed with the flag, then reverted — nothing uses it
  yet). The restore machinery is shipped and available to us today.

80 unit tests green; deploy `entry-1`: full proof board ALL PASS (crisp/facet/userspace/
ephemeral/push/facet-address) — stateless run+fetch, stateful env.ITX callback, and the SDK
runner's append/read all riding the entrypoint.

## Increment 40 (restore-2): Kenton's persistent-stub machinery IN USE (owner: "that's really what I want")

- **The flag is ON everywhere:** `allow_irrevocable_stub_storage` in wrangler.jsonc AND on
  every loader-loaded isolate (confinedWorker compatibilityFlags) — the whole chain is
  restore-eligible, which the gating requires of every member.
- **The demo is Kenton's own motivating shape:** `/keeper.js` — a USERSPACE durable object that
  `storage.put`s its live capability handle (`env.ITX`, the ctx.exports-minted
  IterateContextEntrypoint stub — increment 39 is what made this storable at all) and later
  calls through the handle read back from storage. `storage.put` throws for any non-restorable
  stub, so put succeeding + the restored call answering IS the machinery working.
- **Proven live TWICE over:** (1) same-run stash → restored whoami → second load replays again
  (`prove_restore.mjs`, ALL PASS first try); (2) THE CROSS-DEPLOY PROOF — handle stashed under
  `prj_keepx42` on deploy restore-1, then a full redeploy (restore-2) killed every isolate that
  minted it, then `useStashed` answered correctly: the restore chain replayed across total
  isolate death. This is the property the whole KV-cached-capabilities future rests on.
- Doctrine note: stored handles ride the ROUTED entrypoint (whoami resolves through the table),
  so deletion-is-revocation is preserved for stored stubs exactly as the alignment doctrine
  demands — we use his irrevocable-storage machinery without inheriting its irrevocability.

80 unit tests green; deploy `restore-2`: full seven-suite board ALL PASS (crisp/facet/
userspace/ephemeral/push/facet-address/restore).

## Increment 41 (rich-1): rich values EVERYWHERE + the loader unification (hunt round 3, annotation 2/6)

Owner: "anything workers RPC and capnweb can serialise obviously should be able to be passed
through these capabilities and through invoke — very important."

- **Measured first, on the longest path in the system:** a client callback crossed capnweb →
  edge → Workers RPC → Stream DO → ictx facet → stub facade → pager wake → Invoker leg → relay
  → the providing client, which called it BACK across everything (42→43). Dates arrive as
  Dates, bytes as bytes. ALL PASS against the UNCHANGED deploy — the codec never JSON-ifies
  (substitution passes non-JSON values through untouched); only the event LOG serializes, as it
  must. The frames-on-the-pager transport proposal is DEAD (owner ruling) — the Workers-RPC
  Invoker leg stays precisely because rich values must flow.
- **The one real JSON boundary, fixed:** the stateless run lane tunneled args as a JSON fetch
  body. CODE_CAP_RUNNER is now a WorkerEntrypoint whose `run(...args)` is a real RPC method —
  proven live: a confined loaded isolate received a real Date and CALLED THE CLIENT'S CALLBACK
  (7×6=42).
- **Loader unification (the hunt's kept findings, in the same files):** run/fetch = ONE
  wrapper, ONE isolate, ONE billed identity per source (code-fetch: key family gone); cacheKeys
  are MINTED INSIDE confinedWorker (`kind:deploy:owner:contentHash`, kind a closed union — the
  one audit point for the dollar lever, with the loud pricing comment); `workers.get` drops the
  `type` discriminator (className present = durable class, absent = run/fetch; old `type:` refs
  stay accepted-and-ignored, so existing mounts keep working).
- "Run code in this context" documented as THE fundamental context operation (owner's
  annotation 5) at the workers view — the crisp named API question continues in the doc.

80 unit tests green; deploy `rich-1`: EIGHT-suite board ALL PASS (crisp/facet/userspace/
ephemeral/push/facetaddr/restore/rich).

## Increment 42 (codec-2): THE MATCHER COLLAPSE + spentArgs + explicit rest (hunt round 3, annotations 1+9)

Owner: "just matched prefix length… apps/os really just matches an array of strings — we don't
want to go much more complicated"; and args must not bind across multiple invocation sites.

- **THE ranking rule is now one sentence:** element by element from the start; the longest
  matching prefix wins; ties go to the newest mount. `Match.specificity: number[]` and
  `compareSpecificity` are DELETED — `Match.matchedSteps` is a single integer (the pattern's
  length). Literal args decide only WHETHER a step matches, never how well. Mid-path literal
  calls are ordinary steps (`itx.streams.get('/bla').append` = a 4-step pattern — the owner's
  own example). Documented behavioral change: an equal-length literal pattern and hole pattern
  now TIE (recency decides) where lex ordering made the literal always win.
- **Single-binding-site rule:** a pattern may bind caller args at ONE call step only —
  provide() rejects patterns collecting input across several invocation sites.
- **`substitute` returns `{ steps, spentArgs }`** — the did-the-target-consume-the-args verdict
  is now a byproduct of consuming them; the standalone `usesCallerArgs` walker (the third
  hole-classifier, the drift class that shipped two codec bugs) is DELETED.
- **Rest is explicit:** `...?n` = args.slice(n) in a call-arg list (the old
  `...?n`-means-object-copy overload is gone); bare `...?` = ALL the args, and a LOUD error
  beside numeric holes ("say ...?n") — the inferred splice start that shipped the increment-26
  double-splice bug can no longer be spelled.
- **Table-based tests** (the owner's ask): match and substitute are now `test.each` tables —
  every rule visible as a row of [pattern, call, expected].

87 unit tests green (+7); deploy `codec-2`: EIGHT-suite live board ALL PASS unchanged — the
collapse is observably equivalent for every shipped mount shape.

## Increment 43 (vocab-1): THE ROOTS-FLATTEN + itx.stream / itx.contexts (the vocabulary collapse)

Two adopted hunt collapses, one increment (they churn the same seeds/tests/proofs):

- **The Roots object is DELETED.** `buildHostScope` returns a plain record whose KEYS are the
  expression roots (whoami/kv/repo/secrets/stream/contexts/clients/facets/workers/files/
  bindings) — the RpcTarget shell was vestigial since increment 28, and deleting the object
  deleted its naming debate (nothing is left to name). The provenance gate is now visibly a
  scope-KEY-SET decision: seeds resolve against `{ ...hostScope, itx }` (itx LAST — no
  host-scope key can shadow the resolver; the builder asserts it never registers `itx`), event
  mounts against `{ itx }` alone. `provide()` checks `target[0] !== "itx"`;
  `evaluate` uses `Object.hasOwn` (the `in` operator leaked Object.prototype names as phantom
  roots). Seed targets read `kv`, `stream`, `bindings.get('FALLBACK')`.
- **ITX-vs-STREAM closed as ONE concept ("stream" stays THE noun — owner).** `itx.streams` is
  GONE. `itx.stream` = MY OWN stream, a deliberate chosen surface (append/read — never the raw
  DO stub, closing the leaked-DO-surface hole): the commonest write is now dotted-door
  spellable (`itx.stream.append({...})`). `itx.contexts.get('/x')` = sibling contexts,
  ROUTED: calls resolve through the SIBLING's own table (its mounts answer, its default route
  falls through) — attenuation-by-context is now spellable
  (`provide({pattern:'itx.bot', target:"itx.contexts.get('/agents/bob')"})`); append/read
  skip the facet hop (the physical fast path).
- **The recovery kit, pinned:** doors you need when routing is broken must not route — and all
  three already exist natively: `DO.revokeCapability` (a direct append),
  `DO.read` (the unrouted log), `facetInvoke('iterate-context', ['snapshot'])` (the unrouted
  table dump). No new code; the rule is now written down here.

87 unit tests green; deploy `vocab-1`: NINE-suite live board ALL PASS (crisp/facet/userspace/
ephemeral/push/facetaddr/restore/rich — proofs re-spelled to itx.stream). Bonus sighting: the
default-deny error crossed capnweb carrying `code: NO_CAPABILITY_MATCH` — the coded-error
channel visibly at work.

## Increment 44 (edge-1): the edge-adoption batch + the smallest possible repo

- **One-shot HTTP at `/api`:** `newWorkersRpcResponse` serves BOTH the WebSocket upgrade and a
  plain HTTP batch — a CLI script or cron does one POST, no socket handshake (live-proven with
  `newHttpBatchRpcSession`). Batch sessions can't hold live capabilities (the relay must
  outlive the response) — the park call failing is the honest error.
- **Dead clients clean up instantly:** `ProjectSession[Symbol.dispose]` tears every relay down
  when the /api session ends, and `onRpcBroken` on each retained provider closes its pager the
  moment the client's session breaks — the DO reaps parked stubs immediately instead of the
  roster lying until an invoke hits the 10s attach timeout.
- **`Itx.fetchCap(cap, request)`:** the commissioned Upgrade-Response-over-RPC fork feature,
  finally used — fetch-shaped capabilities (including 101s) ride the capnweb session itself; a
  capnweb client needs no separate /cap door (the door stays for plain-HTTP callers).
- **`disableProcessor(slug)`:** the missing off-switch — removes the row and DELETES the facet
  (fold storage included; it is derived state, rebuildable from the log by re-enabling).
  iterate-context refuses to be disabled.
- **THE SMALLEST POSSIBLE REPO (owner's annotation 3, the seam):** `files.read` falls back to
  the repo store — `itx.repo.put('/mine.js', src)` then
  `itx.workers.get({ source: "itx.files.read('/mine.js')" }).run()` runs REAL project-authored
  source (live-proven, with an itx round trip inside the loaded worker). The apps/os repo DO
  grows from exactly this seam; the runner-into-stream/home-path design continues in the doc.

87 unit tests green; deploy `edge-1`: NINE-suite board ALL PASS (+prove_edge 4/4).

## Increment 45 (subs-1): SUBSCRIBING IS PROVIDING — the last adopted collapse, built

- **A subscription IS a mount** at `itx.subscribers.<name>`: `subscribe` is sugar that appends
  the ordinary capability-provided event with the DELIVERY POLICY riding the same event
  (consumes/onFailingEvent/maxAttempts/start in the payload) — subscription config is now
  event-sourced like every other claim, never silent kv. `unsubscribe` = revoke the winning
  mount; revoke doubles as cursor GC.
- **The parent folds its projection INLINE in `append`** (it sees every event body at the
  commit point — no facet round trip, no cache staleness): exact
  `["itx","subscribers",<name>]` provided/revoked events maintain the derived rows + cursors.
- **Cursors are keyed by `providedAtOffset`** (the row's identity): same-name re-provides STACK
  — the shadowed row's cursor FREEZES; revoke pops and it resumes exactly where it stopped
  (freeze-and-fork wiretaps, free from the shadow stack). `resumeSubscription` survives as the
  one cursor-surgery verb.
- **Delivery is BY ROW IDENTITY through the ictx facet** (`deliverSubscription(offset, events,
window)` → the processor's `deliverTo` finds the mount in its fold and runs the ordinary
  substitute+apply tail: hole-free target → called with (events, window); hole-bearing →
  reshaped, adapter-free). Never by name through the table — a broad default route cannot
  intercept deliveries. The ladder/skip/halt machinery is unchanged and re-proven live
  (prove_push ALL PASS on the new storage, byte-identical behavior).

## Increment 46 (rich-2 checks, same deploy): the owner's rich-value clarification, proven wider

- **RpcTarget-with-methods as an arg:** provider called TWO methods on the client's object
  (write/write/dump → "one|two"). **HTTP Request in, Response out** through a live capability:
  201 + URL + body intact. Both live ALL PASS. Callbacks were already proven (41).
- **fetchCap honesty note:** plain Responses ride the INSTALLED fork (0.10.0 — proven twice:
  the 200 HTML and the 201 return). WebSocket/101 THROUGH fetchCap is NOT proven and may
  depend on the unmerged capnweb PR — the /cap door stays for WS callers until that lands or
  is rejected. ReadableStream args also not yet proven (the stream-serialization lane exists
  in the fork; queued with the voice firehose work).

87 unit tests; deploy `subs-1`: board re-proven (crisp/ephemeral/facetaddr/edge/userfacet/
restore/push/rich) ALL PASS.

## Increment 47 (tsrunner-1): the injected runner is real TypeScript

`src/runner-entry.ts` typechecks against the SAME StreamProcessor/FacetIdentity types the host
compiles; build-sdk.mjs bundles it (cap.js/processor.js/cloudflare:workers external, 0.9 KiB)
into `generated/processor-runner.ts`. The hand-written template string in agent-runtime — the
drift class where the injected duck quietly diverges from the host contract — is deleted.
Loader-touching suites re-proven live (userfacet/ephemeral/push/restore ALL PASS).

## Increment 48 (live-3): LIVE STATE — the third delivery mode, built (design B, snapshots-first)

- **One platform nudge type** (`live-state/changed`, ephemeral, payload {key}) that NOTHING can
  consume — `#consumes` refuses it before contracts are consulted (owner's rule): the feedback
  loop is unspellable, not discouraged. Emission is gated on THE FOLD OUTPUT changing (never
  cursor/window movement), so offset-counting folds terminate in one bounce.
- **A live-state subscription = the same mount** with `delivery.liveState: {key, get}` — NO
  cursor, NO ladder, no new durable state; the row is the restore-param. The parent flushes
  latest-wins (50ms debounce, single-flight, per-row `again` flag), re-pulling THROUGH the seed
  door (`get`, a full call expression like "itx.chat.state()") and delivering
  `{type:'snapshot', revision: maxAssigned, state}` by row identity. Seeds fire on subscribe
  and on the resurrection pass; a failed flush is healed by the next nudge/alarm. The patch arm
  ({from,to} LiveView-style deltas per subscriber) is reserved in the wire shape for a later
  diff engine — snapshots-first per the owner's too-much-code worry.
- **SDK, both flavors:** processors gain optional `liveState(state)` (projection; publishes on
  changed folds); mini-apps get `liveState(env.ITX, key, initial)` (~15 lines — set() makes
  mutation and notification inseparable; the author's accessor is the seed door). The SDK now
  rides EVERY confined isolate (part of the confinement contract, like itx.js) — found live
  when the chatroom's import failed on the stateful path.
- **`Itx.subscribe` accepts a LIVE CALLBACK target** — parked via the ordinary live-capability
  machinery, targeted as `itx.clients.get(sid)`; pathProxy grew `allowRootCall` for provider
  proxies (a parked bare callback IS the callable; the scope-symbol guard stands elsewhere).
  `deliverTo` generalized to a raw args array (event rows pass [events, window]; state rows
  pass [update]).
- Live proof (`prove_livestate.mjs`, ALL PASS): chatroom mini-app seed→mutate→latest-wins,
  monotonic offset revisions, the processor flavor via `itx.facets.get('chunky').snapshot()`,
  and the no-loop assertion. Full eight-suite regression board ALL PASS.

## Increment 49 (live-6): live state carries the DELTA — LiveView patches, client-chained

The owner rejected increment 48's nudge + re-pull design ("move on to the one where the
ephemeral events carry the delta patch (and offset of reduced state they are relative to) —
elixir liveview style"), then mid-build simplified it further: no server-side chain tracking at
all — "each ephemeral event says I am the diff relative to offset X; each client reads the
snapshot to get offset+state, then consumes patches going forward." A 31-agent adversarial
review of the intermediate (server-chained) build independently confirmed both of its real
protocol bugs — a late timed-out frame breaking the per-row order promise, and an un-raced seed
invoke wedging a row's chain behind a hung facet — and both lived exactly in the machinery the
owner's version deletes. The flush engine AND the forwarder's bookkeeping are gone.

- **The change event carries its own patch:** `live-state/changed` payload is
  `{key, from, to, patch}` — an RFC 6902 subset (add/replace/remove, JSON-Pointer paths) from
  the new `core/patch.ts` (~110 lines diff+apply, dependency-free, exported through the SDK).
  Diffs are computed AT THE PRODUCER; both sides are JSON-normalized first (the wire is JSON:
  undefined keys vanish, Dates become ISO strings, array holes become null — diffing what you
  didn't normalize is how a Date change goes silent). Arrays get the chat-log fast paths (pure
  append → `add …/-` ops, tail truncate → removes) and wholesale replace on middle divergence.
  applyPatch traverses own-properties only and refuses `__proto__` paths (patches arrive over
  the wire; the review proved the naive version was a prototype-pollution sink).
- **Producer-owned revision chains:** each emission's `from` is the previous emission's `to`.
  Processors chain on in-memory `#liveStateRev` (minted from the fold cursor at the first
  `liveSnapshot()`, advanced per emission — silent batches can't break the chain; emission at
  the end of `#processBatch`, persist-first-emit-second). The mini-app helper chains a local
  counter and diffs in `set()`. The two refuted review findings were both attacks on this
  chain — it held.
- **The stream is a PURE FORWARDER (~15 lines):** each committed change payload is pushed,
  fire-and-forget, at every row watching the key. NO per-row server state, no mount seed, no
  `get` in the subscription (`liveState: {key}` is the whole policy), no ordering guarantee —
  the CLIENT owns the chain: seed through the producer's door (`liveSnapshot()` /
  the helper-backed `state()`, both answering `{rev, state}` read atomically), apply a payload
  whose `from` matches the held rev, drop `to ≤ rev` duplicates, re-read the door on any
  mismatch. Every failure mode — reorder, drop, eviction anywhere, producer rebirth — is that
  ONE client-side case. `resumeSubscription` now refuses state rows (no cursor to move).
- Review fixes that survive the pivot: patch.ts hardening (JSON-normalize; `Object.hasOwn`
  instead of `in`, so keys named like Object.prototype members diff correctly; the `__proto__`
  refusal), the resumeSubscription guard, stale docstrings (Itx.subscribe's flush-era pair,
  the SDK helper's eviction claim, processor.ts's zero-imports header).
- Unit: `patch.test.ts` (roundtrip invariant, promised op shapes, JSON semantics, prototype
  safety) + a live-state describe block in `processor.test.ts` (one emission per changed
  window, chain-across-silent-batches, liveSnapshot minting, no-change no-emit, the loop guard
  even when NAMED in consumes) — 102 tests.
- Live proof (`prove_livestate.mjs`, ALL PASS on live-6): the ~20-line client loop seeds
  itself, applies two chat posts as two `add …/messages/-` patches with ZERO re-reads, ends
  byte-identical with the door; an injected duplicate frame is dropped by rev and an injected
  gapped frame triggers exactly one healing re-read; processor flavor chains 5→6→8 off the
  `liveSnapshot()` door; loop guard holds. Regression: push/ephemeral/crisp1/userfacet ALL
  PASS (ephemeral proof's pinned absolute offsets re-anchored to the shared-sequence
  invariant — change events now interleave).

## Increment 50 (live-7): the adversarial-review fix wave — 19 confirmed bugs closed

Two overnight review workflows (7-lens bug hunt, 82 agents; 4-angle re-derivation) confirmed 37
findings against increment 49. Every confirmed BUG is fixed here; the simplification wave is
increment 51. Highlights, by blast radius:

- **append is ATOMIC** (`transactionSync` around sql + the maxAssignedOffset kv write): a
  mid-batch idempotency conflict used to leave inserted rows above the recorded max — the next
  append then re-assigned a used offset (one offset, two identities) or wedged on the PK.
- **Idempotency dedupe hits and ephemeral capability events no longer fold into the push-row
  projection** — a deduped re-append of a provided event resurrected a REVOKED subscription;
  ephemeral provided/revoked events made the parent projection and the facet's mounts fold
  disagree forever (the facet fold now skips ephemerals too, and skips malformed payloads
  loudly instead of letting one hand-appended event wedge every later resolve).
- **Facet drives are serialized per facet** (in-memory promise chains): a slow loader
  materialization let a later batch overtake an earlier one, which was then judged a stale
  redelivery and its NAMED EPHEMERAL events silently dropped. Live-state change events never
  ride a drive at all now (nothing may consume them — the voice-flood RPC waste); the next
  real drive's window COVERS the skipped span per-facet, so fold contiguity holds (the naive
  skip broke it and the proof suite caught the dropped chunks immediately).
- **A pure-ephemeral append no longer buys a cursor kv write per event-subscription row** —
  push rows only pump when a durable event actually committed. With the drive-skip above, the
  50Hz voice flood now costs what the design always claimed: ONE kv write per append.
- **The push pump can no longer fight its operators**: a shadowed row's cursor freezes at the
  next loop iteration (not when the pump drains); every pump write compare-and-swaps on a
  cursor surgery generation (`rev`), so `resumeSubscription` mid-delivery wins and a revoked
  row's GC'd cursor is never resurrected; the 20s delivery watchdog is CLEARED on the happy
  path (every delivered batch used to pin the DO 20 extra billed seconds); `maxAttempts: 1`
  with `onFailingEvent: "skip"` pins to one event instead of silently degrading into a halt;
  concurrent anonymous subscribes mint unique names instead of shadowing each other.
- **The quiesce alarm respects work**: it never aborts while a drive/fold is in flight (the
  abort-mid-fold stall the resurrection pass exists to heal), and the resurrection pass is
  awaited WITHOUT counting as activity — it used to re-materialize every facet exactly when
  the stream went quiet and buy them a second 60s of billed idle (~120s tail → ~60s).
- **Live-state emission is contained**: a throwing/unserializable projection (BigInt state,
  toJSON → undefined) landed AFTER the persist and rejected the whole batch for
  snapshot()/waitUntilProcessed callers, then went silent forever — now it degrades to the
  documented lost-notification (+ unit test). The SDK helper's revision chain seeds from a
  per-incarnation EPOCH: a reborn holder restarting at 0 could hand a stale client a `from`
  matching its held rev and corrupt its doc silently — now every stale rev mismatches and
  re-reads the door (prove_livestate re-anchored to relative revs).
- Small but real: `read(after, 0)` no longer crashes (userspace-reachable); timed-out
  `waitUntilProcessed` waiters leave the list; subscription targets with named captures are
  rejected at provide time (they could never deliver); `#forwardLiveState` reads the row table
  once per batch; `disableProcessor` clears its drive bookkeeping.

104 unit tests; full eight-suite live board ALL PASS on live-7
(livestate/ephemeral/push/crisp1/userfacet/restore/facet1/edge).

## Increment 51 (live-8): the simplification wave — one spelling per idea, hot paths paid once

The re-derivation workflow's verdict (three designers + a cartographer, judged): the
architecture is already at its fixed point on most axes — the dead weight was RE-SPELLINGS.
This increment gives every duplicated idea exactly one home and deletes the grep-verified dead
surface. (Measured honestly: ~145 duplicate/dead source lines died but the new helpers carry
doc banners, so the SOURCE net is −6 lines — the shrink is in SPELLINGS, 6→1 policy, 3→1
walks, 2→1 facet dances, two dead classes — not in raw line count. The big line-count wins
are on the owner's menu.) Behavior pinned by the ten-suite live board.

- **`invokePath` (core/expression.ts)** — the one dotted-walk applier (stepGet + Reflect.apply,
  receiver carried). The parent's `facetInvoke` and the stateful runner's `invokeCapability`
  hand walks collapse onto it; the DataCloneError learning banner now lives ONCE, on the
  helper. (The Invoker's walk stays hand-rolled ON PURPOSE — its non-awaited property reads
  are capnweb promise pipelining over the retained provider.)
- **`versionedFacet` (core/agent-runtime.ts)** — the loader+version-marker dance (abort on
  source change, keep storage) existed twice, byte-similar; now once, beside the cacheKey
  dollar lever it belongs with.
- **`DeliveryPolicy` (core/events.ts)** — the subscription delivery policy was spelled SIX
  times (two subscribe inputs, provide's inline type, the zod schema, PushRow, the projection
  cast). One exported type; subscribe now destructure-passes it through whole; the
  add-a-field-miss-a-spelling drift class is unspellable. The duplicate target-root guard in
  SDO.subscribe died (ictx.provide is the one enforcement point).
- **Dead surface deleted** (grep-verified zero callers): `parseEvent`/`parseEventInput` off the
  contract helper, `ClientConnection` + `Client.getConnection`, `__leaseActive`/`#active`.
- **Hot paths pay once**: facet reads skip their parent catch-up RPC when provably at the
  pushed head (`#pushedHead` — one read deleted from EVERY capability dispatch and each alias
  hop, the system's hottest path); `#refoldIfNeeded` probes storage once per incarnation;
  `#armAlarmNoLaterThan` memoizes the armed target (the awaited getAlarm read per append is
  gone); the fold persist splits cursor from state blob (a non-consuming facet wrote its
  ENTIRE state per durable batch — now a tiny cursor record, state only when changed);
  `#maxAssigned` is kv-only (the SQL crosscheck was backcompat; transactionSync made kv+sql
  atomic); the events table drops AUTOINCREMENT (offsets are always explicit — the
  sqlite_sequence row write per durable append bought nothing).
- **Repo files now WIN over the demo HELLO_FILES** on a path clash (a project writing
  /chatroom.js to its own repo could never read it back); the kv/repo views share one
  `prefixedKv`; `/state` stops inventing cursor fields for live-state rows.

104 unit tests; ten-suite live board ALL PASS on live-8 (facetaddr's expected error text
updated — the unified walk says "is not a method"; the refusal semantics are unchanged).

## Increment 52 (live-9): live-state forwards get latest-wins backpressure

The resumed verify wave's one NEW confirmed finding: `#forwardLiveState` fired one
fire-and-forget delivery per change per row with no in-flight cap, no timeout, no coalescing —
a 50Hz producer with a 5s subscriber grows ~unbounded pending RPCs and pins the DO's billed
duration until something dies. Now: ONE delivery in flight per row + ONE pending payload per
row (latest wins) + the 20s cleared watchdog. Dropping intermediate frames is the DESIGNED
path — the client sees a chain mismatch and re-reads the door, getting the freshest state in
one hop instead of replaying a stale-delta backlog. Also: the same wave re-verified five of
increment 50's fixes as fixed (unique anonymous names, the named-capture guard, repo-wins,
the skip-pin ladder, the cleared watchdog). Ten-suite board ALL PASS on live-9.

## Increment 53 (live-10): the delivery short-circuit — spike-proven, kept

The two mutually-trading menu items got their spike (numbers + shapes in
apps/os/docs/simplification/wayfinder/innermost-core/subscriptions-facet-spike.md). Menu #2
landed: push rows carry their mount `target` into the projection, and the canonical
parked-callback shape (`itx.clients.get('<key>')` exactly) delivers via the parent's OWN
stubInvoke — zero facet hops, zero table routing; every other target keeps the facet lane.
Measured on the live deployment: push delivery 53→30 ms median (−43%), live-state set→frame
83→~50 ms (−~35%); the ten-suite board stays green. This is an alignment, not a break —
delivery was always "by row identity, never the table"; the dominant shape now pays like it.
Menu #1 (subscriptions into the ictx facet, −160 lines) is VIABLE — the cursor-read RPC
concern measured out at ~2 ms noise — but recommended DEFERRED until workerd#6810 (facet
alarms, still open) deletes the one ugly bit, the parent alarm-proxy verb.

## Increment 54 (live-11): THE INLINE CORE — the routing table folds at the commit point, and the core processor is back

The owner's direction ("move parts of iterate-context into the stream parent… bring back the
core stream processor from apps/os as a reduce-only processor and the ability to circuit break
a stream"), grounded in the apps/os precedent: its stream DO "runs [the core processor] inline
during append instead of through the normal event-batch runner", and that same reducer owns
the pause flag and the token-bucket breaker. Design memo: wayfinder/innermost-core/
core-processor-jam.md. The insight that makes it elegant: THE RUNNER IS THE PRICE OF DISTANCE
— serial chain, cursors, scan windows, gap repair, resurrection all exist to cope with being
away from the commit point; a fold that runs AT it needs none of them.

- **`ReduceOnlyProcessor` (core/processor.ts)**: same `defineProcessorContract`, same
  `reduce({event, state})` — NOT having a `processEvent` is what qualifies a processor for
  inline hosting (the rule is the type). Three placements, one authoring surface: inline
  (zero distance), built-in facet (ProcessorFacet — kept, now purely generic), userspace
  (loader runner — untouched).
- **The inline host (~90 lines in the parent)**: per-slug in-memory state + a versioned kv
  checkpoint written INSIDE append's transactionSync — the routing table and core state are
  atomically exact as of the last committed event, so the pump-races-the-provide class is
  unspellable, not carefully avoided. Rebuild (eviction, version skew, first contact) is one
  synchronous replay of the durable log. Inline folds see durable events only.
- **The iterate context moved in**: `IterateContextStreamProcessor` dropped its async base
  class (reduce-only + resolver methods; mounts now CARRY their delivery policy, so the
  parent's push rows are a derived view of the one fold — the double fold is DEAD, and so are
  `#ictx()`, the ictx facet, its resurrection/quiesce cases, the deliverSubscription facet
  lane, and the `x-itx-cap` facet-fetch tunnel; dispatch/provide/revoke/subscribe/deliver/
  fetch-lane are all parent-local now). ProcessorFacet shrank 260→153 lines (generic shell +
  Tally, which stays as the built-in-facet lane's proof). Push cursors mint lazily on first
  pump; revoke GCs them in the verb.
- **The core processor (core-processor.ts, ~113 lines)**: pause + token-bucket circuit
  breaker, exactly the apps/os shape. Control is ORDINARY EVENTS (pause/resume/
  breaker-configured are appends — auditable, shadowable, zero new verbs); enforcement reads
  the fold at the commit point; the bucket refills from EVENT time so the fold stays pure and
  rebuilds bit-identically (only enforcement consults the clock). Control events are exempt —
  a tripped or paused stream always accepts its own resume. Ephemeral appends bypass the
  breaker (it meters durable growth).
- Measured on live-11: table-routed `stream.read` from a loaded isolate 9.8→5.7 ms (the facet
  resolve + snapshot barrier per dispatch is gone); delivery medians hold at increment 53's
  levels. Unit: core-processor.test.ts (pause latch, exact-capacity trip, event-time refill,
  control exemption, bit-identical refold) — 109 tests. Live: NEW prove_core.mjs ALL PASS
  (pause refuses with reason, control passes, breaker admits exactly 3 then trips, ~2.6s
  refill admits exactly one more, breaker-off restores, /state shows the core fold) + the
  full ten-suite board ALL PASS.

## Increment 55 (live-12): the language wave — one vocabulary, strings at rest, everything is a mount

The first of the three plan-of-record waves (PLAN.md). Fully qualified, breadcrumb-leaving
identifiers throughout (the owner's naming doctrine, now enforced in code):

- **The capability table**: `capability-table-processor.ts` / `CapabilityTableProcessor` /
  `CapabilityTable` / `CapabilityMount` — the words iterate-context, ictx, capability-host,
  host-scope, roots, and seed are GONE from the codebase. `built-ins.ts` (`buildBuiltIns`,
  `BuiltInsEnv`) holds the expression roots; config mounts come from APP_CONFIG
  (`configMounts`, `DEFAULT_CONFIG_MOUNTS`). Transport: `CapnwebCallbackRelay`,
  `RetainedCallbackInvoker`, `delivery-websocket.ts`, `ItxConnectionRegistry`,
  `ItxEntrypoint`. `ScannedOffsetRange` (never "window"), `ReduceProgress`,
  `#highestAssignedOffset`, `#pushedThroughOffset`. "Fold" is retired for reduce/reduced
  (`#rereduceIfVersionChanged`).
- **STRING AT REST**: mount events store `{ path: "itx.chat", target:
"itx.clients.get('abc')" }` — the log reads like what a human wrote; reduce parses ONCE into
  the structured in-memory table; `print` earns its keep canonicalizing programmatic
  expressions at mount time. Contract v2.0.0 (clean break; tables rebuild from the log).
- **THE GRAMMAR DIET** (merged in from wave 3 — same files): all five placeholder forms,
  `substitute`, the must-use rule, and the `$`-escape are DELETED (grep-verified zero users
  outside their own tests; the substitute region had shipped two codec bugs). Patterns are now
  CAPABILITY PATHS — plain dotted segments (`parseCapabilityPath`); matching is
  longest-path-prefix, final segment may consume boundary args, ties → newest; argument-shaping
  belongs in a code capability (the file's own doctrine, now enforced by absence). Kebab-case
  slugs are legal path segments (the identifier grammar gained non-leading hyphens);
  anonymous subscriptions are named `sub-<uuid8>`.
- **EVERYTHING IS A MOUNT**: processor enablement became a mount at `itx.processors.<slug>`
  with a processor policy `{ source?, export?, props? }` riding the event — the
  facet-processors kv registry is dead, enablement is event-sourced/auditable/shadowable, and
  `itx.processors.<slug>.snapshot()` resolves as ordinary addressing. **Per-instance `props`**
  land in `FacetIdentity` and the `StreamProcessor` constructor (event-sourced instance
  config; re-enable with new props = shadow). subscribe/unsubscribe left the DO for the edge
  (pure sugar over provide/revoke-by-path); `revokeCapability` gained revoke-by-path; the
  edge's park+mount two-step is ONE helper (`#parkAsTarget`).
- Also: the processor SDK (~330KB) is injected only where a processor class can exist
  (procfacet/stateful kinds — stateless code caps stop carrying it); the dead
  facetClientsView/facetAddressView exports died; event namespace moved to
  `events.iterate.com/capability-table/*`.

89 unit tests (the deleted placeholder machinery took its ~20 tests with it); eleven-suite
live board ALL PASS on live-12 (proofs updated: provide speaks `path`, enablement mounts
consume offsets and are counted by "\*" reducers — the audit trail the kv registry never had).

## Increment 57 — topology: the stateful runner dies, source is plain kv (live-14)

- **StatefulWorkerDurableObject DELETED** (migration v8): stateful loaded classes are now
  FACETS of their stream — same confinedWorker + versionedFacet as userspace processors, facet
  identity keyed on the source EXPRESSION, restart-on-content-change via the version marker.
  The `{projectId}::{path}::{className}:{hash}` name codec and the x-itx-source/x-itx-class
  header protocol die with it; a 101 flows DO→facet natively. Idle stateful facets are aborted
  by the same quiesce alarm (in-memory name set); a BUSY one pins its stream — the accepted
  trade. One DO namespace remains.
- **files/repo roots + hello-files DELETED**: source is plain kv (`itx.kv.get('src/x.js')`).
  `asModules` (core/agent-runtime.ts) normalizes a source expression's result — a modules
  record passes through, ONE string becomes `{"cap.js": source}`, anything else errors loudly.
  A future real repo mounts at itx.files as an ordinary capability.
- Proofs seed their own sources (scratchpad proof_sources.mjs + seedSources); board 11/11 ALL
  PASS on live-14. One re-run needed: the known DO-class-lags-worker deploy race made five
  suites hit old-class DOs on the first pass.
- Grammar diet (placeholders/substitute/$-escape) had already landed in increment 55.

## Review pass (running) — vocabulary burn-down + two commissioned proof suites

- **Banned-word sweep, code AND comments**: `window` → `scannedOffsetRange` everywhere
  (including the SDK duck contract's parameter and `FacetProcessorHandle`), `#foldInline` →
  `#reduceInlineAtCommit`, `#driveWindows` → `#driveDeliveredThrough`, fold/folded/folds →
  reduce forms, "frames" → payloads/batches, "scan-window proof" → "scanned-offset-range
  proof". Zero remaining hits for fold/frames/window/roster in src.
- **prove_slack.mjs** (NEW, board suite 12): the Slack SDK bridge use case — a node script
  connects over capnweb and provides an RpcTarget replaying dotted calls onto a
  WebClient-shaped SDK instance; `itx.slack.chat.postMessage(...)` round-trips from a second
  client, the expression door works, an alias mount (`itx.notify` ⇒
  `itx.slack.chat.postMessage`) rides the same bridge, and provision.revoke() restores
  default-deny.
- **prove_ephemeralflood.mjs** (NEW, board suite 13): ephemeral 256B chunks, PIPELINED batched
  appends (awaiting each batch serializes the producer on its own RTT — the owner caught the
  first draft measuring exactly that), one CONNECTED subscriber. **2000/2000 delivered,
  15,038 ev/s end-to-end, p50 106ms / p95 128ms under the burst (35ms/45ms at trickle rates),
  40 callback invocations for 2000 events (50× batching), delivered ScannedOffsetRanges
  chained with zero heal-pulls, every seq exactly once.** The ultra-low-latency invariant,
  measured — and no acks anywhere on the delivery path.
- Board is now THIRTEEN suites, all green against the swept deploy.

## Review pass (continued) — tightness: StreamEventLog + dead-export cull + wording

- **StreamEventLog extracted** (the apps/os name, adapted): the commit point is its own
  composed class beside StreamAlarmArmer — touch/incarnation, the offset high-water mark, the
  idempotency check, the atomic transactionSync append (with `reduceAtCommit` running INSIDE
  the transaction), and `read` with the scanned-offset-range proof. The DO's `append` is now
  enforcement → `#eventLog.append(inputs, reduceAtCommit)` → drives + connected delivery; its
  `read` is one delegating line. Top of the class reads: #address, #hibernatableRpcStubs,
  #pendingConnectionRecords, #alarmArmer, #eventLog.
- **Dead-export cull**: 20 in-file-only symbols un-exported (AppConfig, BuildBuiltInsDeps,
  the view types, CapabilityMount, CapabilityTableContract, the itx-surface RpcTarget classes,
  CoreContract, DurableObjectAddress, ErrorCode, MAX_VALUE_DEPTH, Step, StubPageMessage,
  ITX_SURFACE_MODULE, …). Public surface = what other files actually import.
- **Wording**: the last "delivery WebSocket" phrasings became "stub pager WebSocket"/"paged-in
  stub" (the socket only pages — saying otherwise was increment-56-draft residue), and the
  regex-sweep artifacts in append's drive comments were hand-fixed.
- Board 13/13 against the deployed refactor.

## Review pass (closing) — ItxConnectionDirectory + the composition verdicts

- **ItxConnectionDirectory extracted** (src/itx-connection-directory.ts): the domain layer over
  the hibernatable RPC stubs — identity-from-the-log, THE SESSION RULE, the connection facts,
  the pending-attach gate (partial fetch), and the views (invoke/fanOut/currentlyConnected/
  close). Deps fully injected ({hooks, kv, append, onFinalClose}); auto-revoke stays in the DO
  (it needs the capability table) as the onFinalClose hook. The DO's webSocketClose is one
  line; its lifecycle section is three delegating RPC verbs. stream-durable-object.ts:
  1358 → 1161 lines, and its top now reads #address / #itxConnections / #alarmArmer /
  #eventLog.
- **Composition verdicts** (the no-junk test, ruled): FacetProcessorHost — REJECTED for now
  (the facet spine's seam is genuinely wide: env + ctx.facets + ctx.exports + invoke +
  identity + activity + quiesce interplay ⇒ seven injected closures to move ~200 lines; a
  helper that wide is the abstraction fighting the class, not helping it). InlineReducerHost —
  REJECTED (~60 lines living beside their only caller; extraction would add surface, not
  remove it). The composed set stays: name codec, connection directory, alarm armer, event
  log, plus the stub manager under the directory.
- Board spot-proven against the deployed refactor (crisp1, slack, push, livestate).

## Errors, logs, validation — the cloudflare-os adoption (live-15)

Owner directive: their build chain + their error/log patterns, lightweight, ~200 lines.

- **THE BUILD MECHANISM (cloudflare-os wiring, verbatim)**: wrangler's custom-build hook runs
  the capnweb-validate CLI, which mirrors src/ into .wrangler/validate with every
  `@validateRpc()` class rewritten to carry validators GENERATED FROM THE TYPESCRIPT
  SIGNATURES; wrangler bundles the mirror (`main` points there). The Vite plugin rides
  vitest.config.ts so tests exercise transformed code. ~6 lines of config + 2 lines per class.
- **BOUNDARY VALIDATION, live-proven**: ProjectSession/Itx/CapabilityProvision (the capnweb
  boundary), StreamDurableObject (the Workers-RPC verbs incl. append's StreamEventInput[]),
  and ItxEntrypoint are decorated. Malformed input now dies at the door with a precise path
  ("Itx.invokeCapability[0].path: expected array, got string"). The dynamic-capability question
  answered itself: the envelope is static, so validating ~6 doors validates the unbounded
  system. WIRE TRUTH LEARNED THE HARD WAY: capnweb/Workers-RPC stubs arrive as CALLABLE
  PROXIES (typeof "function") — structural validators reject them, so stub-typed params
  (connect's capabilities, provideCapability's capability, activateItxConnection's invoker) are
  validated permissively BY DESIGN and typed at the use-site seam.
- **core/errors.ts extended (~80 lines)**: four new codes, each earned by an actual branching
  caller (CONNECTION_OFFLINE, NOT_A_METHOD, NO_FACET, EPHEMERAL_IDEMPOTENCY_KEY), plus
  reportIssue(failureSite, caught, attributes) — the cloudflare-os shape with its exact bounds
  (1024/16384/256/32), minus the Reporter binding (a documented one-line seam) and minus
  ambient cloudflare:workers (this file rides the platform-neutral SDK bundle).
- **core/logs.ts NEW (57 lines)**: createLogger(namespace) — one structured console line per
  call, `event:` dot.names, error→string+errorStack normalization, .with() children; ALS
  context and level-gating deliberately dropped (no nodejs_compat; filtering belongs in the
  Workers Logs query).
- **15 console sites migrated**: unexpected-failure catches → reportIssue; survivable-by-design
  drops (live-state/event-batch deliveries) → logger.warn with heal-path comments; the two
  unannotated swallows annotated.
- **retryable: false honored** (the stamped-flag doctrine, now enforced): the forwarder halts
  IMMEDIATELY on a never-retryable delivery error instead of burning the 30-minute ladder —
  prove_push's poison now stamps it and proves the fast halt.
- Board 13/13 on the validated deploy. Total: errors 80 + logs 57 + config ~16 + migrations
  ≈ 210 lines, net of deletions ~140.

## The bug hunt — seven agents, three test lanes, 41 documented failures (nothing fixed yet)

Owner commission: as many FAILING tests as possible; mark, don't fix. Every `test.fails` was
verified genuinely failing before marking; all three lanes run GREEN under fails-semantics.

- **Lanes**: unit (vitest + capnweb-validate plugin) 119 pass / 11 expected-fail / 3 todo;
  HARNESS (wrangler createTestHarness booting the real worker — **tests**/harness.ts) 51 pass /
  30 expected-fail / 12 todo; POOL-WORKERS (@cloudflare/vitest-pool-workers, tests inside
  workerd, cloudflare:test evictDurableObject) 4 pass. New files: **tests**/failing-_.test.ts,
  src/\*\*/_.failing.test.ts, **workers-tests**/, vitest.workers.config.ts, wrangler.test.jsonc.
- **HEADLINE PASS — hibernation at scale, in workerd**: 200 clients attach (stubs=200,
  dormant), REAL eviction survives (sockets + attachments intact), 200/200 wake answers in
  41ms cold via page→stub→invoke; a warm DO refuses eviction while stubs pin it (#6800,
  faithfully). Also passing with pinned wire frames: pipelining of itx expressions on stubs
  (one round trip, exact push/pull/resolve census), the ONE-DIRECTIONAL delivery invariant
  (zero client-initiated frames under a 100-chunk flood, deliveries continue with outbound
  artificially stalled), deep chaining (1 push), dup()/onRpcBroken per the docs.
- **The 41 expected-fails, by family**: print↔parse asymmetry = SILENT AUTHORITY LOSS
  (provide "succeeds", mount never exists: exponent numbers, -0, non-identifier object keys) +
  **proto** object-key prototype pollution; commit-point mismatches (in-batch dedupe hit
  REDUCED TWICE — breaks bit-identical rebuild; breaker taxes idempotent retries; payload-less
  pause/breaker events silently no-op; read() past head fabricates scan proof); delivery lanes
  (consumes ["*"] = silent black hole in BOTH lanes; ghost HALT audit fact on unsubscribe-
  during-flight + orphaned progress; resume beyond head wedges the row); connections (dirty
  deaths filed as CLEAN ends — the session-rule storm clause is UNREACHABLE, code 1000 on both
  relay close paths; concurrent same-key connects never collapse; in-flight invoke on a killed
  provider leaks an uncoded transport error); processor rules (version-bump refold can replay
  the whole log WITH side effects if waitUntilProcessed touches first; refold swallows
  in-flight pushes; nested blockProcessorWhile escapes the cursor hold; at-head stall on exact
  500-multiples; named ephemerals dropped on non-contiguous pushes); capnweb disposal
  (CapabilityProvision lacks Symbol.dispose — `using` leaks mount+connection+relay); the
  NATURAL DOTTED SURFACE entirely missing (9 tests adapted from apps/os path-proxy, file:line
  provenance; three miss vocabularies vs their one isPathMissMessage grammar); ROW CHUNKING
  absent (6 tests pinning the apps/os contract: EVENT_CHUNK_SIZE 512KiB, event_chunks table,
  offset-per-event, reassembly byte-identity; today 3MiB+ dies SQLITE_TOOBIG before even the
  idempotency check).
- **Toolchain discoveries**: vite 8 oxc does not lower the standard decorators capnweb-validate
  emits — **workers-tests** lowers via an esbuild plugin pass (cloudflare-os never hits this;
  their pipeline lowers in esbuild); the harness lane cannot boot the Worker Loader
  (allow_irrevocable_stub_storage needs a workerd --experimental knob TestHarnessOptions lacks)
  but POOL workerd accepts the flag.

## Fix campaign Phase 0 — the no-brainers (10 defects, all guards/additions, zero regression)

Every fix rejects previously-broken input or adds a missing method; no behavior that passed
before changes. Fixed test.fails flipped to plain regression tests.

- ☠ 38 cross-project charset breach: DurableObjectNameCodec.parse gates projectId to
  [A-Za-z0-9_-] (a ":" collapsed the kv/secret wall). Closes U1's cacheKey seam at the root too.
- ☠ 39 secret-name charset: secrets.set validates against the egress token grammar.
- ☠ 34 forgeable revoke key: the public stream.append door fences platform-reserved
  `capability-table/` idempotencyKeys (the apps/os internal-key fence).
- ☠ 5+40 provide round-trip: provide() re-parses its own stored path+target strings and throws
  loudly instead of returning a providedAtOffset for a mount reduce will silently drop.
- ☠ 4 **proto** prototype pollution: #object stores keys via Object.defineProperty (own data
  property, never the setter).
- ⚠ 8 payload-less pause/breaker: CoreStreamProcessor.reduce defaults `event.payload ?? {}`.
- ⚠ 44 payload-less live-state delivery: #deliverToConnectedSubscriptions guards with ?.key.
- ⚠ 23 capnweb disposal: CapabilityProvision implements Symbol.dispose → revoke (the `using`
  contract; was leaking mount+connection+relay).
- ⚠ 41 config array-path validation: parseAppConfig round-trips both path forms through the
  grammar (an array/[] path no longer boots a dead/rank-0 mount).
  Harness lane serialized (fileParallelism:false) — parallel boots raced the build hook on
  .wrangler/validate. Unit 128p/16xf/6todo, harness 76p/39xf/18todo, both green.

## 2026-08-20 — dotted surface landed, then capnweb-validate REMOVED

- Natural dotted client surface (defect 24): prototype HOP on `Itx` (`src/core/dotted-path-proxy.ts`,
  ported from apps/os) — `itx.slack.chat.postMessage(...)` etc. as plain property access. Live-proven
  on project-worker.iterate.workers.dev (prove_slack.mjs writes the dotted spelling now, ALL PASS).
- capnweb-validate RIPPED OUT (Jonas: "we dont need it for now"). It is a method ALLOW-LIST
  (`wrapServerTarget`) — fundamentally incompatible with an OPEN dotted surface, and apps/os uses
  none. Removed: the 5 `@validateRpc()` decorators + imports; the `capnwebValidate()` +
  `lowerStandardDecoratorsWithEsbuild()` vite plugins (no more standard-decorator lowering — the
  esbuild pre-pass existed ONLY for validate's rewritten decorators); the `.wrangler/validate` build
  mirror; `main` → `src/worker.ts`; build hook → `node build-sdk.mjs`; the package dependency.
  `worker.ts` already served `/api` with plain capnweb `newWorkersRpcResponse`, so the runtime
  entrypoint never changed — validation lived only in `@validateRpc()`'s in-place method wrapping.
- Cost (accepted): no boundary arg-validation. The append door keeps its one runtime typeless guard
  (now the sole input check); coarse TS-type policing (ephemeral:false loud-error, forged `source`,
  excess keys) lapses. Restoring any of it = a runtime `StreamEventInput.parse()` at the append door.
- Lanes green: unit exit 0; full run 278 passed / 37 xfail / 2 skip / 31 todo; typecheck clean.

## 2026-08-31 — the .mjs live board becomes the vitest E2E lane; full-package audit

- The proofs/_.mjs board is RETIRED (deleted, git history keeps it): all 27 portable proofs now run
  as `pnpm e2e` (e2e/\*\*/_.e2e.test.ts) — apps/os shape: ONE shared worker booted once by
  e2e/support/global-setup.ts (createTestHarness + the SOLO FALLBACK rebind, shared with
  **tests**/harness.ts via e2e/support/solo-config.ts), files in parallel, fresh ctx per test,
  13s for the whole board (vs minutes of sequential .mjs runs against a deploy). Lanes now:
  `pnpm test` (unit/harness/workers) · `pnpm e2e` (vitest E2E) · `pnpm spec` (Playwright, specs/\*\*).
- Proof deltas while porting: exact-offset pins loosened (live-state default-on shares the offset
  space); the three fixed lifecycle bugs (resume-race, disable-shadow, resub-zombie) flipped from
  RED to green regression pins; prove_connect/multihop re-pointed at a Node-hosted dummy capnweb
  API inside globalSetup — the property-hop pipelining is GREEN, and a NEW test.fails pins the
  still-broken call-then-call chain (`.svc('x').add(…)` — the advertised `itx.os.projects.get(id).…`
  shape dies with "Batch RPC request ended").
- Full-model audit of the recent work (13 adversarial reviewers) found and FIXED: LiveState.set's
  diff-failure branch adopted the base without bumping rev (silent client corruption; now bumps +
  root-replace fallback so a poisoned base can't wedge the chain — live-state.test.ts pins it);
  version refolds now publish one heal delta (clients re-seed instead of staying silently stale);
  useLiveState never unsubscribed (leaked a durable mount per unmount — connectLiveState now
  returns {store, dispose}); client store got seed monotonicity + single-flight gap heals with
  surfaced errors; four leftover ALL_CAPS event-type constants inlined.
- Package held to the repo gates for the first time: oxlint --deny-warnings 0/0 (was 97 errors
  pre-session), typecheck now covers e2e/specs/**tests**/**workers-tests** (tsconfig.tests.json).
- `@cloudflare/vitest-pool-workers` → `@cloudflare/vitest-plugin@^1.0.0` (the 2026-08-19 rename;
  same API), workers-types bumped to its peer floor.

## 2026-09-01 — C7: the mount is data, the stub is physical

- REVERSES the event-layer half of C4 (`75c07e06b`), keeps its door. A live provide is no longer a special
  `live: true` row: `itx.rpcStubs` is BACK as a BUILT-IN (the physical registry — edge `provide(fn, {key})` /
  `get(key)` / `list()` / `close(key)`; DO root `get`/`list`) and `itx.provide(path, fn)` is SUGAR: park under
  the canonical path, then append the ORDINARY mount `path ⇒ itx.rpcStubs.get('<path>')`. `target` is required
  on every mount, `live` is gone from event/row/input; capability-table contract 3.0.0 → 4.0.0.
- One shadow-stack reduce for every mount (no per-path singleton, no supersession); the DO's provide door is
  IDEMPOTENT (same winner target+delivery+processor ⇒ its offset, nothing appended), so a reconnect's
  re-provide appends ZERO events — only the transport is replaced.
- NO auto-revoke, NO presence self-heal: a dead stub leaves only its absence — its mount STAYS, answering
  CONNECTION_OFFLINE until revoked or re-parked; `revokeCapability` returns void and never touches transports
  (edge `itx.revoke(path)` also closes this session's stub). PRESENCE is `itx.rpcStubs.list()`, never the table.
- `RpcStubDirectory`: `onFinalClose`/`drop()` deleted, `attachedPaths()` → `list()`; `laneOf`: `itx.rpcStubs.get('k')…` ⇒ connected.

## 2026-09-01 — the onion, step 0: latest Workers + the ctx.props facet probe

- The onion design (docs/design-onion-subscriptions-processors.md — six candidate designs compared, one
  chosen) leans on ONE platform fact: a facet started from a Worker-Loader class minted with
  `getDurableObjectClass(name, { props })` sees those props as `ctx.props`. PROVEN in
  `__workers-tests__/facet-props.test.ts`, with two more facts pinned: a facet's `ctx.id.name` is its
  PARENT's codec name; `ctx.exports` is populated inside a facet.
- workers-types 4.x → 5.20260901.1 (project-worker, shared, control-plane-shell), vitest-plugin → 1.1.2,
  compatibility_date → 2026-09-01 everywhere (the repo's 24h minimumReleaseAge kept wrangler at 4.127.1).
- Learned: `Rpc.Serializable` rejects `unknown`, so a stub method returning a StreamEvent types as
  `never` (compiles only because never is assignable to anything); a recursive JSON payload type hits
  TS2589 inside Rpc.Serializable, so the one destructuring caller (the shell's /emit) casts, with the reason.

## 2026-09-01 — the onion, step 1: sessions, cd, fetch, props; connectToCapnweb is userspace

- THE SESSION SHAPE is apps/os's: `/api` serves `UnauthenticatedSession` → `authenticate()` → `Session`
  → `projects: ProjectCollection` → `get(projectId)` → the project's ROOT `IterateContext`. `?ctx=` is
  gone from `/api`; `ProjectSession.get(path)` is gone — another context is `itx.cd(path)` (absolute by
  convention, relative + `..` resolve; ONE resolver, `resolveContextPath`, shared with the built-in root).
  A session may hold contexts of many projects; the Parking is keyed by canonical context name.
  `Session.projects` is a GETTER — capnweb, like Workers RPC, refuses instance properties over the wire.
- `itx.fetch(request)` is the egress door on the edge AND a built-in root (the tutorial's chapter 2 as
  written). `fetchCap` is gone: ONE routing rule in `invokeCapability` — a terminal `fetch(request)`
  carrying a live Request rides the DO's fetch channel with the capability in `x-itx-cap` — so
  `itx.todos.web.fetch(request)` just works, 101s included. `/cap` takes `?context=` (a project id names
  the root, a full context name any context) and INSISTS on `?cap=`: the accidental "egress through /cap
  without a cap" back door is closed; the egress tests now drive `itx.fetch` (the honest door).
- `load(src).getEntrypoint(name?, { props? })`: Cloudflare's own `WorkerStubEntrypointOptions.props`,
  read back as `this.ctx.props`; the entrypoint handle now reaches ANY exported method by name (`run`,
  `processEventBatch`, …), not a `run|fetch` allow-list.
- `itx.connectToCapnweb(url)` DELETED — the one built-in that mapped onto nothing Cloudflare ships. It is
  userspace: a loaded `WorkerEntrypoint` imports capnweb's client from `./processor.js` (the SDK now
  re-exports `newHttpBatchRpcSession`/`newWebSocketRpcSession`), reads the url from `ctx.props`, and dials
  through the context's egress (`e2e/connect.e2e.test.ts` is that worker). With it went the capnweb
  `RpcPromise` brand in `core/dispatch.ts` — the walk pipelines native workerd promises only.
- Every lane re-spelled (`session().authenticate().projects.get(ctx)`, `/cap?context=`, dotted `.fetch`);
  `bareItx` is gone (there is no bare door). Gates: tsc ×3 · vitest 332+1xf · e2e 36+2xf · tutorial-proof
  8/8 · oxlint 0 · oxfmt · knip 0.

## 2026-09-01 — the onion, step 2+3: subscriptions are their own layer; a processor is a DurableObject

- A MOUNT is `{ path, target }` and nothing else (capability-table 5.0.0): `delivery`, `processor`, `lane`
  are gone from the event, the row, the door. `itx.subscribers.*` is no longer a convention.
- SUBSCRIPTIONS are their own layer: a third inline reduce-only processor (`subscriptions.ts`, slug
  `subscriptions`) folding apps/os's events — `subscription-configured { name, target, consumes? }` (same
  name REPLACES), `-removed`, `-delivery-halted` (appended by the delivery loop), `-delivery-resumed`
  (appended by an operator: un-halt, optional seek). Halt/resume are events like pause/resume; the
  `resumeSubscription` verb is gone. Read door: `itx.subscriptions.list()/get(name)` (rows ⋈ cursors).
- ONE delivery loop (`subscription-delivery.ts`), one rule, no lanes: evaluate the target through the ONE
  dispatch door and ask the value what it is. A `FacetHandle` or an `RpcStubHandle` (two brands the
  built-ins mint on `InvokeHandle`) OWNS ITS PROGRESS ⇒ fire-and-forget push of `(events, {after,
through})`, serialized per subscription, zero server state. Anything else (a loaded entrypoint's
  `processEventBatch`, a sibling context) ⇒ THE STREAM KEEPS A CURSOR — in memory, written to kv only
  when a delivered batch carried a DURABLE (an ephemeral-only batch touches no storage) — at-least-once,
  the awaited call is the ack, one ladder (1s·2ⁿ ≤30 min, 15 attempts, `retryable:false` halts now),
  retries on the DO's own alarm. The subscription-forwarder facet, its alarm proxy, the three parent
  doors, auto-enable, `maxAttempts`/`start`, live-state MODE (now `consumes: [live-state/changed]` +
  client key filter), the resurrection pass and `revokeCapability.all` are DELETED.
- A PROCESSOR is a `DurableObject` the author writes: `StreamProcessorDurableObject` (the SDK, bundled
  into `processor.js`) — `reduce` / `processEvent` / `projectLiveState` around the UNCHANGED
  `StreamProcessor` engine (wrap, not split: zero engine churn, Node-tested as before). Hosted like any
  class through `itx.load(src).getDurableObjectClass('Presence').get('presence')`; identity is
  `ctx.props { contextName, name }` minted by the parent (the step-0 probe) — `configure()`,
  `FacetIdentity`, `runner.js`, `ProcessorFacet`, the `proc:`/`named:`/`stateful:` facet-name prefixes
  are gone; a facet's name IS the subscription name IS the `.get(name)` name (an unnamed `.get()` is
  named by its class). `enableProcessor(name, { source, className })` ⇒ `subscribe({ name, target:
<load chain>.processEventBatch })`; `disableProcessor` ⇒ `unsubscribe` + `itx.facets.delete(name)`.
  NO built-in processors remain — `tally` is a test fixture like `presence`.
- PRESENCE gains its events: `rpc-stub/attached` / `rpc-stub/detached`, EPHEMERAL, appended by the
  registry when a key gains its first / loses its last transport (a replaced transport is neither).
  `itx.rpcStubs.list()` stays the truth; the log never claims a socket is open.
- The consumes rule (`consumesEvent`) no longer refuses the live-state delta type — a SUBSCRIPTION may
  name it; the ENGINE's `foldsEvent` keeps the "no reduce may fold a delta" guarantee.
- Two bugs the re-spelled tests caught in the new loop, fixed before landing: the skipped-batch watermark
  advanced before the `continue` (a filtered-out commit fell out of the next range); a subscription's
  first cursor was never seeded in memory, so the generation compare failed and the first batch
  re-delivered in a tight loop.
- Five more defects the harness-lane re-spell found in the new loop, all fixed before landing: the push
  AWAITED a live client's answer (a stalled tab blocked its own chain and pinned the quiesce — now
  fire-and-forget for stubs, awaited only for facets, whose order matters); a fresh cursor row's first
  push after a filtered commit read the log instead and dropped the pushed ephemerals (the log read now
  stops at the pushed batch's start, so the row becomes contiguous with it and takes it); a push racing
  `disableProcessor` re-materialized the deleted facet (the row is checked on both sides of the
  evaluation); a resume seeking past the head parked the row forever (clamped to the head — defect 13
  re-pinned); `enableProcessor("core", …)` was accepted (the inline reduces' names are reserved at the
  subscriptions door). Plus: a new subscription's target is evaluated once at configure time, so a
  processor with a `consumes` filter materializes at enable and `itx.facets.get(name)` answers before
  its first consumed event; a `delivery-resumed` fact pumps its row on commit, whatever the row's
  `consumes` says.
- MEASURED (local workerd): connected-lane flood `flood(ephemeral): 2000/2000 | append 68966 ev/s |
end-to-end 15267 ev/s | p50 36ms p95 42ms | batching 50×` (was ~5,400 ev/s, p50 ~215ms); the harness
  guard `[perf-guard] 1000/1000 | end-to-end 14493 ev/s | p50 20ms p95 23ms | batching 50×`. The push
  path writes nothing; the cursor lane writes kv only at durable boundaries.
- GATES: tsc ×3 · vitest 345 pass + 1 xfail (44 files: unit 184, harness 127 + 5 xfail → the five re-pinned
  as passing, workers 30) · e2e 34 pass + 2 xfail (26 files; resume-race×2 / disable-shadow / resub-zombie
  folded and deleted) · tutorial-proof 8/8 · oxlint 0 · oxfmt clean · knip 0.

## 2026-09-02 — the onion, step 2b: ephemerals cost zero writes

- An ephemeral-only append no longer touches storage AT ALL: no row (as before), no transaction, and no
  high-water mark — `Stream.append` takes a fast path (offsets from memory, straight to the fan-out).
  Before, every ephemeral batch paid ONE kv write (`maxAssignedOffset`) so an offset could never be
  reused across incarnations. The mark is now committed only with a batch that stored a durable row,
  atomically with those rows — so every offset such a batch handed out, ephemeral ones included, is
  covered.
- THE CONTRACT, written into the Stream header and pinned in `__workers-tests__/stream.test.ts`: an
  ephemeral's offset is unique WITHIN an incarnation; a later incarnation resumes from the last
  durable mark and may hand an ephemeral-only tail's numbers to durables. Safe because every persisted
  checkpoint in the package already advanced only on a durable batch (the processor engine's
  `sawDurable`, the inline reduces' write-on-change, the subscription cursor's durable-boundary rule) —
  so the feared engine change (persist the last durable offset, not `range.through`) was unnecessary;
  the `stream/woken` record, durable in each incarnation's first batch, marks the boundary for anyone
  chaining ranges across it.
- GATES: typecheck clean · unit+harness+workers 347 passed / 1 xfail · e2e 34 passed / 2 xfail · tutorial-proof 8/8 · lint 0/0. MEASURED (same laptop, same probes as step 2+3): perf-guard 14493 → 47619 ev/s, p50 20 → 10 ms; ephemeral flood 15267 → 52632 ev/s, p50 36 → 17 ms — the transaction-plus-mark write per ephemeral batch was two thirds of the cost.

## 2026-09-02 — the onion, step 4: layout by primitive

- `src/core/` is gone (it was not a name). The tree now follows the tutorial's chapters: `context/`
  (capabilities, dispatch, the stub table, the loader, naming), `fetch/`, `stream/` (the log, its
  events, the engine, the inline reduces, subscriptions + the one delivery loop, live state), `sdk/`
  (what `processor.js` bundles), `lib/` (errors, logs, hash, patch). The five files a reader meets
  first stay at the root: `worker.ts`, `session.ts`, `iterate-context.ts`,
  `iterate-context-durable-object.ts`, `itx-entrypoint.ts`.
- Renames: `stream-durable-object.ts` → `iterate-context-durable-object.ts` (it stopped being "the
  stream's DO" several steps ago); `capability-table-processor.ts` → `capability-table.ts`;
  `core/itx-surface.ts` split into `session.ts` (gate + catalog) and `iterate-context.ts` (the
  RpcTarget). Every move is a `git mv`; imports were rewritten mechanically against the new tree,
  path mentions in comments likewise; unit-lane pins moved with their subject.
- GATES: typecheck clean (3 tsconfigs) · unit+harness+workers 347 passed / 1 xfail · e2e 34 passed / 2 xfail · tutorial-proof 8/8 · oxlint 0/0 · knip clean.

## 2026-09-02 — the onion, step 5: the walkthrough, rewritten from source

- `docs/clean-room-api-walkthrough.md` now describes the code as it is after steps 0–4: the session
  shape (`authenticate().projects.get(id)`, `cd`), the two banded sections of `IterateContext`
  (axioms / sugar), mounts as pure data, the subscriptions table and the one delivery loop (push to
  a brand that owns its progress, else a stream-kept cursor), `StreamProcessorDurableObject`
  hosted through the ordinary `getDurableObjectClass`, zero-write ephemerals with their
  incarnation contract, the layer events table, the tree by primitive, and the four flows redrawn.
- The four superseded design documents (`ARCHITECTURE.md`, `docs/iterate-context.md`,
  `ITX-KERNEL-SHAPE.md`, `docs/state-of-play.md`) each carry ONE short banner pointing at the
  walkthrough, the layer map, and the design of record; their long, drifting banners are gone.
- One stray path comment in `wrangler.jsonc` (`core/worker-loader.ts`) followed the step 4 move.

## 2026-09-02 — review round 1: six lenses, four commits

Six parallel reviewers (conceptual clarity, idiomatic Cloudflare, adversarial correctness,
docs-vs-source, test hygiene, commit-path performance) read the tree at 2128cffd2. What they found
and what landed:

- **Correctness (0a00827b7).** MAJOR: `read()`'s short-page proof was the in-memory head, which
  counts ephemeral offsets; the processor engine and the stream-kept cursor persisted it, and a
  later incarnation — which hands those offsets to durables — then skipped them. The proof is now
  the DURABLE MARK (`Stream.durableMark()`); the inline reduces and the resume clamp use it too;
  the ephemeral fast path no longer runs the inline reduces at all. Also: inline reduces write
  their cursor every durable batch (a wake replayed the whole incarnation's log before — measured
  0.4–1.2 s per million rows per slug); a facet is woken at configure time even under a consumes
  filter; a facet load that races a delete refuses; the quiet-clock alarm never re-arms in the
  past; a resume landing mid-delivery is applied, not buried under a halt; a replaced subscription
  drops the old target's cursor; facet pushes carry the delivery watchdog; a pager reports its loss
  once. And a leak the eviction pins exposed: a facet's Workers-RPC RESULT object holds a reference
  on the facet until disposed — every `snapshot()` left an aborted facet pinning the DO until GC.
  `#invokeFacet` copies the data out and disposes the result. Pinned in
  `__workers-tests__/ephemeral-offset-reuse.test.ts` (real DO, quiesce + evict) and two new
  `stream.test.ts` pins (durable-mark proof; zero SQL on a warm ephemeral append). Measured after:
  perf-guard 52632 ev/s p50 9 ms, ephemeral flood 58824 ev/s p50 15 ms.
- **Docs (4255a5340).** Eleven corrections against source (facet push is awaited; the processor
  example names its consumes; types attributed to their real files; the tutorial's auth toy
  follows the Session shape; design doc records wrap-not-split) plus the small print a reader
  trips over (name grammar, cursor birth, the 60 s quiet clock, facet memo, idempotent expression
  mounts).
- **Clarity (58eacf406).** `InlineCore` → `InlineReduces` (it collided with the `core` reduce);
  the engine's hook is `projectLiveState` like the SDK's; one `canonicalCapabilityPath`; the stub
  registry's string is `key` on every layer; inline reduces expose `liveSnapshot`. Deleted: five
  dead options/branches, the fetch lane's silent `itx.` prefix, two pre-emptive `touch()` calls,
  `itxFor`, the DO's public facet doors, the entrypoint's futures; ~40 comment sites stopped
  speaking the old model.
- **Idiomatic Cloudflare (4cb0b450a).** Declarative `exports` for the DO (no migrations history),
  `$schema` + observability, the solo test config built on wrangler's own reader (no JSONC
  regex, no `as never`), the compat truth (nodejs_compat default-on for the platform worker; loaded
  isolates pure-play via one `LOADED_WORKER_COMPATIBILITY`), `WorkerEntrypoint<Env, Props>`,
  `setWebSocketAutoResponse` once in the constructor, `Symbol.dispose` direct (fourteen polyfills
  gone, one of them a fake), `ItxBinding.waitForEvent`. Kept: `allow_irrevocable_stub_storage` —
  it has a consumer (e2e/facets-persistent-stub.e2e.test.ts).
- **Performance.** Verdict: ≥5000 ev/s met with 4× headroom durable (21.5k end-to-end) and 10×
  ephemeral; DO commit CPU is 40 µs / 175 µs per 50-event batch, so transport and storage commit
  are the bottleneck. Do not touch the SQLite schema or batch the INSERTs (measured no gain). Open:
  `RpcStubDirectory.find()` is O(sockets) per push (30 µs at 100 sockets) — an index if it bites.
- **Test hygiene (4ece66812).** The harness lane is gone: its twenty files folded into e2e (one
  shared worker instead of nineteen boots — 53 s to 18 s; `e2e/support/log-harness.ts` for the one
  console-reading file); every e2e file is `<primitive>-<claim>.e2e.test.ts` (`push` had come to
  mean the opposite kind of delivery and is `cursor-delivery`); the eight `*.failing` unit files
  merged into their subjects with one `stream/test-support.ts`; the workers lane shares one
  `support.ts`. No "failing" file remains; about 3,100 lines fewer. A lost-pin audit (round 2) found four
  properties the fold had left unpinned (deleted routes fall through to help text, the /version
  contract, a ':' at the /cap door, no head-of-line blocking during a fan-out) and two weakened
  assertions — all re-pinned.
- GATES at 4ece66812: tsc×3 · unit 176 · workers 38 · e2e 139p/2xf (34 files, ~18 s) ·
  tutorial-proof 8 · Playwright 2 · oxlint 0/0 · knip clean.

## 2026-09-02 — review round 2: three lenses on the round-1 tree

A smaller wave after round 1 landed: a fresh adversarial read of the files round 1 touched, docs
against source again, and a lost-pin audit of the folded test suite.

- **Fresh read.** MAJOR: with a default `consumes`, `enableProcessor` materialized the facet TWICE —
  the configure-time wake and the first push (the configured event itself) both reached `#facet`
  before either load resolved, so the source was evaluated twice (the refetch e2e passed only on a
  lost update in its read-modify-write counter). The wake is now the HEAD of that name's push chain;
  the counter is atomic (one unique key per evaluation). Also: a facet call that never answers no
  longer pins the actor — `#invokeFacet` carries a 60 s watchdog that aborts the facet so the
  in-flight counter drains and the quiesce can run; a facet answer that is not data (a stub, a
  stream) is handed through instead of failing `structuredClone`; a disable landing under a
  configure-time wake or an in-flight push is benign (`NO_FACET` not reported). Documented: a
  `waitUntilProcessed` on an offset above the durable mark resolves only if the processor was pushed
  it; re-subscribing a halted row with the same target restarts from now. The read proof, the inline
  cursor cadence, the pre-batch fence, the alarm, the `key` rename, and the config were all checked
  and found clean.
- **Docs.** 24 mismatches (the biggest: two `{ transportId, path }` spellings, a checkpoint-cadence
  comment saying the opposite of the code, dead test-file names) corrected, and the walkthrough
  gained the facts it still lacked (canonical-key refusal, RPC-result disposal, configure-time
  wake, the watchdog on facet pushes, the racing-delete refusal, the config truths, the pager
  keepalive, `StreamPage`).
- **Lost-pin audit.** 368 → 332 titles; every deliberate drop's survivor asserts the same property
  except four pins the fold had left behind (deleted routes still fall through to help text, the
  `/version` contract, a `:` at the `/cap` door, no head-of-line blocking during a 200-way fan-out)
  and two weakened assertions (a refold's effect list, fresh traffic after a halt) — all re-pinned.
  `pnpm e2e` twice: byte-identical pass sets, no flakes.
- GATES: tsc×3 · unit 176 · workers 38 · e2e 141 (139p/2xf) · tutorial-proof 8 · Playwright 2 ·
  oxlint 0/0 · knip clean.

## 2026-09-02 — the processor is a pure class: `StreamProcessor` + a one-field DurableObject host

Jonas: "i still want stream processors to be pure classes that subclass a StreamProcessor class that
are easy to unit test … a StreamProcessorDurableObject that … initialises the StreamProcessor
subclass and hands it to the StreamProcessorDurableObject." The onion had landed the processor as the
DurableObject itself (wrap, not split); this reverses that one decision.

- **`stream/processor.ts` is two classes.** `StreamProcessor<State>` is the author class and is PURE:
  `contract` + public `reduce` / `processEvent` / `projectLiveState` / `idempotencyKey`, no constructor
  arguments, no stream, no storage — `new Presence().reduce({ event, state })` is a unit test.
  `ProcessorEngine<State>` is everything below the hooks (serial chain, checkpoint, gap repair, at-head
  pass, refold, live-state), built over one processor instance with `{ stream, storage }`. The private
  `Engine`/`Hooks` forwarding adapter in the SDK is gone; `path`/`projectId` left the engine (the
  idempotency key is `${slug}/${key}[@offset]` — a key is scoped to one stream anyway).
- **The host is one field.** `StreamProcessorDurableObject` keeps identity (`ctx.props`), `itx`, the
  five doors and `publishLiveState()`, and hosts `abstract readonly processor` — an author writes
  `export class PresenceDurableObject extends StreamProcessorDurableObject { processor = new Presence() }`.
  A field, so deps ride the processor's own constructor (`new Notifier(this.env.ITX)`) and the same
  class is constructed bare in a test. `className` names the host.
- **Live state re-projects after EVERY batch.** The holder diffs and no-ops when unchanged, so a
  runtime field bumped inside `processEvent` publishes on its own; `publishLiveState()` remains on the
  host for a field moved OUTSIDE a batch (an RPC method). Both `Presence` copies lost their explicit
  call. Pinned: bare construction; one delta for an in-batch runtime bump with no call; zero deltas
  for an unchanged batch.
- **The built-ins are the same class.** `CoreStreamProcessor`, `CapabilityTableProcessor` and
  `SubscriptionsProcessor` extend `StreamProcessor` too; `ReduceOnlyProcessor` is deleted. Hosted
  inline only `reduce` is called, so `InlineReduces` refuses a processor that overrides `processEvent`
  at registration — the reduce-only rule, checked where it matters instead of encoded in a type.
- Userspace sources (fixtures, demo, workers/e2e toys, the gitignored tutorial-proof toy) are the two
  classes, hosts named `<Name>DurableObject`; walkthrough §5.3, the design doc §5.1 (the "wrap, not
  split" paragraph now records the reversal), LAYERS, the tutorial and the SDK header say the split.
- `docs/plan-one-fetch-rules.md` re-aligned to the onion tree: `itx.fetch` already exists (it IS the
  egress tail), mounts carry no policies (D3 reopened — the matcher's home is the open question, a
  subscriptions-shaped table recommended), `fetchCap`/`DEFAULT_CTX`/`?ctx=`/defect 28 already gone,
  the `cd` codec defect already fixed, the gate can be a processor host with a `fetch` door; a §6 lists
  the eight questions for the jam.
- **Naming rule (Jonas):** every class extending `StreamProcessor` ends in `Processor`, every class
  extending `DurableObject` ends in `DurableObject` — `PresenceProcessor` + `PresenceDurableObject`,
  the plain toys `CounterDurableObject` / `ChatroomDurableObject` / `KeeperDurableObject`, every unit-
  test processor. Applied across src, tests, e2e, docs and the gitignored tutorial-proof toys.
- GATES: tsc×3 · unit+workers 219 (25 files) · e2e 140p/2xf (34 files) · tutorial-proof 8 ·
  Playwright 2 · oxlint 0/0 · knip clean.

## 2026-09-02 — ONE core reduce; the breaker is a facet; created/woken in the constructor

Jonas: "a core stream processor that controls all the reduced state that is needed synchronously
before append and during the append cycle … the token bucket runs in a facet and … appends a
stream paused event with a reason." And: steal `stream/created` + `stream/woken` from apps/os,
appended synchronously in the constructor; the DO's first line is `#name = parse(ctx.id.name)`.

- **`CoreStreamProcessor` (3.0.0) is the one inline reduce.** Its state is everything the DO reads
  synchronously: `projectId`/`path`/`createdAt` (from created), `incarnation` (from woken), `paused`,
  `mounts`, `subscriptions` — ten control events, one `reduce`, no verbs. `capability-table` and
  `subscriptions` are event families and slices, no longer inline hosts or facet addresses:
  `itx.facets.get('core').snapshot().state.mounts` / `.subscriptions`; `itx.subscriptions.list()`
  stays the joined view. Only `core` is a reserved subscription name.
- **Commands build events; readers are pure.** `capabilityProvidedEvent`/`capabilityRevokedEvent` +
  `route(mounts, call)` + `CapabilityResolver` (context/capability-table.ts);
  `subscriptionConfiguredEvent`/`subscriptionRemovedEvent` (stream/subscriptions.ts, `null` = an
  idempotent no-op). The DO appends what comes back. `CapabilityTableProcessor` and
  `SubscriptionsProcessor` are gone. A no-op revoke returns no change (a benign double-revoke used to
  rewrite the checkpoint and publish a delta).
- **`InlineReduces` → `InlineReduce`**: one processor, refuses one that overrides `processEvent` at
  construction. (Next: fold it into `Stream` and flatten `append` — Jonas wants the pipeline to read
  as five steps.)
- **The breaker left core.** `BreakerProcessor` + `BreakerDurableObject` (e2e/support/sources.ts,
  `src/breaker.js`): a token bucket refilled from each event's `createdAt`, ignoring the four control
  types, tripping once on the crossing by appending `stream/paused { reason }`; an operator's
  `stream/resumed` restores flow (processor-facet-breaker-pauses-the-stream.e2e). `admit` /
  `assertCanAppend`, `breaker-configured`, `STREAM_BREAKER_OPEN`, `breakerRemaining` and the
  dedupe-aware admission probe (`hasIdempotencyKey`) are deleted; the pause check is one `if` in
  `Stream.append` (created/woken/paused/resumed exempt).
- **`Stream.wake()` from the constructor.** The first incarnation appends `stream/created
{ projectId, path }` at offset 1 and `stream/woken { incarnation }` at 2 (core's live-state delta
  takes 3, an ephemeral; the first user append lands at 4); every later incarnation appends `woken`
  first. The storage-lazy "virgin probe mints nothing" doctrine is gone by decision — any door
  materializes a context. The quiet clock arms only when a facet is live or a stub is paged in
  (`hasRetainedStubs`, O(1)), and the rpcStubs handle re-notes after the call so the invoke that
  pages a stub in arms it (was one activity late — a `test.fails` pin turned green).
- DO: `readonly #name = parseIterateContextDurableObjectName(this.ctx.id.name)` is the first line
  (`{ name, projectId, path }`, the apps/os shape). Docs: walkthrough (§4.5 one core reduce, §5.3
  the breaker example, §5.5 the wake record), design doc (§4.1/§8 record the reversal), LAYERS,
  tutorial, the fetch plan's D3.
- GATES: tsc×3 · unit+workers 235 (25 files) · e2e 136p/2xf (35 files) · tutorial-proof 8 ·
  Playwright 2 · oxlint 0/0 · knip clean.

## 2026-09-02 — the flat `append`; the core reduce is the stream's own; two ~10-line features

Jonas: "I kinda want the append method to just be simple, flat, self documenting … 1) check whether
we can even append — the offset precondition, paused, a valid event — 2) offsets … 3) run the inline
reducer … 4) commit … 5) the after-event stuff." And: "idempotency key check should also be in that
'can I legally make this append' section"; both features "ca 10 LOC" with pins.

- **`Stream.append` reads as the five steps** — may-this-land (well-formed · paused · idempotency ·
  expected offsets, all decided before a single write) · offsets · reduce + commit (one transaction;
  the ephemeral-only batch skips it) · after (waiters → the host's fan-out → core's live delta). The
  dedupe and the conflict refusal moved out of the transaction into `#plan`, so the commit can no
  longer fail on a conflict; a mixed batch with one conflicting input lands nothing.
- **`InlineReduce` is gone; the stream owns its core reduce.** `Stream.core()` (rehydrate, catch up
  to the durable mark), `coreSnapshot()`, `coreLiveSnapshot()`; `#foldCore` inside the transaction,
  `#publishCoreDelta` after. The deps shrink to `{ storage, path, projectId, onCommit }` — `paused`
  and `reduceAtCommit` no longer exist. The DO reads `stream.core()`.
- **Two features, ~10 lines each, pinned in `__workers-tests__/stream.test.ts`:** idempotency (same
  key + body echoes the existing event, no offset; a different body refuses the whole batch coded
  `IDEMPOTENCY_CONFLICT`; a retry beside its original in one batch is one row, two receipts) and the
  EXPECTED OFFSET — an optional `offset` on the input (apps/os's shape) that must equal the offset
  the event would take, else `OFFSET_CONFLICT { expected, actual }` with nothing written; a dedupe
  hit must match it too. The precondition is never stored in the body.
- GATES: tsc×3 · unit+workers 235 (24 files) · e2e 136p/2xf (35 files) · tutorial-proof 8 ·
  Playwright 2 · oxlint 0/0 · knip clean.

## 2026-09-02 — less abstract: `append` inlined, storage opens in the constructor, names say what they hold

Jonas: rename `inputs` → `events` and put "event" in every identifier that holds one; `touch()` is
"weirdly named" — what does it do, how many callers; is `InlineReduce` needed; `core()` → the
reduced state; inline `assertWellFormed`, spell out the handful of pause-exempt events instead of
`isCoreControl`; `#plan` is single-use, so it lives inside `append`; "less abstract, less magical";
the verb is reduce, never fold.

- **`Stream` opens storage in its constructor** (the two tables, the incarnation counter, both
  marks, the core reduced state rehydrated from its checkpoint and caught up to the mark). `touch()`
  had two callers, `wake` and `append`, and is gone; so are `#eventsTableExists` and the "virgin
  stream" probes — constructing a stream IS an incarnation starting. `wake()` now only appends
  created/woken.
- **`append` is one linear method**: shape → pause (the four exempt types listed at the point of
  use) → dedupe + expected offsets + offset assignment → the ephemeral fast path or ONE transaction
  (rows, mark, the core reduce + its checkpoint) → waiters, fan-out, core's live delta. `#plan`,
  `#eventBody`, `#eventByIdempotencyKey`, `#reduceCoreAtCommit`, `#publishCoreDelta`,
  `assertWellFormed`, `isCoreControl` and `InlineReduce` no longer exist. What remains as helpers has
  two callers or is a unit of its own: `#reduceCoreEvent`, `#settleWaiters`, `#storeEvent` (chunking),
  `#reassemble`.
- **The core reduced state is a field**, `#coreReducedState` (+ `#coreReducedThroughOffset`), filled
  by the constructor and advanced by every durable commit; `stream.coreReducedState` is the getter the
  DO reads. The processor stays pure (a contract and a reduce), as decided.
- **Names**: `inputs` → `events` everywhere; `fresh`/`receipts`/`distinct`/`e`/`existing`/`rest`
  → `freshEvents`/`committedEvents`/`event`/`existingEvent`/`eventInput`; the delivery loop's
  `#pushed`/`batch` → `#pushedEventBatches`/`eventBatch`; test support's log is `durableEvents`,
  `pushedEvents`. The verb is reduce: `foldsEvent` → `reducesEvent`, "refold" → "re-reduce", every
  "fold" in code, tests and current docs.
- GATES: tsc×3 · unit+workers 234 (24 files) · e2e 136p/2xf (35 files) · tutorial-proof 8 ·
  Playwright 2 · oxlint 0/0 · knip clean.
- **Breadcrumb names (same day).** Helpers say what they do to what, so their comments could shrink:
  `wake()` → `appendCreatedAndWokenEvents()`, `durableMark()` → `highestDurableOffset()`,
  `coreSnapshot`/`coreLiveSnapshot` → `coreReducedStateSnapshot`/`coreLiveStateSnapshot`,
  `#reassemble` → `#reassembleEventBodyFromChunks`, `#storeEvent` → `#insertEventRowAndChunks`,
  `#settleWaiters` → `#resolveWaitForEventWaiters`, `#reduceCoreEvent` →
  `#reduceEventIntoCoreReducedState`, `#waiters` → `#waitForEventWaiters`, `markFired` →
  `noteAlarmFired`, the DO's `#noteActivity` → `#recordActivityForQuietClock`, `#resolver` →
  `#capabilityResolver`. apps/os checked: its constructor appends created/woken synchronously
  (`#finishInitialization` → the sync `#append`; `blockConcurrencyWhile` only rebuilds a stale
  checkpoint) — the clean room does the same in two lines of the DO constructor (`new Stream` opens
  storage, `appendCreatedAndWokenEvents` appends); the two appends cannot move INTO the Stream
  constructor because the fan-out closure reaches DO fields that do not exist yet mid-construction.
- **The checkpoint can never be missing (same day).** Jonas asked how; the docs say SQLite storage
  writes in one synchronous block are one atomic implicit transaction (ours is an explicit
  `transactionSync`), so the rows, the mark and the core checkpoint never disagree. The
  constructor's generic "catch up to the mark" loop is now an explicit branch: checkpoint present →
  use it; absent → either a store with no commits (mark 0) or a contract-version bump, in which case
  the durable log is re-reduced from offset 0. `#reduceEventIntoCoreReducedState` keeps its two
  callers (that re-reduce, and the commit).

## 2026-09-02 — the whole tree gets the treatment: five reviewers, one plan per area

Five read-only reviewers reflected on the morning's doctrine (inline single-use helpers, breadcrumb
names, spell out the handful, no one-consumer mechanism, constructor does the sync work, cite platform
facts) and ranked opportunities across the engine + SDK host, the delivery loop, the context DO, the
`context/` layer and the edge + leaves. Applied in waves; each wave below.

- **The delivery loop (this commit, 425 → 367 lines).** Cursor rows are loaded ONCE in the
  constructor, so memory is the one truth: `cursor()` no longer falls back to kv, the alarm's sweep
  no longer unions kv keys, and the whole "generation" compare (`#sameGeneration`, `resumedAt`) is a
  `#cursors.has(name)` — a removal or a replacement empties the map; nothing else can touch a row
  mid-delivery in a single-threaded DO. Facet pushes lost the loop's 20 s watchdog (the DO's 60 s
  facet watchdog already aborts a hung facet; two timers on one call was the doctrine's own example);
  the cursor call keeps its 20 s through `lib/timeout.ts` (`withTimeout`, coded `TIMEOUT`, the one
  race-with-a-cleared-timer — the DO's watchdog moves onto it next). The deps are the stream itself
  plus `kv`, `evaluate`, `recordActivityForQuietClock` (nine closures → four; `now` and `head` gone).
  A cursor target is evaluated once per delivery run, not twice. `callOn` is shared from
  `context/dispatch.ts` instead of re-spelled. Names: `#pump` → `#deliverFromCursor`, `#dispatch` →
  `#deliverEventBatch`, `#resolve` → `#evaluateTargetHead`, `forget` → `#forgetSubscription`
  (private), `#save` → `#adoptCursor`, `#pushes` → `#deliveryChainBySubscription`, `pumpAll` →
  `deliverEveryCursorSubscription`, `resumedAt` → `resumeAppliedAtOffset`; `inFlight` is gone (a
  cursor delivery pins nothing local — a facet it calls is counted by `#facetWorkInFlight`).
- **A regression caught on the way (592e3dc9e):** the earlier `\bwake\(\)` rename had also renamed
  the processor engine's and SDK host's `wake()` — the facet's CATCH-UP door — while the loop still
  invoked `["wake"]` by name, so every `enableProcessor` reported an issue and skipped its
  configure-time catch-up. It is `catchUpFromLog()` now, at one call site. Lesson recorded: rename per
  call site, never by regex over a verb.
- **The facet door (e8d9e42c9).** `#resolveFacet` + `#facet` + `versionedFacet` + `#resolvedFacetSource`
  folded into ONE linear `#invokeFacet`: startup memo → load (source resolved once per
  materialization, riding `#liveFacets`, now a Map with the resolved source) → racing-delete check →
  class + version marker → the call under `lib/timeout`'s 60 s watchdog → copy + dispose the answer.
  The two WebSocket-hook adapters are `this.ctx`; `webSocketError` is one line.
- **The engine (0d810288c).** The constructor rehydrates the checkpoint and builds the LiveState
  holder synchronously; `#loadProgress`, `#liveHolder`, `#projectionOf`, `PROJECTION_FAILED`, the
  per-batch seed, the rebirth block, the impossible "row genuinely missing" fallback, `#catchUpBody`
  and `#repairThrough` are gone. Six private methods instead of ten; `processEventBatch` → `reduce` is
  four hops. The SDK host takes `Service<ItxEntrypoint>` and `ctx.storage.kv` directly (103 lines).
- **The edge and the leaves (817923389).** `IterateContext` lost the `RpcStubs` class, the
  `rpcStubs` getter and the `append`/`read`/`fetch` proxies — the built-in roots and the terminal-fetch
  rule already serve them through the one door (410 → 315). The core reduce no longer catches what
  the stream already contains; `logs.ts` keeps only `warn`; `LiveState.set` is one try with a separate
  serialized diff base; the client store's rev sentinel is `null`.
- **The context layer + the DO seams (this commit).** `CapabilityResolver.resolve` is one linear
  method over `mounts: () => …` — `evaluate`, `apply`, `#itxAtDepth`, `resolveCurrent`, the `scope`
  concept and the depth argument on the DO's public `invoke` are gone; `itx.kv.get('a')` is two
  frames, an alias re-enters nothing (SEMANTIC NOTE: an alias target is now resolved as a VALUE and
  the steps after the mount walk on it — a more specific mount under the alias's target path is no
  longer consulted; nothing pinned the old behaviour). The rpc-stub trio is ONE `rpc-stub-directory.ts`
  (the manager absorbed, the relay's dialer inlined; `hibernatable-rpc-stub.ts` deleted). The loader
  is one function (`where`, `contentHash`, no `mainModule`; `hash.ts` deleted). Built-ins take the
  DO's `host`; the DO declares its own `Env`. The capability fetch lane is INLINED into the DO's
  `fetch` — four plain doors, no `PartialFetch`, no `serveCapabilityFetchLane` — and strips
  `x-itx-cap` before resolving, so the routing header never reaches a capability or egress (the edge
  review found it leaking to FALLBACK for root `itx.fetch`). `Match` reads `argsAtMount` /
  `stepsAfterMount`; `dotted-path-proxy` has one `RESERVED` set.
- **Where we are.** Production `src/`: this morning 4,233 code lines · 53 private methods · 116
  exports → now 3,588 · 36 · 100 (−15% code, −17 helpers, −16 exported names); `context/` 3,097 →
  1,747 lines; tests 11,069 → 11,668 (pins moved, none dropped). Key files: DO 768 → 675, engine 582
  → 560, delivery 422 → 375, host 190 → 103, `IterateContext` 410 → 315, fetch-capabilities 362 → 307.
- Not done, on purpose or pending a call: `Parking` → `session.ts`; the zod event envelope as plain
  types (SDK surface); `rpcStubAttach`'s canonical-key assert (a deliberate review-round guard);
  `configureSubscription` returning void; the alarm-quiesce pins that pass vacuously without a
  facet or stub.
- GATES: tsc×3 · unit+workers 234 (24 files) · e2e 136p/2xf (35 files) · tutorial-proof 8 ·
  Playwright 2 · oxlint 0/0 · knip clean.

## 2026-09-02 — a mount is a REWRITE RULE; a path may pin call args; routing is ONE module + ONE table

- **Why.** The context-layer flatten (7a0afa273) resolved an alias's target as a VALUE and walked the
  steps after the mount on it — so a longer mount under the target's path was never consulted. Jonas:
  "what is an 'alias'?!?! sounds like a leaky abstraction", "i think you SHOULD be able to capture the
  deeper call with the deeper mount", "i would even expect to be able to match `itx.ai.run('some-model')`",
  "can you also match on `itx.something.get('bla').someOtherThing('something', inputs)`?", and: make the
  matching "really easy to understand and encapsulated in a single Module … table-based tests …
  if the call is such and such and the existing mounts table is such and such, then here's what I
  would expect the actual invocation to look like."
- **The word "alias" is gone (3c8c0b61c, 0dc486e9e).** A mount is `{ path, target }` and means ONE
  thing: a call that starts with `path` is the same call with `path` replaced by `target`. Rewriting
  repeats until the root is a built-in, so `itx.db ⇒ itx.store` + `itx.store.deep ⇒ itx.whoami` makes
  `itx.db.deep()` run `itx.whoami()` — the deeper mount captures. Pinned in unit + e2e.
- **Pinned args (this commit).** A capability path is dotted names where ANY step may be a call step
  pinning literal args — `itx.ai.run('gpt-5')`, `itx.repo.get('main').files`. It matches a call whose
  leading args are structurally equal to the pins; the pins are CONSUMED (partial application, the
  target replaces every matched step — Jonas: "Isn't this like basically currying … yes, I think I do
  want it"): `itx.ai.run('gpt-5') ⇒ itx.openai.chat` turns `itx.ai.run('gpt-5', inputs)` into
  `itx.openai.chat(inputs)`. A residual arg on a NON-final pinned step is a non-match (nowhere to go).
  Ranking: longest path, then most pinned args, then newest. Stored canonical (`print`), revoked by
  the same spelling; the door refuses `itx.a()` (an argless call step: spell `itx.a`) and any `""` step.
- **ONE module.** `src/context/routing.ts` (115 lines, pure, total): `matchMount` (rule 2), `pickMount`
  (rule 3), `rewriteCall` (rule 4), `routeCall` (rules 3–5, the depth-32 budget, default-deny). Its
  header is THE RULES 1–5. `dispatch.ts` lost `match` and only EXECUTES a routed call (`walkSteps`
  learned the anonymous `""` step: `f(x)(y)` → `["", ...args]`, what a rewrite spells when the unpinned
  args land on a target that already ends in a call — a live value). `CapabilityResolver.resolve` is
  `routeCall` + the root + `walkSteps` + `extraArgs`; `route`, `pinnedArgCount` and the recursive
  `depth` argument are gone. `Mount.path` is a `CapabilityPath` (= `Expression`, doc'd), not `string[]`.
- **ONE table.** `routing.test.ts`: rows `{ mounts: ["path ⇒ target", …], call, becomes }` and
  `{ …, throws }`, later rows newer; every rule above is a row; the anonymous step round-trips the
  codec. `matchMount` rows `{ path, call, match }`. `dispatch.test.ts` keeps only the walk;
  `capability-table.test.ts` keeps the door + the resolver. e2e:
  `capability-table-argument-pinned-mounts` — provide plain + pinned, route both, a live value under a
  pinned key sees only the unpinned args, revoke by the pinned spelling.
- Doc: `docs/plan-argument-matched-mounts.md` LANDED note (two differences from its recommendation:
  consume, mid-path pins); the walkthrough tree names `routing.ts`.

## 2026-09-02 — the stub vocabulary: a session LENDS, the DO BORROWS and RETURNS; "parking" is gone

- **Why.** Jonas: "what is 'parked stub'? is it 'hibernatable rpc stub'?" … "Wouldn't it be more fair
  to say that the stub is borrowed by the durable object from the edge worker? … parking does need
  to be changed." One relationship, two verbs, spelled from each side.
- **Edge (owner).** `Parking` → `SessionTeardown` (`add` / `dispose` / `disposeAll`), MOVED out of
  `rpc-stub-relay.ts` into `session.ts` — it is what a session must undo at its end, keyed
  `"<contextName> <capabilityPath>"`. `#parkLiveStub` → `#lendStub`, `#closeParkedStub` →
  `#recallStub`, `startRpcStubRelay` → `lendStubOverRelay`, `RetainedProviderStub` →
  `LentProviderStub`.
- **DO (borrower).** `RetainedCallbackInvoker` → `BorrowedStub`; `RpcStubDirectory.activate` →
  `lend`, `DO.rpcStubActivate` → `rpcStubLend`; `#retained` → `#borrowed`, `#pageIn` → `#borrowStub`,
  `hasRetainedStubs` → `hasBorrowedStubs`, `disposeRetainedStubs` → `returnBorrowedStubs`;
  `transportState().pagedIn` → `.borrowed`; the four "hibernatable rpc stub …" errors say "rpc stub …".
  Wire constants and `rpcStubAttach` unchanged; "pager"/"page" stay for the socket and the request;
  "hibernatable" survives only where it names the SOCKET. `waitForEvent`'s "parked waiter" is a
  waiting waiter. `e2e/session-parking-per-context` → `session-lends-per-context`.
- **Two vacuous pins re-pinned.** A context with no live facet and no borrowed stub arms NO alarm, so
  `runDurableObjectAlarm` fired into an empty schedule and both pins passed for nothing (proved: with
  the arming removed, `alarmAt === null` passed and the new `runDurableObjectAlarm === true` failed).
  `alarm-quiesce` "A BORROW RACES THE QUIESCE ALARM" now warms one stub, asserts `borrowed ≥ 1` and an
  alarm, then races — the alarm really runs concurrently with an invoke that borrows another stub, and
  that invoke still returns its own client's answer. Its "SCALE DROP + QUIESCE + EVICT + WAKE" warms a
  stub so `borrowed === 0` after the quiesce proves a real return (and the evict is a real #6800
  sequence). `ephemeral-offset-reuse` "alarm pump with ephemerals at head" materializes an unrelated
  facet to arm the alarm, asserts the alarm fired, so `deliverEveryCursorSubscription` really ran over
  an ephemeral head and left the cursor on the durable mark.
- Lines: relay 211 → 183 (`Parking` moved out), session 89 → 116, directory 373 → 367.

## 2026-09-02 — the event envelope is two plain types; zod stays for contracts

- **Jonas's delegation.** "I think you can decide Zod event envelope. You can decide whether ITX RPC
  stubs keeps its name." (and no strong view on the `rpcStubAttach` assert.)
- **Envelope → plain types.** `StreamEventInput` and `StreamEvent` were zod schemas nobody parsed:
  the append door (stream.ts step 1) already checks the two rules by hand (`type` a non-empty
  string; ephemeral ⇒ no idempotencyKey), no test pinned the schema values, and no userspace source
  used them as values — they were 45 lines of zod spelling a TYPE. Now they are the two TypeScript
  types the walkthrough already showed (`StreamEvent = Omit<StreamEventInput, "offset"> & { offset,
createdAt, path }`); the SDK exports them as types. zod is unchanged where it earns its keep: the
  CONTRACTS — `defineProcessorContract`, state schemas, owned-event payload schemas (the recorded
  owner's call: isolates get zod and full contract schemas). events.ts 126 → 112; SDK bundle rebuilt.
- **`rpcStubAttach`'s canonical-key assert stays.** Read as "no strong view"; the status quo is one
  `if` at the one door that keys the registry and the mount identity. Delete it the day it annoys.
- **`itx.rpcStubs` keeps its name for now.** The verbs carry the lend/borrow symmetry (edge lends and
  recalls; the DO borrows on `get`, returns at idle). A symmetric API — `lend` as a first-class door
  with the pager layered on top — is proposed in the reply to Jonas (2026-09-02) and waits on his call.

## 2026-09-02 — THE ITX SURFACE: two things named apart, the edge is a proxy, ONE event per table

- **Why.** Jonas's Plannotator rounds on `docs/plan-itx-surface-mirror-and-route-rename.md` ("still
  feels quite messy") → four sub-agent designs under incompatible constraints →
  `docs/proposals/itx-surface-SYNTHESIS.md` (§1 the ten convergences, §2 the four splits, §8 his
  rulings, §9 as built). His rulings: **(a) rpc stubs** and **(b) itx-expression rewrite rules** are
  two different things and are named as such ("this concept is not really about capabilities, it's
  about itx expressions"); the table is a **MAP** ("way easier to just delete the rule from a map");
  the event is `events.iterate.com/itx/rewrite-rule-configured { match, target | null }` (the
  namespace is the domain word; there is no ItxExpressionProcessor — the rules are a slice of the one
  core reduce); "rewrite rule" is the noun, `rewrite` the verb; no offset on a rule row ("what is an
  actual case where this race matters?" — none); fully qualified names everywhere (`ItxExpression`,
  `ItxExpressionPrefix`, `itxExpressionSteps`, `rpcStubKey`, `#borrowedRpcStubs`); provide/invoke are
  chapter 1, expressions chapter 2, rewrite rules chapter 3; every verb returns a DISPOSABLE handle
  (`using`); examples use inline sources; "don't worry about that at all" on the wire flag day.
- **(b) itx-expression rewriting — ONE file** (`context/itx-expression-rewriting.ts`, replaces
  capability-table.ts + routing.ts): THE RULES 1–5 in the header, `matchItxExpressionPrefix` /
  `pickItxExpressionRewriteRule` / `applyItxExpressionRewriteRule` / `rewriteItxExpressionToBuiltIn`,
  the ONE event builder `rewriteRuleConfiguredEvent(match, target | null)`, and `ItxExpressionResolver`.
  Ranking is longest match, then most pinned args — no "newest": one rule per match. Core state
  `itxExpressionRewriteRules` is a record by canonical match (set replaces, null deletes); contract
  4.0.0; `subscription-configured { name, target | null }` absorbs `subscription-removed` the same way.
  `NO_ITX_EXPRESSION_MATCH`; the fetch lane is `/expression?context=&itx=` + `x-itx-expression`.
  `ItxExpressionRewriteRule { match, target }` — nothing else; the shadow stack, revoke-by-identity,
  `providedAtOffset` and the door's idempotency policy are GONE (a re-set appends one event, the table
  still holds one rule). The table test is the table (`itx-expression-rewriting.test.ts`, rows
  `{ rules, call, becomes }`).
- **The edge is a PROXY** (`iterate-context.ts`): declares `cd`, `invoke` (was invokeCapability),
  `provide(rpcStubKey, stub, { rewrite? })`, `rewrite(match, target | null)`, `subscribe({ name?,
target | null, consumes? })`, `enableProcessor`, `disableProcessor`. Every built-in root — `append`,
  `read`, the NEW roots `waitForEvent` and `expressionRewriteRules.list/get`, `kv`, `rpcStubs`,
  `facets`, `load`, … — rides the prototype-hop fallback with ZERO edge code (`dotted-path-proxy.ts`:
  `installPrototypeInvokeFallback`, `createItxExpressionPathProxy`; the double-install throw is gone —
  guard audit #4). Each verb is visibly "build the event, `invoke(["itx",["append",event]])`": the DO's
  `provideCapability` / `revokeCapability` / `configureSubscription` / `removeSubscription` are DELETED
  — the DO has `append`, `read`, `waitForEvent`, `invoke`, `fetch` and the rpc-stub plumbing, nothing
  else. Handles: `SessionScopedHandle` (dispose = undo) and `SubscriptionHandle` (+ `name` getter);
  capnweb disposes every exported handle at session end, so a rule or subscription made through the
  verb is SESSION-SCOPED — the durable spelling is the raw event through `itx.append`; processors stay
  durable. `InvokeHandle` dispatches `itxExpressionSteps` (`invokePath` deleted); `assertLiveValue` is
  gone (a non-stub fails at `dup()` before anything is reserved).
- **"The rule dies with the stub" is decided DO-side.** The M–Z e2e agent found the clobber: session A
  provides `itx.p`, session B re-provides the same key, A's session dies later — A's teardown would
  un-set the rule B is serving. So the un-set moved to the one place that knows presence truth:
  `IterateContextDurableObject.#unsetWhatNamesRpcStub` on the key's LAST pager close (a reconnect
  REPLACES the pager — never a detach). The edge's provide undo is just the pager. Accepted
  consequence, spelled out: a PURE `rewrite` handle disposed after another session re-set the same
  match deletes that rule — trusted clients, last writer wins.
- **Tests** re-pointed by four agents + this session: unit 206 (24 files), workers 45 (do-doors now
  pins the MAP and the absence of the four verbs), e2e 141p/2xf (37 files; `capability-table-*` →
  `rewrite-rules-*`, `rpc-stubs-mounts-stay-offline-until-revoked` → `rpc-stubs-lend-recall-and-offline`
  with the flipped pins: dispose ⇒ rule + presence gone ⇒ NO_ITX_EXPRESSION_MATCH; mid-invoke death ⇒
  RPC_STUB_OFFLINE in flight; a hand-configured rule to an un-lent key ⇒ RPC_STUB_OFFLINE), tutorial-proof
  platform 8 + part0 48 PASS, Playwright 2. `e2e/support/client.ts`: `expressionUrl`,
  `rpcStubRewriteRuleMatches`. Client: `live-state-client.ts` disposes the `SubscriptionHandle`.
- **LOC**: production `src/` 3,785 → 3,764 code lines with the surface (the rpc-stub layer commit was
  flat: two `if`s and fully qualified names cost what the deleted guards saved). Next: the stream door
  trim and `INHERITED_BUILTINS` from the guard audit.
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 251 · e2e 141p/2xf · tutorial-proof 8 + part0 48 ·
  Playwright 2.

## 2026-09-02 — guard-audit trims: the append door, the inherited-builtins set, dead armor

- **Why.** Jonas, on deleting `providedAtOffset`: "see if there are other unnecessary guards like that
  that we can just delete to reduce complexity" → `docs/proposals/guard-audit.md` (20 DELETE/SIMPLIFY
  rows, 30 KEEP rows that encode platform facts). Landed in the surface commit: `assertLiveValue` + the
  pending-attach sweep (one guard twice), `rpcStubAttach`'s canonical assert, the fetch/pager door's
  Upgrade-header 400s + `#pendingDials` interlock + attachment try/catch, the prototype double-install
  throw. Landed here:
- **`Stream.append` step 1 is one `if`**: a non-empty `type`. Gone: the `ephemeral` must-be-literal-true
  refusal (the `ephemeral?: true` type already says it; every consumer tests truthiness), the
  `EPHEMERAL_IDEMPOTENCY_KEY` code and refusal (an ephemeral's key is simply never stored — ephemerals
  never reach the idempotency column), and OFFSET_CONFLICT on a dedupe HIT (a retry answers with the
  event it already has, whatever `offset` it hoped for — the semantics people want). The `try/catch`
  around a waiter's `resolve` was dead armor (a Promise's own resolve cannot throw).
- **`dispatch.ts`'s `INHERITED_BUILTINS` set is gone** — anti-probe defense for untrusted callers; with
  trusted clients `itx.kv.toString()` answering `"[object Object]"` is a weird answer, not a breach.
  The three-name line stays (`constructor` would hand out the class). On a facet stub the platform
  rejects an unexposed name in its own words (the e2e pin now says so).
- Tests: three pins deleted with their guards (ephemeral:false, ephemeral+idempotencyKey ×2), two
  flipped (dedupe hit + offset ⇒ the existing event; facet `toString()` ⇒ rejects). src 3,764 → 3,735.
- GATES: tsc×3 · oxlint 0/0 · knip · unit+workers 250 · e2e 141p/2xf.

## 2026-09-02 — `provide(rpcStubKey, stub, options?)`; `LiveValue` deleted; a names sweep

- Jonas: "Is provide overloaded, or is this weird format with key, object the intended API?" → not
  overloaded, but the stub sat inside the options bag. Now POSITIONAL: `provide(rpcStubKey, stub,
options?)` with `options.rewrite`; chapter 1 reads `itx.provide("laptop", fn)`, and `options` is where
  an idle policy or a timeout goes later. Every call site (tests, proofs, docs) re-spelled.
- "Why would you call that live value and not client RPC stub? Please delete it." → `LiveValue`
  (`= unknown`) is gone; the edge types the client's stub as `ClientRpcStub` (rpc-stub-relay.ts — the
  name that already existed). "live value" is gone from every comment and title too.
- The sweep for other invented or bare names, applied: `SessionScopedHandle` (a lifetime, not a noun)
  → `ProvidedRpcStubHandle` / `RewriteRuleHandle` / `SubscriptionHandle`; `ContextNamespace` →
  `IterateContextNamespace`; `#contexts`/`#address` → `#contextNamespace`/`#durableObjectAddress`;
  `SessionTeardown.#undo` → `#undoByKey`; `#teardown` → `#sessionTeardown`; `InvokeHandle.#dispatch` →
  `#dispatchItxExpressionSteps`; `LentRpcStub.#broken` → `#clientSessionBroken`, `#walk` →
  `#walkItxExpressionSteps`; `SubscriptionDelivery`'s `type Deps` → `SubscriptionDeliveryDeps`,
  `#evaluate` → `#evaluateItxExpression`; the DO's `#delivery` → `#subscriptionDelivery`, local `live`
  → `liveFacet`; built-ins `own()` → `ownContext()`; stream.ts `interface Context` → `ReachableContext`
  (+ `localReachableContext`); rpc-stub-fetch `ProviderSocket` → `ClientWebSocket`; `LiveState.#key /
#sink / #rev` → `#liveStateKey / #liveStateSink / #liveStateRev`; client `LiveItx` → `LiveStateItx`;
  `const lent` → `targetIsLentRpcStub`. Left as they are: `WaitUntil`, `Scalar`, `LogFields`,
  `InvokeTarget`, `WebSocketHooks` — each already says what it holds.
- GATES: tsc×3 · oxlint 0/0 · knip · unit 205 · workers 45 · e2e 141p/2xf · tutorial-proof 8 · Playwright 2.

## 2026-09-02 — Plannotator round on `docs/itx-surface-as-built.md`: 17 annotations, the decided ones applied

- **The doc.** `docs/itx-surface-as-built.md` — the whole surface on one page (the tour in tutorial
  order, the edge's declared methods, the built-in roots, the two vocabularies, core's events,
  delivery, lifetimes, code structure) plus §12: what the review decided and what is still open, each
  open item with a concrete proposal. Jonas annotated it in Plannotator; this entry is the fallout.
- **`ItxEntrypoint` = `get()` + `fetch`, nothing else** ("yes - should just be get and fetch").
  `append`/`read`/`waitForEvent` deleted; the SDK host's engine appends through the scope —
  `this.env.ITX.get().append(…)`, one pipelined round trip — and a `LiveState` sink in a field
  initializer is `{ append: (e) => this.env.ITX.get().append(e) }` (chatroom fixture; the first full
  e2e run caught `new LiveState(this.env.ITX, …)` still expecting the deleted verb). `fetch` stays the
  RAW-Request door to the DO: routing it through `get().invoke(["itx",["fetch",…]])` was tried and
  broke fetch-door-dynamic-live-ws — the edge's terminal-fetch fork overwrites an `x-itx-expression`
  header a loaded worker set itself; the DO's fetch door is where raw Requests are sorted.
- **`env.CONTEXT` → `env.ITERATE_CONTEXT`; `contextName` → `iterateContextName`** (Jonas: "i don't
  like the use of raw CONTEXT as a term because there are other kinds of context… then it should be
  called env.ITERATE_CONTEXT"; singular, as Cloudflare and apps/os name DO bindings). Both wrangler
  configs, the workers-tests support, the control-plane shell's cross-script binding (its tsconfig
  also gains `ESNext.Disposable` — it typechecks project-worker's `Symbol.dispose` through the type
  import and had been red).
- **A subscription removal deletes the facet it HOSTED** ("ok" on making disable one event). The DO's
  `append` captures the pre-commit rows; for each committed `subscription-configured { target: null }`
  whose removed row targeted `itx.load(…).getDurableObjectClass(C).get(name)…`, `#deleteFacet(name)`
  runs before the append returns. A row that only ADDRESSED a facet (`itx.facets.get(n)…`) deletes
  nothing. `disableProcessor` is now ONE append; the raw event is the same disablement (new lineage
  pin: hand-appended null ⇒ NO_FACET, re-enable rebuilds from the log, counts exact).
- **The edge type shows the built-ins.** `export interface IterateContext extends Omit<BuiltInScope,
"cd"> {}` — declaration merging, zero runtime; `BuiltInScope` exported for this one reader. Answers
  "I would like for the RPC target class to sort of show very clearly the stuff that exists" without
  moving execution to the edge (rules live in the DO; a KV cache of rewrites is a later option).
- **A live subscriber's key is `subscription:<name>`** (was `itx.subscriptions.<name>` — a key that
  looked like an expression). Examples use bare keys and the STRING half; the e2e sweep of
  `"itx.tools"`-style keys is deferred until open item A decides whether keys survive the front door.
- Kept on Jonas's word: `subscribe` takes one object; `enableProcessor`/`disableProcessor` stay;
  `authenticate()` stays a no-op gate; the two one-member handle classes stay two.
- **LOC honesty** ("did we just add over 1k LOC?!?!"): the doc's 6,234 was RAW lines (comments +
  blanks; ~38% of the source is comment). Code lines (non-blank, non-comment), one filter across
  commits: 4,481 (09-01 morning) → 3,879 (fe8168c13) → 3,886 now.
- **Open, proposed in §12 (Jonas afk):** A — ONE front door `provide(match, stub | expression | null)`,
  `rewrite` deleted, key = canonical match, handle `RewriteRuleHandle`, read root `itx.rewriteRules`;
  B — inline-only `WorkerSource` (delete the producer-expression branch; "no more itx.kv.get… rub
  that out"); C — ONE facet door `itx.facets.get(name, { source, className })`, `load` keeps
  `getEntrypoint` only; D — edge `cd` vs built-in `cd` explained, keep both.
- GATES: tsc×3 (+ the shell's) · oxlint 0/0 · knip clean · unit+workers 250 · e2e 141p/2xf (37 files; the
  full lane, twice: the first run caught the chatroom sink and the entrypoint-fetch detour).

## 2026-09-02 — A: ONE front door — `provide(match, target)`, `rewrite` deleted

- Jonas, in the review: "what if i wanted to provide and rewrite itx.ai.run('gpt-5') and provide a
  function that implements it? … I do feel like maybe a single provide verb is actually clearer. And we
  just explained that either we're providing real stuff or we're rewriting something." Then "ok" on the
  recommendation. The two layers are untouched; only the edge verb collapsed.
- **`provide(match, target: ClientRpcStub | ItxExpressionInput | null): Promise<RewriteRuleHandle>`.**
  A live stub is lent under the key = the CANONICAL MATCH (`lendRpcStubOverPager(…, matchString, …)`)
  and the rule `match ⇒ itx.rpcStubs.get('<match>')` appended — the rule event is BUILT before the
  lend so a spelling the codec refuses throws with nothing lent; an expression is the rule alone;
  `null` appends the un-set and disposes this session's teardown entry for the key. `rewrite` is gone;
  `ProvidedRpcStubHandle` is gone (the durable thing made is always the rule, so `RewriteRuleHandle`
  for both; disposing recalls a lent stub or appends `null` for an expression).
- **The match must be rooted at `itx`** — `rewriteRuleConfiguredEvent` now refuses `provide("later", …)`
  (a match no call could ever start with), the way it already refused a target not rooted at itx.
- **Read root `itx.rewriteRules.list()/get(match)`** (was `expressionRewriteRules`; the event and the verb
  already say "rewrite rule"). The `rpcStubKey` NOUN leaves the front door; it lives on inside
  `RpcStubDirectory` and as `subscription:<name>` for a live subscriber.
- Sweep: 47 `provide(K, stub, { rewrite: K })` collapsed to `provide(K, stub)`; every `.rewrite(` became
  `.provide(`; the hand-rule e2e's bare key `later` became the match `itx.later`. The deferred bare-key
  sweep dissolved: a key IS its match. Docs re-pointed (as-built §2/§4/§6/§7/§10/§12 — A moved to
  "decided"; LAYERS; walkthrough; onion design; synthesis §9 addendum).
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 250 · e2e 141p/2xf (37 files).

## 2026-09-02 — C: ONE facet door — `itx.facets.get(name, { source, className })`

- Jonas, on "two doors to a facet": "what would be better?" → the mirror of Cloudflare's own
  `ctx.facets.get(name, startupCallback)`: ONE door. `itx.facets.get(name)` ADDRESSES a running facet
  (a processor, a named instance); `itx.facets.get(name, { source, className })` LOADS the class and
  hosts it as the durable facet `name`. The `load(src).getDurableObjectClass(C).get(name?)` chain is
  DELETED — `load(src)` keeps `getEntrypoint` only (the stateless mirror). The facet name is now always
  explicit (no `.get()` defaulting to the class name).
- `enableProcessor`'s target is `itx.facets.get(name, { source, className }).processEventBatch`; the
  DO's "did the removed row HOST a facet?" check is now "a `facets.get` with a spec" — one shape,
  three lines. `#invokeFacet` takes `{ name, source, className }` with `name` required.
- Sweep: every e2e/workers-test chain re-spelled (workers-and-facets-sources, facets-mid-chain-pipelining — the
  dyn-worker→dyn-worker pipelining case now pipelines `facets.get(name, spec).demo.timer.callLater`;
  facets-persistent-stub, live-state-chains, subscriptions-ephemeral-opt-in, lineage, tour,
  alarm-quiesce, ephemeral-offset-reuse); `processorNames` matches `facets.get(…, {…}).processEventBatch`.
  Docs: as-built §5/§9/§10/§12 (C → decided), LAYERS, walkthrough, onion design (a dated note where
  the doc sketched the chain).
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 250 · e2e 141p/2xf (37 files).

## 2026-09-02 — B: sources are INLINE ONLY — `WorkerSource = Record<string, string>`

- Jonas: "I thought we said no more itx.kv.get. Like we should just rub that out. I don't think it's a
  good pattern. I don't think it's helpful to understand. I think we should do inline source code."
  → the PRODUCER-EXPRESSION branch (`"itx.kv.get('src/x.js')"` fetching the code) and the
  `{ type: "inline", files }` wrapper are DELETED. A source IS the worker's modules, module name →
  code, `"cap.js"` the main module (one loud check in the loader). Stored where it is named: a facet's
  startup memo (`facet:<name>` = `{ source: modules, className }`), a subscription's target.
- Gone with it: the loader's `invoke` and `resolved` options, `BuildBuiltInsDeps.invoke`, the DO's
  resolved-source cache (`#liveFacets` Map → `#liveFacetNames` Set — the quiesce loop needs names only),
  `processor-facet-source-refetch.e2e` (it pinned "a producer is evaluated once per materialization";
  there is no producer). `runScript` wraps its lambda as `{ "cap.js": … }`.
- Tests: `e2e/support/sources.ts` exports `SOURCES.<name>` as module records, `seedSources` is gone,
  `enableFixtureProcessor` passes `SOURCES[name]`; 17 e2e files re-spelled (array half: the value;
  string half: `${JSON.stringify(SOURCES.x)}`, valid JSON5) — swept by a subagent while the src side
  landed; the two workers tests with kv-seeded sources (alarm-quiesce, ephemeral-offset-reuse) by hand.
- Docs: as-built §2/§5/§11/§12 (B → decided; §11 recounted: code lines 3,851, raw 6,208), walkthrough,
  onion design, synthesis §9 addendum (C and B together).
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 250 · e2e 140p/2xf (36 files).

## 2026-09-02 — `itx.workers.get(spec)`: the stateless twin of `facets.get`; `load` + `getEntrypoint` deleted

- Jonas: "would it make sense to have workers.get alongside facets.get as the stateless version and
  delete the load() verb and the whole getEntrypoint dance" → yes, and `load` goes with it. ONE door
  per host kind, each a `get` on a noun: `itx.workers.get({ source, className?, props? }).method(…)`
  (stateless — no name, because a stateless worker has no identity beyond its spec; naming one is a
  rewrite rule's job) and `itx.facets.get(name, { source, className })` (durable). `runScript` is
  sugar over `workers.get({ source }).run`.
- Deleted: the `load` root, the `getEntrypoint` pass-through step (a handle whose only legal next
  step was another handle), its "call .getEntrypoint(name?)" error branch. `callEntrypoint` is
  unchanged underneath.
- DIVERGENCE FROM CLOUDFLARE'S NAMING, on purpose (Kenton doctrine: justified here): the literal
  `worker.getEntrypoint()` / `worker.getDurableObjectClass()` two-step is folded into one door per
  host. What is mirrored instead is `ctx.facets.get(name, startup)` for the durable host and the
  Worker Loader's `get(id, …)` for the stateless one, with the spec as the id. Both still bottom out in
  `env.LOADER.get(cacheKey, …)` + `worker.getEntrypoint()` / `getDurableObjectClass()`.
- Sweep: 14 test files (`itx.load(X).getEntrypoint()` → `itx.workers.get({ source: X })`;
  `getEntrypoint('C', { props })` → `{ source, className: 'C', props }`; the array half `["load", M],
["getEntrypoint"]` → `"workers", ["get", { source: M }]`); docs (as-built §1/§5/§11/§12, LAYERS,
  walkthrough, onion design, loader/sdk comments). src 4 files +44/−46; tests 14 files +37/−35;
  code lines 3,851 → 3,846.
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 250 · e2e 140p/2xf (36 files).

## 2026-09-02 — `cacheKey`: a producer source behind Cloudflare's `get(id, getCode)`, as designed

- Jonas: "can the cache key be passed in? sometimes it is expensive to retrieve the source code (e.g.
  if it has to be built) so its nice to pass in a cache key. read and learn how cloudflare/os handles
  it … and recommend something", then "okay do it but first check what cloudflare/os does in case it
  changes your mind".
- CHECKED. Cloudflare (dynamic-workers/api-reference): `LOADER.get(id, getCode)` runs `getCode` only
  when no isolate is warm under `id`; it "could be called any number of times (although it is unusual
  for it to be called more than once)"; "if anything about the content changes, you must use a new ID";
  `load()` is the uncached twin. apps/os (domains/workers): a source is a DESCRIPTION (`{ createWorker:
{ files: inline | repo ref, …bundlerOptions } }`), never a caller-chosen key; the BUILD KEY is a
  sha256 over the resolved content identity (repo head `contentHash`) + build options + bundler and
  schema versions; the build ARTIFACT is cached in KV (30 d) behind one coordinator DO per key; the
  LOADER key is `worker-loader:<self>:<deploy>:<project>:<scope>:<streamContext>:<buildKey>:<runnerNonce>`
  and `LOADER.get` is called with the artifact already in hand. Neither changed the recommendation: the
  primitive to mirror is Cloudflare's, and apps/os's tiers belong to a build capability.
- **Built.** `WorkerSource = WorkerModules | ItxExpressionInput` (`WorkerModules = Record<string,
string>`, `cap.js` main). `workers.get({ source, cacheKey?, className?, props? })` and
  `facets.get(name, { source, cacheKey?, className })`. The loader key is `kind:deploy:owner:(cacheKey
?? contentHash)`; a producer expression is evaluated INSIDE `getCode` (through the context's own
  dispatch — `invoke` is back as a loader dep), so a warm key never re-runs it; a producer without a
  key is refused at the door (hashing the expression would be the stale-code trap). A facet's memo
  stores `{ source, cacheKey?, className }`; its version marker is the key's last component
  (`sourceVersion`), so a new key restarts the facet, storage surviving. The billing note stays.
- Reverses part of B on purpose: the producer is back, but only WITH the key that makes it safe.
- Tests: worker-loader.test.ts pins refused-without-key, produced-once-per-cold-key, re-produced on a
  new key, content-hash vs named key; workers-and-facets-sources.e2e proves it end to end with a LIVE code store
  (counts evaluations) for a stateless worker and a facet (`facets.get(name)` re-materializes from the
  memo, producer count still 1).
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 252 · e2e 141p/2xf (36 files).

## 2026-09-02/03 — the review round: eight reviewers, twelve red proofs, three performance no-brainers

- Jonas: "send a bunch of subagents to review narrative failures, bugs, illogical layering, unidiomatic
  stuff kenton varda wouldn't have done etc. for the bugs create failing tests without fixing. for
  everything else make a bouquet of recommendations… also trawl apps/os and this branch… for future
  features… flag which ones will be awkward" and then "also do a pass on 1) other code smells… and 2)
  PERFORMANCE… no brainers with big gains for v small refactors should just be done. the rest goes on the
  menu… all stream processor side effects must be tolerant of at least once delivery".
- Six independent reviewers wrote `docs/reviews/2026-09-02-{narrative-failures,bugs-do-side,
bugs-edge-side,layering,workerd-idioms,futures}.md`; the smells and performance passes ran as ONE
  workflow (six finders → three adversarial judges per finding → two writers): 48 findings, 21 do-now,
  27 menu, 0 rejected → `2026-09-02-{smells,performance}.md`. `2026-09-02-SYNTHESIS.md` ties them together.
- TWELVE BUGS, each with a red proof marked `test.fails` (`review-bugs-{do,edge}-side` in all three
  lanes), NOT fixed: the lend/un-set seam in iterate-context.ts (4), the cursor lane of delivery (3),
  a failed `getCode` poisoning its cacheKey (Cloudflare caches a failed load like a success), the
  removal effect deleting a facet another row hosts, a pager swap rejecting an in-flight page, the
  live-state client's gap heal, the rule tie-break on structurally equal pinned objects.
- PERFORMANCE DO-NOWS APPLIED (the only src changes of the round): (1) `LentRpcStub#walkItxExpressionSteps`
  no longer awaits mid-chain — every step is a pipelined capnweb path, so an n-step call on a client's
  stub is ONE client round trip; (2) the ~370 KB processor SDK is injected only into isolates whose
  modules import `./processor.js` (a stateless worker skips compiling it; a forgotten import fails loud,
  by name); (3) `LiveState.set` returns at once when handed the SAME object (identity ⇒ same JSON under
  the no-in-place-mutation contract), one unit row. The fourth do-now — a failed core-checkpoint write
  leaving phantom core state in memory — is a BUG, not a green-path win, so it joins the bug list
  unfixed. The rest is the menu.
- A twelve-strong Codex pass (gpt-5.6-sol, xhigh, read-only) was launched over the same questions and
  died at the OpenAI workspace's credit wall before finishing its reading; the prompts and a relaunch
  recipe are in `docs/reviews/codex/`.
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 253p/7xf · e2e 141p/7xf (38 files).
- POSTSCRIPT: the smells pass caught a regression of my own from the day — the hosted `/demo` page
  still seeded its processor source through kv and named it with a producer expression, which B
  (inline only) and F (a producer needs a cacheKey) had made a refusal; `pnpm spec` (Playwright) was not
  in the day's gates. Fixed by passing the modules literally (`source: { "cap.js": PRESENCE_SRC }`),
  demo page regenerated; Playwright 2/2. Lesson recorded: `pnpm spec` joins the gate list whenever
  `src/client/*` or the SDK surface moves.

## 2026-09-03 — the review's small renames and deletions applied; ten bugs fixed under ten lines each

- Jonas: "please do all the small renames and deletions and any docs fixup and also fix any bugs with
  obvious no brainer fixes with < 10 LOC".
- DELETIONS: `lib/logs.ts` (one consumer — the warn is inline now); the write-only `inFlight` counter on
  borrowed stubs; the SDK host's three unused protected members (the scope is `this.env.ITX.get()`,
  typed); the coined `WebSocketHooks` (both classes hold `#ctx: Pick<DurableObjectState, …>`);
  `walkSteps`'s caller-invented `where` (the walk names its own step: `"x" is not a method at step 3
of itx.kv.x()`); `InvokeHandle.invoke` takes the structured half only (a relative expression has no
  string spelling); the `itx.facets.delete` built-in (zero callers, and wrong — the row that hosts a
  facet outlives it); the lazily-born core `LiveState` (born in the `Stream` constructor; the false
  `rev: 0` fallback is gone).
- RENAMES: `nextOffset` → `throughOffset` (it is the batch's LAST offset), `after` → `afterOffset`;
  `#itxHost` / deps `host` → `itxEntrypoint` (it IS the `ItxEntrypoint` stub; `dialRpcStubFetch`'s
  `host` → `durableObject`); the DO's `#name` → `#durableObjectAddress` (what it holds); loader
  `kind: "code"` → `"worker"` (the door is `itx.workers.get`); built-in closures take their
  interface's parameter names (`prefix`, `afterOffset`, `contextPath`; `resolveContextPath(basePath,
contextPath)`); `StreamEventT` aliases dropped; egress `sub` → `substitutedRequest`; the four
  `60_000`s are `IDLE_QUIESCE_AFTER_MS` and `FACET_CALL_WATCHDOG_MS`. ONE `FacetSpec` (`{ source,
cacheKey?, className }`) spells the hosting spec everywhere, and `enableProcessor(name, spec)` now
  carries `cacheKey`. The two uncoded page exits are `RPC_STUB_OFFLINE`.
- BUGS FIXED (proofs flipped from `test.fails` to `test`): a two-step subscription target
  `itx.<alias>` is delivered to (guard `> 2`); a subscription re-configured mid-delivery re-evaluates
  its target (`call = undefined` on the replaced-row branch); a `subscribe` the DO refuses recalls
  the lend (the try/catch `provide` had); replacing a live target with an expression recalls the lend
  (both verbs); `subscribe`'s handle records `lentHere` instead of sniffing the target's spelling;
  an expression rule's undo un-sets ONLY the rule it wrote (reads the row first — a live provider's
  later rule survives a stale handle); a removal deletes a facet only when no remaining row hosts it;
  a pager swap parks the in-flight page and re-sends it down the NEW pager; the live-state client
  re-heals when a delta arrived during a heal; object args PRINT with sorted keys, so two spellings
  of one pinned object are ONE rule row (the proof and one codec pin re-pinned to the canonical
  spelling). Also, with no proof: the core reduce runs into a LOCAL and the fields move after the
  transaction commits — a failed checkpoint write can no longer leave phantom core state.
- LEFT RED, both over ten lines: the cursor-lane stranding after an eviction (rows vs cursors, and an
  alarm to arm) and a failed `getCode` poisoning its cacheKey (Cloudflare caches the failure).
- GATES: tsc×3 · oxlint 0/0 · knip clean · unit+workers 259p/1xf · e2e 145p/3xf (38 files) ·
  Playwright 2. Docs and test titles: a parallel agent, committed separately.
- CORRECTION on the lint gate: `packages/v3/project-worker` has no `lint` script, so every `pnpm -s lint`
  run from the package earlier in this record did NOTHING (its "0/0" claims were vacuous). The real
  gate is the repo root's `oxlint . --deny-warnings`, run here as `npx oxlint . --deny-warnings` from
  the package (116 files, 93 rules). Run today it found ONE warning and TWO errors, all from the review
  round (an import the FacetSpec edit orphaned; two single-use helpers in the red-proof files that the
  repo's own `iterate/no-single-use-helpers` rule refuses) — fixed. The gate line from here on says
  `oxlint 0/0 (npx oxlint . --deny-warnings)`.
- The docs agent's narrative sweep (40 of 42 findings; the two left were already true at HEAD): every
  live doc re-pointed, HISTORY banners on 19 superseded docs, seven e2e files renamed for what they
  prove (`facets-mid-chain-pipelining`, `facets-persistent-stub`, `workers-remote-capnweb`,
  `workers-and-facets-sources`, `processor-facet-reduces-and-address`, `itx-surface-tour`,
  `context-dotted-calls-fall-back-to-the-invoke-door`), test headers and titles fixed, and three src
  residues it handed on fixed here (a comment naming the old test file, a comment naming the deleted
  `facets.delete`, `ItxExpressionStep` exported).

## 2026-09-03 — the last two red proofs: a dead loader id recovers; a stranded cursor row is re-derived from the rows

- Jonas: "propose clean minimal fixes for the two remaining bugs — including refactors if useful",
  then "'arm' should always be 'armAlarm' wtf — but otherwise yeah do it". The first draft was run
  past four adversarial reviewers (a workflow, two lenses per bug) and refuted on three points, all
  verified against workerd's source before the redesign below.
- RENAME: `Stream.armNoLaterThan` → `armAlarmNoLaterThan` — a verb carries its object too.
- BUG 1 (a producer that throws poisons its loader cacheKey). Root cause verified in workerd
  server.c++: a named `loadIsolate` does `findOrCreate`, a failed `start()` (getCode threw, or the
  code failed to start) leaves the entry with a rejected startup, and only an abort ever removes it —
  every later `get(id)` replays the failure (still so on upstream main). The durable fix is upstream
  (drop the map entry on startup failure the way abort does; drafted separately). Our side, fenced as
  a WORKAROUND in worker-loader.ts: `loaderIdGenerations` — a producer that threw marks its id DEAD;
  the next attempt produces OUTSIDE the loader (a failure there reaches no map entry and mints
  nothing, however often it is tried) and, once the modules are in hand, loads them literally under
  the id's next GENERATION (`<id>#<n>`). One identity per dead→recovered transition, never per
  attempt; the happy path still produces inside `getCode`. The reviewers' blocker: the salt alone
  never recovered a FACET — `#invokeFacet` had already created the facet container bound to the dead
  class, and workerd hands back the SAME container on every `facets.get` (`findOrCreateEntry`), even
  for a class that never started; only an abort clears it. So the facet's restart marker is now the
  LOADED IDENTITY (`facet:<name>:loader-id`, the loader id the class came from) instead of the source
  version: a recovered generation, a source change, or a deploy all abort-and-restart the facet in
  place, storage surviving. `loadConfinedWorker` returns `{ worker, loaderId }`; `sourceVersion` is
  gone. Proofs: the e2e `workers.get` proof flipped; its facet twin added; a unit row with a fake
  loader that keeps a rejected `getCode` under the key (dead → produced outside → literal load under
  `#1`; a producer that keeps failing mints nothing).
- BUG 3 (a cursor subscription stranded by an eviction before its first ack). `deliverEveryCursorSubscription`
  is ROW-driven (the rows are the durable truth; a first cursor is memory-only until its first durable
  ack, so the cursor table cannot be), skipping rows the lane knows as push rows
  (`#pushSubscriptionNames`, classified once per incarnation). `#deliverFromCursor` evaluates FOR THE
  ROW IT IS READING — `EvaluatedSubscriptionTarget { call, forRowConfiguredAtOffset }`, a row's
  identity being its `configuredAtOffset` — lazily (only once there is a batch), inside the ladder;
  a push handle reached by the row pass is remembered and its birth cursor dropped. That also closes
  the cousin of bug 4 (a row replaced between commit and evaluation kept the OLD target's call for
  the whole loop). The lane ARMS THE ALARM ITSELF whenever a delivery is owed: in `onCommit` when a
  batch is queued for a row not known as a push row, and before every awaited call, for the call's
  own watchdog horizon (`CURSOR_DELIVERY_CALL_WATCHDOG_MS`, the inline 20 s named) — die mid-call and
  the alarm survives to re-derive from the rows. The DO's quiet-clock guard is untouched (bare probes
  arm nothing). The reviewers' blocker: evaluating at the loop head went through `invoke`, which
  notes ACTIVITY, so the quiesce would never have fired and every context with a row would have woken
  every minute forever — so the loop's `evaluateItxExpression` is wired to the resolver directly (the
  loop's own evaluation is not activity; a finished delivery is). Proof flipped; its `getAlarm()`
  line re-pinned to armed.
- Docs: the delivery header (the at-least-once argument), the DO alarm comment (its claim is true
  now), the walkthrough's marker name, the synthesis table (no red rows), two stale test comments
  (`ephemeral-offset-reuse`, `support.ts quiesce`).
- GATES: tsc×3 · oxlint 0/0 (npx oxlint . --deny-warnings) · knip clean · unit+workers 261p/0xf ·
  e2e 147p/2xf (38 files) · Playwright 2.
