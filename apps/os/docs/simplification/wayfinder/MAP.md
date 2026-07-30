# Wayfinder map — kernel self-hosting & the permutation lab

The single index for this design effort. Not a repository — a **map**: the destination, the
open frontier, the decisions settled so far, and the fog we can't ticket yet. Adapted from
Matt Pocock's wayfinder to a doc-folder (no tracker, per Jonas).

## How to navigate this folder

- **[CONTEXT.md](./CONTEXT.md)** — the glossary / agreed taxonomy. Read first for vocabulary.
- **[DECISIONS.md](./DECISIONS.md)** — the ADR log (0001…0019). Settled decisions + why.
- **[topologies-and-axes.md](./topologies-and-axes.md)** — the four deployment archetypes × axes. **The
  current center of gravity** — what the runner is, the reach binary, what the control plane is for.
- **[build-plan.md](./build-plan.md)** — the two-phase lab plan (streams-first, then the capability tree).
- **[reuse-feasibility.md](./reuse-feasibility.md)** — what apps/os code the kernel can import unmodified.
- **[questions/](./questions/)** — the frontier: R0 resolved; remaining opens + parked.
- **[proposals/](./proposals/)** — the 8 independent architect proposals + their digests below.

---

## The destination

**A clean-room experimentation harness (in `apps/kernel`) where each rung of the independence
lattice is a _minimal, runnable, provable_ profile** — the smallest elegant version of: wide-open
Pi · hosted same-account split · BYO-account cross-account · home-assistant NAT dial-out · (stretch)
account-per-project. We change and harness the clean room until we can spin up each permutation and
watch it actually work. Productionizing `apps/os` onto this shape is a **separate downstream track**.

Three things this effort must produce (Jonas's framing):

1. **Clean architecture** — the worker topology + interface that makes all rungs the same system.
2. **Agreed taxonomy** — a small, blessed vocabulary; reject invented framework nouns.
3. **A clear list of unknowns / work ahead** — the frontier + the parked questions.

---

## The frontier (open — being grilled now)

Round-numbered by dependency (batch-grill: ask a whole round at once; a question that depends on an
open one waits for the next round).

| #                                                         | Question                                                                                      | Round   | Status                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| [01](./questions/01-scope-and-destination.md)             | Clean-room lab, os-migration deferred?                                                        | 1       | ✅ **resolved → ADR 0015** (lab, skeletal-but-realistic)                                                                |
| [02](./questions/02-bundle-topology.md)                   | One bundle, or many workers?                                                                  | 1       | ✅ **resolved → ADR 0016** (SOA; identical _per-worker_; reject one-bundle)                                             |
| [R0](./questions/R0-what-is-the-runner.md)                | **What IS the runner?** → `ProjectWorkerEntrypoint`; two workers; reach binary; egress via CP | 1½      | ✅ **resolved → ADR 0017 + [topologies-and-axes.md](./topologies-and-axes.md)**                                         |
| [03](./questions/03-capability-source-shape.md)           | Capability sourcing (config- vs event-shadowing)                                              | —       | 🅿️ **deferred** (bindings follow the project worker for now)                                                            |
| [04](./questions/04-cross-account-dial-and-serve.md)      | Dial + serve lane                                                                             | —       | ✅ folded into R0: reach = loopback OR capnweb/HTTP, no dial-out                                                        |
| [05](./questions/05-taxonomy-ratification.md)             | Taxonomy — reframed as inside-out _agreed / in-flux / open_ layering, not ratification        | ongoing | 🟡 deferred; build up inside-out                                                                                        |
| [email](./questions/email-inbound-outbound.md)            | Email (in/out) as a network-edge capability + its self-host domain problem                    | —       | 🟢 researched → **rides the ADR 0020 base domain** (no extra burn); shared-mail-base escape hatch. Awaiting your ratify |
| [integrations](./questions/control-plane-integrations.md) | Slack/metered-secret integrations; **capability presence is environment-determined**          | —       | 🟢 researched → principle **ADR 0021**; metering-gap + presence-primitive flagged                                       |
| [mcp](./questions/mcp-everywhere.md)                      | MCP works in every self-host topology (Access-fronted + no-auth `/mcp`)                       | —       | 🟢 researched → **ADR 0022**; kernel has none yet; wall model _simplifies_ MCP auth                                     |
| dev-modes                                                 | Two meanings of `pnpm dev` (project-worker-only vs full-stack own-CP)                         | —       | 🟡 **ADR 0023** — disambiguate (CLI shape TBD)                                                                          |
| [06](./questions/06-account-per-project.md)               | Account-per-project: first-class rung or parked experiment?                                   | 3       | ⬜ blocked on R0,02                                                                                                     |
| [07](./questions/07-permutation-matrix.md)                | Which permutations do we build minimally, in what order?                                      | 3       | ⬜ blocked on R0,06                                                                                                     |
| [08](./questions/08-harness-mechanics.md)                 | How is the lab wired — config profiles + per-rung e2e smokes?                                 | 3       | ⬜ blocked on R0                                                                                                        |

**Recalibration (2026-07-30, after grill round 1):** Jonas confirmed Q01, rejected Q02's one-bundle
model (→ SOA, per-worker identity), and pulled the brake on Q03–Q05: they bottom out in an undefined
concept — **what the runner is** — and taxonomy is premature. New root **R0**; go inside-out. I over-
indexed on byte-identical; corrected in ADR 0016.

---

## Decisions so far (index)

The full text + rationale is in [DECISIONS.md](./DECISIONS.md). Settled:

0001 two workers (roles) · 0002 no wall on runner · 0003 wall-or-nothing identity · 0004 directory =
registry+membership, kv/auth/open · 0005 routing table is control-plane-owned · 0006 transit-yes/at-rest-no
(L2) · 0007 always a billing relationship when we host CP · 0008 BYO = customer's CF API key · 0009
cross-account = pinned bidirectional capnweb · 0010 provisioning = ensure-resources script · 0011
self-hosters own upgrades · 0012 data-migration parked · 0013 home-assistant mode supported · 0014
build on the existing `/api` door + two credential lanes.

---

## Fog of war (suspected decisions, not yet crisp enough to ticket)

- **The serve/streaming hot path.** Everyone agrees HTTP-serving can't ride RPC method-replay; #2156
  removed the old mount. Whether a `FetchTarget`-style streaming adapter is one decision or several
  (backpressure, WS 101 upgrade, cancellation) is still fog. → partly folded into Q04.
- **Lease / fencing semantics** for the held cross-account session (epochs, `runner_offline`,
  `Retry-After`). codex specifies it in depth; opus hand-waves. Ticket once Q04 lands.
- **Webhook ingress at L2: lossy synchronous relay vs short-TTL buffer.** codex-topology forbids even
  a buffer (fail-closed); plan R7 + opus keep short-TTL. A real product decision. → round 3.
- **Bilateral sourcing consent** (codex's manifest-generation authorization in BYO). Premature? →
  depends on Q03.
- **What the durable log (M4) actually is** — the "log is the computer" reshaping (5 of 8 proposals
  gesture at it) vs. streams-as-one-capability-among-many. The deepest fork; deliberately downstream.
- **The control plane reacts to the project ROOT STREAM** _(preserve for the future — Jonas)_. The
  clean interface for "a lot of good stuff": the control plane can **react to events on a project's root
  stream**. Maybe the root stream carries a subscription pointing at the control plane; maybe a
  subscription _event_; maybe it's just built in. Not now, but architect so this reactive
  control-plane↔root-stream relationship is natural. (Rhymes with the durable-log fork above and with
  "capabilities via birth events" in build-plan step 7.)

---

## Parked (settled as "not now") — see [questions/parked.md](./questions/parked.md)

Data-migration mechanics (OQ-e/D10) · multi-user self-host (OQ-b) · versioning/upgrades of the
identical bundle (OQ-d) · fully-offline no-account mode (OQ-g).

---

## Cross-proposal synthesis (from the 4 digesters, 2026-07-30)

**The common spine — all 8 agree:**

- Two roles: control plane (many projects; wall, directory, ingress, routing; holds no data) +
  project runner (one project; **is** the ITX tree; no wall). Faithful to plan Part 0 / D6 / D7.
- **One interface, transports differ.** `authenticate() → session → projects.get(id) → <capability>`,
  reached via Workers RPC same-account, persistent bidirectional capnweb cross-account. "Cross-account
  is the same path, different transport."
- **capnweb `RpcTarget` _is_ `cloudflare:workers`' `RpcTarget`** — local and remote stubs interoperate,
  which is _why_ sourcing is invisible to callers. The single most load-bearing fact.
- Per-capability sourcing (R5) requires breaking up the 7,667-LOC `rpc-targets.ts` god object; the
  cut line already exists at `itxForScope()` (`rpc-targets.ts:5989`, 3 call sites).
- Runner **dials out** for NAT/home-assistant; the control plane holds the session in a DO and routes
  inbound down it. `ProjectDial` (tasks/checkout-do.ts) is the proven redial pattern.
- Reuse the born `project-secret` + `project-app-session` credential lanes; don't resurrect
  `remoteCapability` without re-reading #2156.
- The HTTP-serving path needs a fetch-native lane — WS 101 upgrades can't cross RPC method replay.

**The genuine forks (→ the frontier):**

- **Bundle count:** one artifact + `role` knob (fable-minimalism, opus) vs two distinct workers with a
  CI import-wall (fable-migration, codex). → Q02.
- **Migration direction:** extract a runner _from_ os, vs carve the _control plane_ out and let os
  _become_ the runner (fable-migration, forced by DO data gravity). → Q01/Q02.
- **Capability-source shape:** codex's 4-field versioned manifest + bilateral consent vs opus's minimal
  `{kind:local|remote, stub}` union vs fable-migration's storage-shaped(never-sourced)/service-shaped
  dichotomy. → Q03.
- **Dial direction:** runner _always_ dials out uniformly (codex) vs control-plane dials the runner
  (opus). → Q04.
- **R1 scope + justification:** byte-identical across all deployments incl. CP (minimalism/opus) vs
  runner-bundle-only (migration); and fable-migration disputes the "free cold starts" premise as
  unsupported by CF docs (PR #2115 proved warm-pinging a placebo). → folded into Q02.

**The 4 radical-reshaping archetypes (recur across authors):**

1. **The log is the computer** — the Stream DO _is_ the project; serving = fold; capabilities are
   processors; cross-account = log replication. (codex-C, opus-R1/R2, min-6.2, mig gestures.)
2. **Account-per-project / Workers-for-Platforms** — every project a WfP tenant / its own account;
   isolation = Cloudflare's account boundary; L2 machinery becomes the _only_ machinery. (codex-topo-1/2,
   opus-cap-R3, opus-topo-A, min-6.3, mig-R1/R3.)
3. **Signed-capability peer mesh** — no control plane; deployments are peers; Git/DNS directory +
   rendezvous; project = a signed capability graph. (codex-cap-B, codex-topo-3, min-6.1.)
4. **capnweb-only single transport** — delete the same-account RPC fast path; everything dials capnweb,
   paying the loopback tax for one code path. (opus-lattice-R1, opus-topo-C.)

**Load-bearing facts (cited across digests) — the physics the lab must respect:**

- Workers RPC / service bindings are **same-account only** (name-resolved, no account field; ≤32-chain);
  stubs die with their execution context → forces capnweb-over-WS-held-by-a-DO for any remote link.
- **Outbound WebSockets can't hibernate** (~15-min DO keep-alive); inbound hibernatable sockets are
  free → the dial-_in_ tunnel topology has a real cost the always-dial-out model pays.
- **`ctx.props` is authentic; `ctx.exports` mints loopback bindings with props** — the sealed
  one-project confinement primitive. Loader isolates capture parent loopback stubs → cache key must
  include parent script + deploy version.
- **Worker Loaders are open beta** (2026-03-24); `globalOutbound` has 3 states (inherit/null/gate).
- **KV eventual consistency ≥60s incl. negative lookups** → routing projection, never the registry of
  truth. (codex wants a Registry DO; opus/plan keep KV — a live fork inside Q04's neighborhood.)
- **AI Gateway BYOK is not supported for 3p models via `env.AI`** → metered L2 `ai` must be _our_
  proxying worker, never a handed-out token; byok transport pinned for ~6× cached-token economics.
- **Cloudflare-for-SaaS wildcard custom hostnames are Enterprise-only** ($0.10/hostname past 100).
- **DO namespaces bind to the declaring script** — the 11-worker cutover (#1500) orphaned every DO;
  DO-namespace _transfer_ now exists, softening but not removing data gravity. **This is the spine of
  fable-migration's "os becomes the runner" argument.**

**Two corrections to the plan the digesters surfaced:**

- R1's "identical bundle → free cold starts" justification is **unsupported** by Cloudflare docs
  (no content-addressed cross-account warm cache; isolate warmth is per-script-version, evictable).
  Keep R1 for config-not-fork + one test matrix; **drop the cold-start rationale.**
- Plan Part G marks `getUserGrants` / `getUserGrantsByEmail` ✅, but fable-migration (reading this
  **archive branch**) reports auth's contract has 7 methods, none email-keyed. Those RPCs were merged
  to `main` (#2346/#2365) — this is a **stale-branch artifact**, to verify, not a real gap.
