# Two-worker split — assessment (2026-07-31)

Directive: "assess/implement the two-worker split if still warranted." **Assessment: warranted as the
next DELIBERATE step, but NOT as a safe autonomous big-bang right now.** Below is why, and the concrete
plan to execute it deliberately. Grounded in the current `kernel.ts` after D-C/D-B/D-A + security.

## What the split is (ADR 0017)

Peel the **control plane** (ingress · wall · directory · routing · `/api` front · `/mcp` · dashboard
proxy · webhook ingress) off from the **project runner** (the `ProjectWorkerEntrypoint` + `env.LOADER`

- the DOs + serving the confined config worker + the `ProjectCapabilities` tree).

## The hard constraint that shapes everything (verified in code)

The confined config worker is loaded with `env.ITX` + `globalOutbound` bound to a **loopback**
`ProjectEntrypoint` minted via `ctx.exports.ProjectEntrypoint({props})` (`kernel.ts:490-502`). **Loopback
bindings are same-worker only.** Therefore the loader + the `ProjectEntrypoint` + serving the config
worker **must stay in ONE worker** — that worker IS the runner. The CP cannot load a config worker whose
`env.ITX` loopbacks into a _different_ worker.

So the split is asymmetric: the **runner is necessarily one worker**; the **control plane peels off** and
reaches the runner over a binding.

## What binds CP→runner today (the three in-worker couplings, all via `ctx.exports`/`env.LOADER`)

1. **Serving the config worker** — `makeEntry(ctx.exports) → env.LOADER.get(...) → fetch` (`:488-513`).
2. **The `/api` capnweb tree** — `new Os(...)` → `ProjectCapabilities` reads `env.STREAM_DO`/`SECRETS_KV`/
   `AI` directly, in-worker (`capabilities.ts`).
3. **`/mcp` scripting** — `ctx.exports.ProjectEntrypoint` + `env.LOADER` for `run_script`/exec (`:557-564`).

## What the split therefore REQUIRES (the real work)

The runner must expose a **`ProjectWorkerEntrypoint`** (WorkerEntrypoint) the CP calls over a service
binding (same account) or capnweb (cross-account):

- `serve(projectId, app, request, publishedCaller) → Response` — loads + serves the confined config worker.
- `authenticate(props) → <the ProjectCapabilities tree>` — for `/api` and `/mcp` scripting, returned as an
  RPC stub (the tree is already `RpcTarget`s — this is why D-A mattered: one tree, serializable over RPC).
- `runScript(projectId, code, args) → result` — exec stays runner-side (needs the loader).
  The CP's fetch handler then: resolve ingress + wall + routing (CP-local) → for project-scoped work, call
  `env.RUNNER.serve(...)` / `.authenticate(...)`. This is a genuine new cross-worker RPC surface with new
  failure modes (tree-stub lifetime across the binding, serve streaming, error propagation).

## Why NOT an autonomous big-bang now

- **Primary motivation already handled:** the security reason to wall `/mcp` at a separate host is closed
  in code (the `writeAllowed`/`scriptingAllowed` gate — walled+anonymous refused, proven live).
- **The real payoff is cross-account** (the CP dials a _remote_ runner via capnweb — mutual credential,
  pinned session), which is a large multi-step effort well beyond one safe increment.
- **Risk vs. state:** the single worker is coherent and fully proven live (routing, egress, streams, ai,
  mcp, scripting, the unified tree). A big-bang CP↔runner RPC restructure at the end of an autonomous run
  would trade proven coherence for a half-tested new interface. Partial-split-left-half-done would also
  violate the "no speculative indirection / conventions over frameworks" preferences.
- **D-A made the split CHEAPER, not urgent:** the capability tree is now ONE serializable `RpcTarget`
  surface, so `authenticate() → tree` over the binding is a clean handoff when we do split. We bought the
  option; we don't have to exercise it now.

## The deliberate plan (when Jonas is ready — sequenced, each provable)

1. **Name the runner interface** in-worker first: a `ProjectWorkerEntrypoint` (WorkerEntrypoint) with
   `serve()` + `authenticate()` + `runScript()`, still co-located, CP calls it via `ctx.exports` (no
   behavior change — pure seam). Prove parity live. _(This is the one genuinely-safe first step; ~1 focused
   session. I did NOT do it now to avoid leaving a half-seam, but it's the clean starting point.)_
2. **Split the worker:** move `ProjectWorkerEntrypoint` + `env.LOADER` + DOs into `apps/kernel-runner`;
   the CP `env.RUNNER` service-binds it (same account). Ingress/wall/routing/mcp-read stay in the CP.
   Prove: iterate-hosted + self-host still serve, `/api`+`/mcp` work through the binding.
3. **Give `/api`+`/mcp` the CP's own headless hostname** (not project hosts) — closes the R8 hole at the
   edge, not just in code.
4. **Cross-account:** the CP dials a _remote_ runner via capnweb (mutual credential + pinned session).
   This is the lattice payoff (ADR 0017 / the "your CF account" + "your box" archetypes).

## Recommendation

Leave the system as the coherent, fully-proven **one worker**. Do the split as step 1→2 in a dedicated
session with live parity proofs at each step. The groundwork (D-A's single serializable tree, the config
`product` boundary, the `dialProject`-shaped couplings all funneling through `ctx.exports`/`env.LOADER`)
is in place, so the split is now a localized change — exactly as intended.
