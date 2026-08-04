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

**Commit** `<pending>`.

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
