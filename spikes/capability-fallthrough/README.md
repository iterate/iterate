# Spike 2 — the fallthrough design in real workerd (2026-08-03)

**Side-quest 2** from `apps/os/docs/simplification/wayfinder/jam-capability-provision.md`. Starts as a copy of
`spikes/capnweb-pipelining/` (spike 1) and goes deep on the "look around the corner" model.

## The idea being tested (Jonas's framing)

- The control plane runs the **same kind of code** as a project — it's just a capability host.
- The control plane **provides capabilities to the project** (e.g. `egress`/`fetch`).
- **iterate** is a **mounted capability** on the control plane (self-host = don't mount it).
- Some capabilities are **live** (a stub whose calls travel to the provider — e.g. a Pi that dialed out),
  some are **static** (a value).
- Capability hosts have a **parent** they **fall through to**.

All of that is **one class** (`capability-host.mjs`, ~90 lines) plus a tiny graph (`graph.mjs`). The same code
runs in Node and in workerd (imported, not forked).

```
  iterate            provides: flavor (live), brandName (static)
     ▲ mounted-on
control-plane        provides: iterate (mounted), egress/fetch (live) — DOWN to projects
     ▲ parent-of
  project            has no raw fetch; falls through to control-plane for egress, iterate, …
```

## What's proven (all green)

**`node demo-node.mjs`** — the design in-process AND with the project's **parent as a remote capnweb stub**
(cross-isolate fallthrough): fallthrough, mounted iterate, egress-as-provided-capability, live+static, and
**shadowing** (a project's own `egress` wins over the parent's).

**`node build.mjs && node run-workerd.mjs`** — REAL workerd via Miniflare, three transports:

| #   | transport                                                                            | result                                                  |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 1   | Node client → workerd capnweb server (`/api`, real WebSocket)                        | ✅ 1+1 pipelined; egress does a real workerd subrequest |
| 2   | **gateway isolate → DO isolate, NATIVE Workers RPC** (`/test/native`)                | ✅ **closes spike 1's gap**                             |
| 3   | workerd client → workerd capnweb server (`/test/capnweb`, WS over a service binding) | ✅                                                      |

**`node run-deployed.mjs`** — the **same three transports against DEPLOYED workers** on the POC account
(`04b3b57291ef2626c6a8daa9d47065a7`), over the public internet: **all ✅**.

- `https://capnweb-spike-gateway.iterate.workers.dev` (DO `HOST_DO`, service bindings `SELF` + `PEER`)
- `https://capnweb-spike-peer.iterate.workers.dev`

Deploy: `wrangler deploy -c wrangler.peer.jsonc` then `wrangler deploy -c wrangler.gateway.jsonc`.

## The headline result — spike 1's caveat is now closed

Spike 1 proved the fallthrough pipelines over **capnweb** but couldn't reach a **native Workers-RPC** boundary
(the `workerd#6873` brand check). Test 2 here crosses exactly that boundary — a gateway isolate calls a DO
that returns the project host over native RPC, and pipelines `proj.iterate.flavor.flavorPrompt()` /
`proj.egress.fetch()` through it. **It works, in deployed workerd**, because the design follows the safe rule:

> **The host is a real `RpcTarget` instance; the resolver `Proxy` lives on its _prototype_.**

So `instanceof RpcTarget` holds (native RPC passes it by reference, not by value), and unknown-member
resolution happens _in-isolate_ during expression evaluation — no bare `Proxy` ever crosses a native wire.
`capability-host.mjs` implements this with `Object.setPrototypeOf(Host.prototype, trapProxy)` where the trap's
own target inherits `RpcTarget.prototype` (keeping it in the chain).

## Non-obvious things this surfaced (worth keeping)

- **Keep `RpcTarget.prototype` in the chain.** A first cut replaced it with the trap Proxy → `instanceof`
  broke → capnweb tried to serialize the host by value ("RPC stub points at a non-serializable type").
- **Reserved-name guard on the trap.** `then`/`dup`/`constructor`/… must NOT resolve as capabilities (promise
  & stub machinery probe them). Same guard `installPrototypeInvokeCapabilityFallback` uses in `apps/os`.
- **`.dup()` only real stubs.** Duck-typed on `typeof cap.dup === "function"` — safe because `dup` is
  reserved in the trap, so local hosts report no `dup` and aren't dup'd; capnweb AND native stubs are.
- **`newWebSocketRpcSession(url)` returns the remote-main stub directly** — not a session. (`.getRemoteMain()`
  was being resolved as a _capability named getRemoteMain_ and falling through to a throw.)

## Files

- `capability-host.mjs` — the uniform host (parent fallthrough, live/static, prototype-proxy resolver).
- `graph.mjs` — iterate ← control-plane ← project; `runDemo`/`checkDemo` (shared by every harness).
- `gateway.mjs` / `peer.mjs` — the workerd workers.
- `build.mjs` — esbuild bundles for Miniflare (`cloudflare:workers` external).
- `run-workerd.mjs` / `run-deployed.mjs` / `demo-node.mjs` — the three harnesses.
- `wrangler.{gateway,peer}.jsonc` — deploy configs (POC account).
- `redteam-*.md` — adversarial failure analyses (volume, duration, reconnect, resources, security, blast
  radius) — how this model might break at scale, before committing.
- (inherited from spike 1) `spike.mjs`, `inproc.mjs` — the instrumented in-memory transport + pipelining proof.
