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
