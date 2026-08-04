# Walking skeleton — a "proper" fetch (WebSocket upgrades and all) through the whole stack

Implements target-core §6.0 (D33): the FIRST thing to prove, because a 101 can't cross an RPC hop, so every
fetch hop must be a native `.fetch()`. Solo mode: one worker, no control plane; the fallback is this worker's
own `DummyControlPlane` loopback entrypoint.

**Status: PROVEN on the POC account (`project-worker.iterate.workers.dev`), 2026-08-04.** All four §6.0 risk
points green.

## What's here

- `src/itx-durable-object.ts` — `ItxDurableObject`. Native `fetch` does `ctx.acceptWebSocket()` + echo (ingress
  WS / the wake-socket attach point).
- `src/worker.ts` — the edge entry + `EgressEntrypoint` (project egress door: secret-sub → fallback) +
  `DummyControlPlane` (the solo fallback: terminal fetch + `invokeCapability` auth stub) + the router and a
  confined egress-WS agent.
- `src/core/egress.ts` — `substituteHeaderSecrets` (WS-safe header rewrite).
- `src/core/config.ts` — `AppConfig` / `FallbackRef` (solo default).

## The two paths proven

- **Ingress WS** — `GET /ws`: edge fetch → `ITX_HOST.getByName(ctx).fetch` (DO-stub) → `acceptWebSocket` → echo.
- **Egress WS** — `GET /egress-test`: a confined agent's outbound WS → `globalOutbound` → `EgressEntrypoint`
  (secret-sub) → `DummyControlPlane` → terminal `fetch()` → external echo, round-tripped.

## Reproduce

```bash
# ingress
node -e 'const w=new WebSocket("wss://project-worker.iterate.workers.dev/ws?ctx=prj_demo");w.onopen=()=>w.send("hi");w.onmessage=e=>{console.log(e.data);process.exit()}'
#   → echo:hi

# egress through the whole stack (secret substitution active)
curl -s https://project-worker.iterate.workers.dev/egress-test
#   → {"ok":true,"echo":"ping-through-egress"}

# the egress middleware really rewrites the header (not a pass-through)
curl -s https://project-worker.iterate.workers.dev/egress-debug
#   → {"substituted":true,"authorizationHeader":"Bearer sk-demo-REALVALUE-9x8y7z"}
```

## The four risk points (target-core §6.0) — all green

1. **Worker Loader `globalOutbound` carries a WS upgrade** — the confined agent's `fetch(url,{Upgrade})`
   returned 101 + `webSocket` through globalOutbound. ✅
2. **Loopback-entrypoint `.fetch()` preserves WS** — two hops (`EgressEntrypoint` → `DummyControlPlane`). ✅
3. **DO-stub `.fetch()` preserves WS** — ingress `acceptWebSocket` echo. ✅
4. **Egress secret-sub middleware substitutes into a WS-upgrade request without breaking the 101** — with a
   real secret bound, `/egress-debug` shows the header rewritten AND `/egress-test` still upgrades. ✅

## Findings (platform facts learned)

- `fetch()` for an outbound WS takes an **`https://`** URL + `Upgrade: websocket` (NOT a `ws://`/`wss://`
  scheme). workerd converts internally.
- A worker **cannot** WebSocket its own public hostname (loop protection) — the egress proof uses an external
  echo; ingress is proven with a client.
- A no-props `ctx.exports.X` loopback stub is **used directly as a Fetcher**; you only call it (`X({props})`)
  to pass props. Calling a no-props one as a function throws "parameter 1 is not of type 'Options'".
- Public echo servers vary: `ws.postman-echo.com/raw` and `echo.websocket.org` work; `echo.websocket.events`
  403s this path.

## NOT yet (next increments)

- The capability model: `invokeCapability`/`provideCapability` dispatch, the mount fold, the prototype hop.
- `run`/`load` living IN the DO (today the loader runs in the edge worker, as the pre-skeleton runner did).
- `streams`/`secrets`/`kv` built-ins; the `Itx` surface.
- The control-plane join (topology self-host/hosted) + cross-worker service-binding WS (risk #2 across accounts).
