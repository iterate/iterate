# Decisions log (ADRs)

Resolved decisions, most durable first. Each is here because it's **hard to reverse**,
**surprising without context**, and **the result of a real trade-off**. Ported from
`self-hosting-plan.md` Part E (D1–D13) and extended as the grill resolves new ones.
Numbered sequentially; a decision that gets overturned is marked `superseded by NNNN`,
not deleted.

---

## 0035 — Only TWO deployment topologies for now: self-host-all-workers · iterate-hosts-all-workers (differ only in config)

**The lock (Jonas, 2026-08-03).** Stop supporting a lattice of mixed deployments. For now there are exactly
**two** topologies, differing **only in config**:

1. **Self-host all workers** — the customer runs every worker (project + control-plane + MCP + auth). No product.
2. **Iterate hosts all workers** — byte-identical, **plus one extra outer "product" worker**.

No mixed topology: **no project worker in a customer's Cloudflare account talking to our hosted control
plane; no cross-account capnweb dial; no connection-holder DO; no BYO-Cloudflare-account-per-project** — all
**deferred**. **Data residency is NOT a deployment axis** — it is a **per-capability provider override**:
"bring your own streams / bring your own repos" = override that collection's RpcTarget so its backing lives
elsewhere (ADR 0021 / jam §2c–d, promoted to the primary residency mechanism). **Billing/cost is userspace**
(a stream processor), not a control-plane primitive. **Egress STILL always flows through the control plane**
(ADR 0017 holds — from the project's perspective its outbound `fetch` goes through the control-plane egress
capability, in BOTH topologies). The lock actually makes this _cheap_: because both topologies co-locate the
control plane (same account), egress-through-CP is a **same-account service binding**, never a cross-account
capnweb session. What is a PRODUCT concern is only the **metering + first-party-key substitution layered into
that egress door** — not the door itself; a bare self-hosted control plane's egress door may just pass
through to `fetch()`, but the project still goes _through_ it.

**The network path is a SHELL ONION (both directions).** The shells nest — project ⊂ control plane ⊂ product
— and network traffic traverses all present shells:

- **Egress (inside→out):** project → control plane → **[iterate product, when hosted]** → internet.
- **Ingress (outside→in):** internet → **[iterate product, when hosted]** → control plane → project.
  So the **iterate product is the OUTERMOST network shell** (the actual edge when we host); the control plane is
  the edge in self-host. This is the §4 "fetch-middleware onion": ingress = _outer calls inner_, egress =
  _inner calls outer_. It reconciles "ingress/egress are just `fetch`" (D13) with "egress flows through the
  control plane": both are `fetch` traversing the shell onion, and each outer shell is where that shell's
  concerns live (product = metering/first-party keys/rich onboarding; control plane = routing/directory/
  capability provision).

**The precise line (resolves the sweep's flagged tension).** What is deferred is the mixed **worker-deployment**
topology — project _workers_ running in a different CF account than the control plane, joined by a standing
project↔CP capnweb session. What **still holds** is an **external capability provider dialing INTO a
deployment** via the wake socket (a Pi/browser/device providing a stream — spikes `capability-wake`/`fused`):
that is orthogonal to worker placement and works in **both** topologies. So "BYO streams via a Pi" is a
_capability provider dialing in_ (holds), not the _cross-account worker boundary_ (deferred). The
connection-holder DO (jam §8/D10) is the deferred **outbound project→CP** form; the inbound pager is not.

**Supersedes / defers** (see wayfinder/innermost-core/issues/11 for the full sweep):
**SUPERSEDED** — 0006 (level-2 transit contract), 0007 (always-a-billing-relationship → userspace), 0027
(BYO-account-per-project), and the four-archetypes / lattice / Level-2 framings in `topologies-and-axes.md`,
`CONTEXT.md`, `MAP.md`. **0017 HOLDS (corrected):** "egress always flows through the control plane" is
UNCHANGED — egress traverses the shell onion (project → control plane → [product] → internet), made cheap by
co-location (same-account service binding, not a cross-account dial); only the _metering/first-party-key
layer_ on the egress door is a product concern. `control-plane-and-product.md` §4 HOLDS.
**DEFERRED** — 0008 (BYO-account API-key handoff), 0009 (pinned cross-account capnweb session), 0010
(cross-account provisioning script), 0013 (home-assistant _mixed topology_ — its Pi-as-provider fragment
survives as a capability override), and the cross-account remote legs of 0001 / 0014 / 0034 (the HTTP `/serve`
dial) + deployment-topology 4. **SIMPLIFIED** — 0023 (`pnpm dev` collapses to full-stack-only), 0022 (MCP
test battery shrinks to two config variants). **STILL HOLD** — 0020/0025/0031 (routing + reserved CP host),
0032/0033 (auth worker + D1 directory), 0021 (capability presence = "is the product worker mounted?"),
0028/0012. **REFRAMED** — 0030 / `control-plane-and-product.md` (product is a _separate outer worker_, not an
empty config bag — already revised by jam §1). _(Jonas — "let's actually just lock this in; it simplifies a
lot of stuff.")_

## 0034 — Project worker (the runner) is a separate worker; control plane dials it (service binding OR HTTP)

The two-worker split is realized: **control plane worker** (front desk — login/session/directory/OAuth
AS/console/`/api`/`/mcp`/ingress routing) + **project worker** (runner — loads + serves a project's confined
config worker via Worker Loader; NO directory, NO auth). The control plane resolves host→projectId from its
D1 directory, then **dials** the runner: a **service binding** (`env.RUNNER.serve(...)`) same-account, or
**HTTP `POST /serve` + a shared secret** cross-account (service bindings don't cross CF accounts — this is
what makes the "project worker in a separate account" topology real). One behavior (`serveConfigWorker`),
two transports. Proven deployed end-to-end (`prove-twoworker.mjs` 7/7): the config worker runs confined
(`seenBindings=["ITX"]`) with the caller identity stamped through. `apps/project-worker` is pure-play; the
kernel's fuller `ProjectCapabilities` (streams/secrets/ai/egress) fold in behind the same `ProjectEntrypoint`.
Supersedes the kernel's co-located `dialRunner` loopback. See wayfinder/deployment-topologies.md.

## 0033 — Directory on D1/sqlfu, org-centric, apps/auth id+slug model (globally-unique slugs)

The control plane's directory is **D1 + sqlfu** (strongly consistent — no KV `list()` lag, which caused the
console bug; relational — memberships/routes want joins), not KV. Model mirrors **apps/auth**: users belong
to **orgs** (`org_<hex>` id + own slug) via `org_members`; projects (`prj_<hex>` id, **distinct from slug**)
belong to an org; **project slugs are GLOBALLY unique** (a slug taken in any org is taken), not per-org.
Access to a project = membership in its org. Ingress **routes are a property of a project** (host→project
rows), replacing the kernel's `routing.ts`. API keys are hashed rows with project grants. This is the one
directory implementation — it replaces ADR 0004's provider switch entirely. Schema: control-plane
`definitions.sql`; queries: one `sql/queries.sql` (sqlfu best practice). Needs `nodejs_compat` (sqlfu's
barrel export) — the control plane is the "rich" worker; the project worker stays pure-play.

## 0032 — One always-deployed auth worker = login + session + directory + OAuth AS (supersedes 0003, 0004)

Stop reinventing `wall` + `directory` in the kernel. **Always deploy one small auth worker** (hosted AND
self-host); its config says how login works (wide-open · email-entry · behind-Cloudflare-Access). It is:
(a) a **forward-auth "partial fetch"** for browser pages (no session ⇒ return its login form, the caller
returns it verbatim); (b) the **OAuth 2.1 Authorization Server** for MCP clients (MCP `2025-11-25`: `/mcp`
is a Resource Server that 401s with `WWW-Authenticate … resource_metadata`; client discovers the AS and
does authcode+PKCE-S256+`resource`; client identity via **CIMD** — a URL `client_id`, **no DCR/`/register`**);
(c) the **device-grant AS** (RFC 8628) for embedded devices; and (d) **the directory** (users → orgs →
projects → devices). All four share ONE login UI + ONE session + ONE directory — the human step of every
flow (`/authorize` consent, device `/verify`, app page) reuses the same login + the project picker (ADR
0029). This **deletes** `auth-wall.ts` + `directory.ts`'s provider switch + `AppConfig.wall`/`directory`
from the kernel (fewer concepts, hosted==self-host in shape) and **resolves the "Access doesn't scale"
concern** (Access becomes one login mode, not the wall). A clean-room microcosm of `apps/auth`. Full design

- spec citations + build plan: wayfinder/auth-worker-design.md. _(Jonas.)_

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
