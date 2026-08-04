# Build log — clean-room inner core (project-worker, solo)

Chronological log of every increment: what was built, how it was proven, the platform facts learned, and the
commit. Design ref: `apps/os/docs/simplification/wayfinder/innermost-core/target-core.md`. Deploy target: the
POC account, `project-worker.iterate.workers.dev` (solo mode, no control plane).

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

---

## Status after increment 7 — the inner core end to end (solo)

A single `ItxDurableObject` is the host for a context: **ingress WS**, **egress** (project secret-sub → fallback
→ terminal), the **capability model** (`invokeCapability`/`provideCapability` + fallback), **execution**
(`load` a confined agent bound to its own host), **built-ins** (`itx.kv` project-prefixed + isolated,
`itx.secrets.set`), **live providers** (capnweb `/connect` → dispatch back to a device/browser/worker), and the
**ergonomic `itx.a.b()` surface**. All proven on `project-worker.iterate.workers.dev`.

**Next:** wake-on-call for live mounts (hibernation, spikes 3-4); the real
`DurableObjectNameCodec` + parent-path fallthrough (deep `/agents/x` contexts); then the control-plane join.
