# The kernel today + the two-worker split (2026-07-31)

This started as the two-worker-split assessment; expanded (per Jonas) into a full catch-up: what the
kernel is now, an architecture outline, a code breakdown, what was considered & discarded, and the split
itself. Read §1–§4 for the catch-up; §5 onward is the split.

---

## 1. Catch-up — what the kernel is, and what happened recently

**What it is.** `apps/kernel` is a **clean-room, pure-play** (no Node compat) reimplementation of the
iterate model — the "simplest possible version" — living on branch `wip/kernel-wayfinder-2026-07-30`
(NOT main), deployed to a throwaway prd account. Self-host is proven live on `*.shiterate.com`
(Cloudflare Access + email one-time-PIN, no auth.iterate.com), and a separate-account/custom-domain copy
runs in Jonas's personal account on `*.mispwoso.com`. Production `apps/os` is untouched throughout.

**The core idea.** ONE worker that: routes a hostname → a project, optionally verifies who you are at a
**wall**, and hands a **confined config worker** (userspace, run via Cloudflare Worker Loader) a single
capability — `env.ITX` — plus one **egress door**. Everything the project touches (streams, secrets, AI,
the outside world) goes through that door. Hosted vs. self-host is **config only** (`APP_CONFIG`).

**Recent sequence (all built + proven live, each committed):**

- **Routing table** — hostname→project via config + KV, before the `<slug>.<hostBase>` convention.
- **`/mcp`** — a control-plane MCP surface, sibling to `/api` (list/create/reach projects; proven via the
  official MCP Inspector CLI _and_ the Claude CLI).
- **R1 egress** — two-level door + `{{secret:…}}` substitution: the **project** door (its own secrets) →
  the **control-plane** door (first-party/"platform" secrets, origin-pinned + metered). This door is the
  concrete seam between a _generic_ control plane and the _iterate product_.
- **R2 streams** — a durable-log Durable Object (append/read).
- **R3 ai** — AI as a per-capability-sourced capability (local `env.AI` vs a metered remote). Key finding:
  _remote-sourcing a capability == egress through the control plane with a first-party key_ — so
  per-capability sourcing and first-party metered secrets are **one mechanism**.
- **R4 script exec + dynamic capabilities** — MCP `run_script`/`provide`/`invoke`, confined via the loader.
- **Thermonuclear reviews (3 adversarial agents)** → **fixed a critical live hole** (anonymous callers
  could run code in any project on non-`auth` deployments — now gated).
- **D-C** — grouped the product config under `AppConfig.product` (the iterate-product boundary is now a
  key, not a convention).
- **D-B** — adopted apps/os's **canonical stream contract** (`StreamEventInput`/`StreamEvent` from
  `iterate/processors`, type-only import): offset + idempotency + ephemeral. Delivery spine stubbed.
- **D-A** — **unified the two project surfaces** into one nested capability tree
  (`project.streams.get(path)` / `.secrets` / `.ai`) shared by the capnweb `Project` and the loopback
  `ProjectEntrypoint`.
- **Security follow-ups** — optional origin-pin for project secrets; gated `create_project`.
- **Two-worker split, step 1** — named the runner interface in-worker (this doc, §5+).

~48 tests green throughout; typecheck clean; nothing merged.

---

## 2. Architecture outline (current — one worker, two logical roles)

```
                    Cloudflare edge (one Worker: kernel-selfhost / kernel / kernel-personal)
  request ─────────────────────────────────────────────────────────────────────────────────┐
     │  default.fetch(request, env, ctx)                                                     │
     │   1. appConfigFrom(env)          — parse APP_CONFIG (the one knob)                     │
     │   2. /mcp        → handleMcp     ── CONTROL PLANE (MCP protocol adapter)               │
     │   3. ingress     → routingFor().lookup(host)  ?? resolveIngress(<slug>.<hostBase>)     │
     │   4. /api        → newWorkersRpcResponse(Os)  ── CONTROL PLANE (capnweb front desk)    │
     │   5. dashboard-- → serveDashboard (reverse-proxy to the vessel)                        │
     │   6. else        → dialRunner(ctx).serve(...)  ─────────────┐                          │
     └────────────────────────────────────────────────────────────┼──────────────────────────┘
   CONTROL-PLANE role                                              │  PROJECT-RUNNER role
   · wall.ts        verify injected JWT (or wide open)             ▼
   · directory.ts   which projects + membership (open/kv/auth)   ProjectRunner (WorkerEntrypoint)
   · routing.ts     hostname → project (config + KV)               · serve()     load+serve config worker
   · Os/Session/    the /api capnweb tree front desk               · runScript() exec, confined
     ProjectCollection (wall+directory gate)                       └── mints ProjectEntrypoint (loopback)
   · handleMcp      MCP tools over the directory + scripting             │
   · serveDashboard reverse-proxy the dashboard vessel                   ▼
                                                              ProjectEntrypoint (WorkerEntrypoint)
   the capnweb Project and ProjectEntrypoint BOTH expose ───────▶ · whoami · fetch (THE egress door)
   the SAME ProjectCapabilities tree (D-A):                       · streams / secrets / ai  (getters)
       project.streams.get(path).append()/.read()                       │  (→ capabilities.ts)
       project.secrets.set()                                            ▼
       project.ai.run()                                          config worker (userspace, confined):
                                                                  sees ONLY { env.ITX } + globalOutbound
   Durable Objects (runner-owned): STREAM_DO (the durable log)   = the ITX tree + the one egress door
   KV: DIRECTORY_KV · ROUTING_KV · SECRETS_KV (+ meter counters)
```

**The two logical roles** (one physical worker today; the split peels the CP off):

- **Control plane** — knows _many_ projects: ingress, wall, directory, routing, `/api` front, `/mcp`,
  the egress door's control-plane half, dashboard proxy. Holds no project data.
- **Project runner** — knows _one_ project at a time: `ProjectRunner` (serve + runScript), the
  `ProjectEntrypoint` (the ITX face + the egress door), the Durable Objects, and the capability tree.

**Deployment archetypes** (all the same worker, config-only): iterate-hosted (loopback) · project worker
in your CF account (capnweb) · project worker on your box (capnweb + tunnel) · self-host (you run the CP
too, loopback). See `topologies-and-axes.md`.

---

## 3. Code breakdown (apps/kernel, LOC; ~30–40% is explanatory comment)

| component                | file                     |        LOC | what it is                                                                                                                                               |
| ------------------------ | ------------------------ | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **kernel**               | `kernel.ts`              |    **695** | the router + capnweb tree (Os→Session→ProjectCollection→Project) + `ProjectEntrypoint` + `ProjectRunner` + `dialRunner` + `handleMcp` + `serveDashboard` |
| MCP                      | `mcp.ts`                 |        239 | Streamable-HTTP JSON-RPC adapter; tools (list/create/get + run/provide/invoke)                                                                           |
| directory                | `directory.ts`           |        213 | which projects exist + membership — open / local / kv / auth.iterate.com providers                                                                       |
| capability tree          | `capabilities.ts`        |        148 | the ONE `ProjectCapabilities` tree (streams/secrets/ai) shared by both doors (D-A)                                                                       |
| stream DO                | `stream-do.ts`           |        142 | durable-log Durable Object; canonical `StreamEventInput` contract (offset + idempotency)                                                                 |
| egress                   | `egress.ts`              |        140 | two-level egress door + secret substitution (project + platform, origin-pinned + metered)                                                                |
| config worker            | `config-worker.ts`       |        121 | the confined userspace payload (a JS string loaded by the Worker Loader)                                                                                 |
| dynamic                  | `dynamic.ts`             |        108 | script execution + dynamic-capability registry + the scripting security gate                                                                             |
| project-app-session      | `project-app-session.ts` |         98 | the narrow, 15-min, per-project on-behalf-of token                                                                                                       |
| routing                  | `routing.ts`             |         69 | hostname→project table (config + KV)                                                                                                                     |
| wall                     | `wall.ts`                |         47 | identity: verify an injected JWT, or wide-open                                                                                                           |
| **src total (non-test)** |                          | **~2,020** |                                                                                                                                                          |
| tests                    | `*.test.ts` × 6          |       ~670 | unit + a real-workerd e2e (`kernel.e2e.test.ts`, 221)                                                                                                    |
| dashboard vessel         | `mini-apps/os/**`        |       ~274 | the separately-deployed dashboard app (a TanStack Start remote app)                                                                                      |

**`kernel.ts` internal split** (the 695): config/auth helpers ~175 · ingress+hash ~45 · the capnweb tree
(Project/Collection/Session/Os) ~150 · `ProjectEntrypoint` ~50 · `ProjectRunner` ~57 · `dialRunner` ~8 ·
the fetch router ~48 · `handleMcp` ~78 · `serveDashboard` ~45. (Splitting `kernel.ts` into
`control-plane.ts` + `runner.ts` files is the natural next tidy-up — see §5 step 2.)

_Context:_ apps/os's equivalent surface is `rpc-targets.ts` alone at **7,667 LOC** (+ the domains it pulls
in). The whole clean-room kernel is ~2,000 — the simplification is real, not cosmetic.

---

## 4. Considered and discarded (the forks that shaped this)

- **One identical bundle + a `role` knob** (control-plane/runner/both) — _discarded._ Byte-identical only
  helps frequently-invoked workers; some workers are necessarily large (ESBuild-in-a-worker), and the
  Cloudflare-idiomatic shape is SOA. So it's _many small workers, identical per-worker_, not one bundle.
- **Import apps/os's `StreamDurableObject` / `StreamEventLog` engine** — _discarded._ The class is welded
  to `rpc-targets.ts` (7,667 LOC) and the engine drags `sqlfu` + the `iterate` workspace package into the
  dependency-free pure-play kernel. **Kept the contract, dropped the engine:** import the canonical
  `StreamEventInput`/`StreamEvent` _types_ (type-only, zero runtime) and implement ~140 lines of storage.
- **Split the RUNNER off into its own worker** — _discarded as impossible._ The confined config worker's
  `env.ITX` is a **loopback** (`ctx.exports`), which is **same-worker-only**. So the loader + entrypoint +
  config-worker-serving are necessarily ONE worker (the runner). Only the _control plane_ can peel off.
- **A big-bang two-worker split now** — _discarded (risk)._ Traded proven single-worker coherence for a
  half-tested cross-worker RPC surface at the end of an autonomous run. Did the **named-interface seam**
  (step 1) instead, which de-risks the real split to a one-line binding swap.
- **`/mcp` as a path reserved on project hostnames** (like `/api` today) — _discarded._ MCP is a
  **control-plane** surface (it creates projects, operates across them); it's a sibling to `/api`, and
  wants the control plane's own host (see the new ADR 0031 — a reserved host on the same base domain).
- **Fold secrets + capabilities + the meter into the stream DO** ("everything is the log", D-D) —
  _deferred, not discarded._ Powerful (the meter becomes "count of egress events", the racy KV meter
  vanishes) but a bigger bet; parked at Jonas's instruction.
- **Origin-pin ALL project secrets by default** — _discarded._ Breaks the common case (a project sending
  its own key to its own API). Made it **opt-in** (`allowedOrigins`); the auth gate already stops the
  cross-tenant attack.

---

## 5. The two-worker split

## ✅ STEP 1 DONE + PROVEN LIVE (2026-07-31) — the runner interface is named in-worker

Implemented `ProjectRunner extends WorkerEntrypoint<Env>` with `serve(request, projectId, app,
callerHeader)` + `runScript(projectId, code, args)` — the two operations coupled to `ctx.exports` +
`env.LOADER`. The control plane now reaches it through **`dialRunner(ctx)`** — the ONE chokepoint ("the
dial"): today `ctx.exports.ProjectRunner({})` (co-located loopback); in step 2 the ONLY line that changes
(→ `env.RUNNER` service binding, or a capnweb-dialed remote stub). No behavior change.

**The load-bearing experiment PASSED:** `this.ctx.exports.ProjectEntrypoint({props})` **works inside a
`WorkerEntrypoint`** — the runner mints its own per-project ITX loopback. (This was THE unknown; it's why
exec was kept at the kernel level overnight.) In step 2 the runner worker mints its OWN `ProjectEntrypoint`
export the same way, so the physical split is now a **binding swap at `dialRunner`**, not a rewrite.

Two calling-convention facts discovered: (1) `ctx.exports.<Entrypoint>(options)` requires an Options object
even with no props — pass `{}`. (2) Passing a `Request` and returning a `Response` across the loopback stub
works (workers-RPC / the capnweb fork pass Request/Response by value).

**Proven LIVE** on `kernel-selfhost` (`split1.shiterate.com`): public site + confinement
(`seenBindings:["ITX"]`), streams (offset 1), egress (X-Project + X-Platform), ai ("Blue") — all served
_through_ `ProjectRunner.serve`. runScript-via-runner covered by the wide-open e2e (scripting is auth-gated
on walled selfhost). 48 tests green, typecheck clean, prod untouched.

**Remaining runner interface method for step 2:** `capabilities(projectId) → ProjectCapabilities` (the
`/api` tree access) — today the capnweb `Project` builds `ProjectCapabilities` inline from `env` (no
`ctx.exports`/loader), so it's not the hard part; in step 2, when the runner owns the DO/KV/AI env,
`Project.#caps()` calls `runner.capabilities(projectId)` instead. Noted, not needed for step 1.

---

## Original assessment (below) — the plan step 1 just started executing

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
3. **Give `/api`+`/mcp` the CP's own hostname** (not project hosts) — closes the R8 hole at the edge, not
   just in code. Per **ADR 0031**, this is a **reserved host on the SAME base domain** (e.g.
   `iterate.yourdomain.com`) that ingress resolves _before_ the `<slug>` convention — so full self-host
   still burns only ONE hostname (`iterate.` = the console + `/api` + `/mcp`; `<slug>.` = projects).
4. **Cross-account:** the CP dials a _remote_ runner via capnweb (mutual credential + pinned session).
   This is the lattice payoff (ADR 0017 / the "your CF account" + "your box" archetypes).

## Recommendation

Leave the system as the coherent, fully-proven **one worker**. Do the split as step 1→2 in a dedicated
session with live parity proofs at each step. The groundwork (D-A's single serializable tree, the config
`product` boundary, the `dialProject`-shaped couplings all funneling through `ctx.exports`/`env.LOADER`)
is in place, so the split is now a localized change — exactly as intended.
