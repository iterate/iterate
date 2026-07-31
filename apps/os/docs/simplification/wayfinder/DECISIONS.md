# Decisions log (ADRs)

Resolved decisions, most durable first. Each is here because it's **hard to reverse**,
**surprising without context**, and **the result of a real trade-off**. Ported from
`self-hosting-plan.md` Part E (D1–D13) and extended as the grill resolves new ones.
Numbered sequentially; a decision that gets overturned is marked `superseded by NNNN`,
not deleted.

---

## 0031 — Self-host burns ONE hostname: a reserved control-plane host overrides slug interpretation

Full self-host should need only **one** domain, not two. The ingress adds a **reserved control-plane
host** (config: e.g. `controlPlaneHost: "iterate.yourdomain.com"`, or a reserved label like `iterate`/`os`
under `hostBase`). Ingress resolves it **first**: if the request host matches the control-plane host, serve
the **control plane** (the console UI + `/api` + `/mcp`) — and do **not** interpret that host as a
`<slug>` project. Every other host falls through to the existing routing table + `<slug>.<hostBase>`
convention (ADR 0020/0025). So one domain does everything:

- `iterate.yourdomain.com` → the control-plane console (create/list projects, `/api`, `/mcp`)
- `<slug>.yourdomain.com` → each project's public site
- `dashboard--<slug>.yourdomain.com` → each project's kernel-reserved dashboard
  One base domain + one wildcard cert; no second domain to burn. This is the concrete answer to the
  two-worker split's "`/api`+`/mcp` want the CP's own hostname" (step 3) — that host is just a reserved
  label on the same base, not a separate domain. _(Jonas.)_

## 0024 — Naming: "kernel project entrypoint" vs "userspace project entrypoint"; retire "runner"

Two entrypoints need distinct names. The trusted, kernel-owned `ProjectWorkerEntrypoint` that mints the
ITX tree = **kernel project entrypoint** (inner). The config-repo's exported default worker (the user's
code, loaded + confined, sees only `env.ITX`) = **userspace project entrypoint** (outer). **"Runner" is
retired** — Jonas: _"'runner' isn't it."_ _(Broader kernel-space/user-space/control-plane/kernel/platform
vocabulary is being agreed separately.)_

## 0025 — The ingress routing table is KV (config + KV are the two inputs)

The `hostname → {projectId, app}` table (ADR 0020) is **KV**, not D1 — "that's what it's made for." The
control plane's two inputs are **config** (`APP_CONFIG`) and **KV**. _(Jonas.)_

## 0026 — Build step-by-step; prove everything possible WITHOUT streams first; streams come late

Retire the "Phase 1/2" framing (0019). Order: routing table (KV) → the deployment permutations → **MCP**
→ ingress/egress HTTP paths → **secret substitution at both the project and control-plane level** →
first-party Slack + Exa/Parallel integrations → **how a project gets its control-plane capabilities**
(via **config + props**, possibly birth events — TBD). **Do not touch streams until MCP is proven**; a
lot proves out without the heavy streams machinery. _(Jonas — supersedes ADR 0019's ordering.)_

## 0027 — BYO-account-per-project is a create-time option, prototyped from the start

Un-parks "Cell". iterate-hosted **plus** bring-your-own-Cloudflare-account: at **project create** you can
say "this project lives in _my_ Cloudflare account (I want to store the data there)" — a different kind of
project that lives elsewhere. Prototype this early. _(Jonas: "this should be prototyped from the
beginning… it can't be that hard.")_

## 0028 — Correction: `env.AI` / `env.ARTIFACTS` require a Cloudflare account (no purely-local mode)

These bindings do **not** work on your box alone — even `pnpm dev` in Miniflare uses them **from a
Cloudflare account** (via the `wrangler login` account). So the "your box" archetype's AI/artifacts always
resolve to a Cloudflare account, never local. _(Jonas — corrects the earlier topologies table.)_

## 0029 — Requirement: MCP "emerge with a project" — never return a project-less MCP session

A user can start their iterate journey by connecting an MCP server. The control-plane MCP flow must **not
return control to the MCP client until a project has been created** — connecting with no project creates
one first. A hard requirement to never forget. _(Jonas.)_

## 0030 — (lean, to confirm) The control plane is generic; the iterate _product_ is a layer on top

The control plane is a **generic project-fleet manager** (many projects · ingress · egress · routing ·
the wall). The **iterate hosted product** — first-party integrations (Slack, Exa/Parallel), billing, the
daily 3p-cost-download job — is a **separate layer** built on top, isolated by module/API boundaries and
config. Self-host runs the generic control plane with the product layer **turned off by config**. _(Jonas
— strong lean; confirm before locking.)_

## 0001 — Two workers: control plane + project runner

The platform splits into a **control plane** (knows many projects: ingress, routing table,
wall, directory) and a **project runner** (knows one project: it **is** the ITX capability
tree). The runner is reached via Workers RPC (same account) or bidirectional capnweb
(cross-account). _(plan D6)_

## 0002 — No wall on the project runner

Identity crosses into the runner via the `/api`/ITX path (props / `authenticate`), never a
wall in front of it. The wall is a control-plane concern. This is what lets the same runner
sit behind our Access org, your Access org, or nothing at all. _(plan D7)_

## 0003 — Identity is "wall or nothing"

The only identity mechanism is verifying a JWT an ingress wall injected (`WallConfig`).
Cloudflare Access and auth.iterate.com are the same shape. No wall = wide open, everyone
anonymous, single-tenant. OIDC/session machinery was deleted from the kernel. _(clean-room)_

## 0004 — Directory = registry (+ ingress routing) + membership; two real modes

`open` (zero-config default), `kv` (single-tenant), `auth` (auth.iterate.com, multi-tenant);
`local` deleted. The registry half **is** the ingress hostname→project lookup table. _(plan R13)_

## 0005 — Ingress routing table is control-plane-owned

The hostname→project routing table lives in the control plane (ours when we host) regardless
of where compute/data live. Routing is a control-plane concern, decoupled from storage. _(plan D8)_

## 0006 — Transit-yes / at-rest-no is the level-2 contract

Iterate seeing HTTP _transit_ in level 2 while storing nothing is acceptable. Iterate is the
HTTP edge in and out (incl. webhook ingress, short-TTL only), never the store. _(plan D1, R7)_

## 0007 — If we host the control plane, there is always a billing relationship

The customer pays for their own-account storage/bindings; anything used from our account is
**metered**. This is what makes volume-discounted first-party capabilities (R9) coherent. _(plan D5)_

## 0008 — BYO-account auth, for now: the customer gives us a Cloudflare API key

No fancier scoping yet. A provisioning script uses the key to create resources in their
account. _(plan D3)_

## 0009 — Cross-account chattiness → a persistent bidirectional capnweb session

Workers RPC can't cross account boundaries; capnweb re-implements it over a WebSocket. For
chatty cross-account work we hold one pinned bidirectional session, not HTTP-batch-per-call
(HTTP-batch is lint-forbidden in source). _(plan D4, R11)_

## 0010 — Cross-account provisioning is an Alchemy-v2 / preview-env-style script

Assume a script creates the resources (KV, DO, R2, routes, DNS) in the customer account
idempotently and returns the identifiers we deploy with. _(plan D11)_

## 0011 — Self-hosters own their own upgrades

`git pull` + `pnpm deploy`. Not our concern to auto-update. _(plan D9)_

## 0012 — Data-migration mechanics are out of scope for now

The lattice _permits_ moving data between accounts (R12); the copy/cutover mechanics are
parked. _(plan D10)_

## 0013 — Support "our control plane + local project runner" (home-assistant mode)

Architecturally supported: our control plane + ingress + auth, runner on your local box,
data never leaves. The runner dials out (NAT) and inbound HTTP routes down the held session.
Fully-offline is limited to non-cloud capabilities. _(plan D12)_

## 0014 — Build the control-plane↔runner interface on the existing `/api` door + two credential lanes

Reuse the capnweb `/api` door (it already _is_ a project runner exposing its ITX tree), the
born project-secret key (machine lane), and project-app-session (on-behalf-of lane). Add only
(1) a **mutual** cross-account credential and (2) a **pinned** long-lived session. Do **not**
resurrect `remoteCapability` without re-reading #2156. _(plan D13)_

## 0015 — The deliverable is a skeletal-but-realistic clean-room lab

Build in `apps/kernel` a lab that has **enough meat to prove where everything lands**, not a
production system: an example **repo Durable Object**, an example **stream Durable Object**, and
real platform ENV bindings (**AI**, **artifacts**) — chosen because deployment topology may swap
which binding backs a capability. A somewhat-realistic simulation and the _beginning_ of a future
migration/rewrite, but a lab for now. The `apps/os` migration is an explicit later track. _(grill Q01)_

## 0018 — The rewrite must not reproduce the `rpc-targets.ts` god-object

Standing constraint on the clean-room rewrite. Today `rpc-targets.ts` is **7,667 LOC / 87 first-hop
imports spanning every domain**, and even leaf pieces are welded to it — e.g. `RepoDurableObject` imports
`rpc-targets.ts` at the _top of its class file_, and `StreamDurableObject` pulls it in via `itxForScope()`.
The rewrite's capability tree must be **assembled from independent, self-contained capability pieces** —
no single mega-module that every DO/domain imports, no `itxForScope`-style choke-point that drags the
whole graph. _(How the tree IS assembled cleanly is Phase 2 — deliberately deferred; see
wayfinder/build-plan.md.)_ Evidence it's tractable: the stream **engine** (`stream-storage.ts` + helpers,
~1,750 LOC) already stands free of `Env`/itx/rpc-targets — the entanglement is only at the itx-delivery
surface. _(Jonas: "My rewrite should not end up with this RPC target situation.")_

## 0022 — MCP is deliberately a control-plane concern; it must work in every self-host topology

The MCP server lives on the **control plane**, not inside a project worker — _because_ MCP can create
projects and operate **across** projects, which is inherently a deployment-wide (multi-project)
capability. It joins the control-plane responsibility list (ADR 0017: auth · ingress · webhooks · egress
· email · **MCP**). Requirements:

- **Must work self-hosted** — clear hostname story: default is the `/mcp` route on the control-plane
  host; no hardwired `mcp.iterate.com` assumption may break self-host.
- **Must work behind Cloudflare Access AND with no auth** — a battery of assurances: MCP through
  Cloudflare Access (on your own CF account, fully self-hosting) _and_ wide-open (just hit `/mcp` on the
  deployed worker). Both proven **early** and **everywhere**.
  _(Jonas: "the MCP server is deliberately a control-plane concern because you could create projects using
  MCP or operate across projects… we need a battery of tests that MCP works with Cloudflare Access, or with
  no authentication.")_ Mechanism facts + the test battery: wayfinder/questions/mcp-everywhere.md.

## 0023 — `pnpm dev` has two distinct meanings; disambiguate them

`pnpm dev` is overloaded across two archetypes:

1. **Project-worker-only** — spin up _just_ the project worker that a customer runs in their own account
   **behind iterate's hosted control plane** (the "project worker on your box / your CF account"
   archetype's local dev; dials/points at our control plane).
2. **Full-stack** — spin up **your own control plane + project hosting + everything** locally (the
   self-hosted / collapsed archetype; the Pi floor).
   These are different commands/modes (a flag or two scripts), not one. Lock the disambiguation before the
   lab's dev ergonomics harden. _(Jonas — flagged; exact CLI shape TBD.)_

## 0021 — Capability _presence_ is environment-determined, not hardwired into the project worker

Some capabilities exist only if the control-plane environment provides them — Slack/GitHub OAuth
integrations (the OAuth receiver lives at the control-plane host) and metered first-party 3p secrets
(our key, used-but-never-seen, metered at the egress door). The `ProjectWorkerEntrypoint` **must not
hardwire** their existence; the set of available capabilities is handed to it by the control plane per
environment. Self-host with no iterate control plane → those integrations are absent unless the operator
wires their own (their Slack app/keys in `APP_CONFIG`) — presence is **config, not a code fork**.
**Presence ≠ sourcing** (Q03): sourcing is _where_ a capability is served from; presence is _whether it
exists at all_. Mechanism (how presence is declared/discovered; absent-getter vs typed-unavailable) is
open — see wayfinder/questions/control-plane-integrations.md. _(Jonas; also: paid Cloudflare plan is an
accepted assumption.)_

## 0020 — Ingress routing = a `hostname → {projectId, app}` table; wildcard base is optional

Routing is a **`hostname → {projectId, app}` table** (the registry half of the directory), filled two ways:

- **Wildcard-base convention** — own `base.com` with `*.base.com` wildcard TLS rooted to the control
  plane; `<slug>.base.com` / `<app>--<slug>.base.com` resolve by convention, no per-project row. Needed
  only for **multi-project** convenience. This is the `iterate.app` model.
- **Explicit entries** — any domain routed to the control plane gets one row `domain → {projectId, app}`.
  Covers custom domains **and** the single-project case.

Consequences:

- **Single-project self-host needs no wildcard base:** control plane on `your-cp.workers.dev` (serves
  dashboard + create at its own URL); the one project's domain routed to it with **one explicit row**.
- **The control plane always needs a real ingress domain rooted to it for project traffic** (workers.dev
  is fine for the management/dashboard surface, but a project on a real hostname needs that hostname
  routed to the worker + TLS).
- **We provide the wildcard base for the three control-plane-is-ours archetypes** — our CP owns
  `iterate.app`/`iterate2.app` and hands out `<slug>.iterate2.app` _regardless of where the project
  worker runs_, so a Tenant customer needn't own a domain.
- **Code gap:** the routing table isn't built — kernel only slug-parses the wildcard base
  (`resolveIngress`, no KV lookup). Building it (M2) unlocks custom domains + single-project self-host.
  _(grill; Jonas: "you need a base hostname under which you can make an arbitrary number of sub-hostnames
  … basically a wildcard TLS certificate," and "if I just want to create one project and I have a domain
  for it, how would that work?")_

## 0019 — Build order: streams prove the deployment lattice + auth first, capability tree second

**Phase 1** brings the reused stream engine + a stream processor into the kernel and uses them as the
concrete payload to **prove the deployment archetypes + authentication** (loopback vs capnweb reach, the
wall, directory, props). **Phase 2**, only after, builds the capability tree natively (repo, capability
host, dynamic worker building) without importing `rpc-targets`. Repo DO is dropped from Phase 1 (no clean
seam). _(Jonas — locked.)_

## 0017 — The runner is `ProjectWorkerEntrypoint`; two workers; the control plane is the network edge

The project runner is a props-parameterised `WorkerEntrypoint` class = **compute** (runs the dynamic
workers) + **data** (the DOs) + its **own local bindings**. The **control plane** is a separate worker =
the **network edge**: (1) authentication/wall, (2) ingress routing on public hostnames, (3) webhook
ingress (GitHub/Slack), (4) **egress** — the outbound path goes through the control plane in _all_ cases.
Consequences:

- **One worker for now** (split later). A dynamic Worker Loader binds its guest's `env.ITX` to a
  **loopback** entrypoint via `ctx.exports`, and loopback bindings are within a _single_ worker — so the
  loader + the `ProjectWorkerEntrypoint` must be the same worker. The control-plane responsibilities stay
  **logically** separate but physically live in that same worker for now; the seam (the ITX/`authenticate`
  interface) is well-defined, so the split into a separate network-edge worker (service-binding / capnweb
  at the seam) is cheap when we want it. Downside accepted: the bundle in a customer's account also
  carries the control-plane code. _(revises the earlier "two workers" lean — Jonas: "save one worker for
  now and see if we can split it later.")_
- **Reach is a binary:** a **loopback** entrypoint (project worker is the _same worker_ / same account)
  OR **capnweb over HTTP** (project worker is a remote public hostname). **No NAT dial-out** — a homelab
  makes itself findable via a tunnel. _(supersedes the "runner dials out" idea in plan Part 0 / D12.)_
- **Egress always flows through the control plane:** the project worker's `globalOutbound` forwards to
  the CP egress door; the project worker never hits the public internet directly. _(supersedes the clean
  room, where `globalOutbound` is the project entrypoint's own `fetch`.)_
- **Bindings follow the project worker for now** — `env.AI`/`env.ARTIFACTS` from its own account;
  per-capability sourcing (config-shadowing) is **deferred**. Event-shadowing stays fallback-only.
  _(grill; see wayfinder/topologies-and-axes.md — the four archetypes: iterate-hosted · project worker in
  your CF account · project worker on your box · self-hosted.)_

## 0016 — Not one bundle: a service-oriented set of small workers, identical per-worker

**Rejects the "one bundle + role knob" model.** Byte-identical only matters for _frequently-invoked_
workers (cold-start); some workers are necessarily _large_ (e.g. ESBuild-in-a-worker), and the
Cloudflare-idiomatic shape is SOA — many small workers. So the platform is **multiple distinct
workers**, of which some/most/possibly-all are byte-identical across deployments. **Identical-ness is
a per-worker property, not a whole-system invariant.** R1 is demoted accordingly: "these specific
workers are identical across deployments (for config-not-fork + one test matrix)", _not_ "the platform
is one identical bundle", and **the free-cold-start justification is dropped** (unsupported by CF docs;
PR #2115 proved warm-pinging a placebo). _(grill Q02; supersedes the R1 framing in plan Part A)_
