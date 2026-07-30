# Kernel self-hosting — glossary (agreed taxonomy)

The ubiquitous language for the kernel / control-plane / project-runner work. One
concept per term; pick the best word, list the rejected synonyms under _Avoid_.
This file is a **glossary, not a spec** — no implementation detail. Terms still
contested in the grill are marked ⚠️; resolve them, then drop the mark.

## Topology

**Control plane**:
The worker that knows about _many_ projects — ingress, the hostname→project routing
table, the auth wall, the directory/registry. Holds no project data. One per deployment.
_Avoid_: platform worker (ambiguous — see ⚠️), kernel-as-a-whole, router.

**Kernel project entrypoint** (inner):
The trusted, kernel-owned `ProjectWorkerEntrypoint` that **is** the ITX capability tree for one
project, reached at `/api`. Mints the confined userspace with `env.ITX` + props. _(Was "the runner"
— retired, ADR 0024.)_
_Avoid_: runner, vessel, ITX worker.

**Userspace project entrypoint** (outer):
The config-repo's exported default worker — the _user's_ code, loaded + confined by the Worker
Loader, sees only `env.ITX`. Where userspace HTTP handling / ITX scripts run.
_Avoid_: config worker (ok informally), app worker.

**Kernel**:
The clean-room trusted platform codebase (`apps/kernel`). The kernel has **two parts**: the
**control plane** (the many-projects stuff — ingress, egress, routing, wall, MCP, directory) and the
**project worker** (the one-project stuff — the kernel project entrypoint + per-project capabilities).
One worker for now (ADR 0017); the two parts are logical. **"Kernel" ≠ "control plane"** — the control
plane is one of the kernel's two parts. Trust axis: **kernel space** (trusted platform) vs **user
space** (confined config-repo code). "Platform" is deprecated in favour of "kernel".
_Avoid_: using "kernel" to mean the control plane specifically; "platform"; "role".

**Config worker**:
The per-project userspace bundle a project deploys — its own public site + userspace
stream processors. Contains none of the runtime; calls platform capabilities via `ITX.*`.
_Avoid_: user worker, app worker.

**Confinement**:
The isolation mechanism — a Cloudflare Worker Loader runs the config worker with scoped
props and an intercepted `globalOutbound`, guaranteeing one project cannot reach another.
_Avoid_: sandbox, jail.

## Interface & transport

**ITX capability tree**:
The single capability surface a project runner exposes (`ITX.ai`, `ITX.repos`,
`ITX.streams`, `ITX.secrets`, `ITX.egress`, …). Same tree whether reached in-account or
cross-account. **The unification**: every caller goes through this one code path.
_Avoid_: the API, the RPC surface (too generic).

**Uniform interface (`/api`)**:
The single door to a project runner. Same-account callers reach it via **Workers RPC
(service binding)**; cross-account callers via a **bidirectional capnweb WebSocket**.
"Cross-account" is just "the same path, different transport."

**Bidirectional capnweb session**:
A persistent WebSocket capnweb link used for chatty cross-account RPC (Workers RPC can't
cross accounts). Re-implements Workers RPC over the public internet. HTTP-batch is
forbidden in source (lint `iterate/no-capnweb-http-batch`); WebSocket is blessed.
_Avoid_: HTTP-batch dial, RPC-over-HTTP.

**Capability source** ⚠️:
Where a single ITX capability is served from — our account (possibly volume-discounted)
or yours — via a local binding or cross-account capnweb. Per-capability. The granularity
(per-capability vs per-project) is contested; pin during grill.
_Avoid_: provider, backend.

**Shadowing**:
Overriding what a capability name resolves to. Two **origins**, possibly different trust rules:

- **Config-shadowing** — a _trusted, deployment-level_ override (this is what "sourcing" IS:
  config points `ai` at a remote proxy instead of local `env.AI`). ⚠️ Whether it may override a
  _builtin_ is **open** ("we'll see").
- **Event-shadowing** — a _runtime, userspace_ override driven by an event in a stream DO
  (`provideCapability`). Today this **cannot** shadow a builtin — `rejectBuiltinCollision` enforces
  it at provide-time; the capability host is a fallback for undeclared names only.

**Mounting**:
The mechanism behind event-shadowing — the capability host (`provideCapability`/`invokeCapability`,
`resolveLongestPrefix`) attaching a userspace capability at a path. Adds undeclared names; builtins win.

## Identity

**Wall**:
The only identity mechanism: verify a JWT that an ingress wall injected
(`WallConfig {header, jwksUrl, issuer, audience?}`). In practice the wall is **Cloudflare Access**
(the `WallConfig` carries that Access app's AUD/issuer/certs). No wall = wide open (everyone
anonymous, single-tenant). _Avoid_: OIDC layer, auth middleware. Do **not** conflate the wall with
the IdP or the directory — see below.

**IdP** (behind the wall):
Which identity provider the Cloudflare Access app federates to — a **Cloudflare-dashboard setting,
invisible to our config**. Two cases we test: **Google directly** (self-host, no auth.iterate.com
dependency) or **auth.iterate.com** (full iterate). Same wall (`WallConfig`) either way; only the
Access app's AUD differs.
_Avoid_: saying "wall = Cloudflare Access or auth.iterate.com" (conflates wall + IdP).

**Directory**:
Registry (+ ingress routing) + membership. **The control plane owns it**; the backing authority is
**config**: `kv` (local, single-tenant), `auth.iterate.com` (outsourced to the auth worker over a
Service binding, multi-tenant), or `open` (zero-config default). The registry half **is** the ingress
hostname→project lookup table.
_Avoid_: user store, tenant DB.

**Born project-secret key**:
The `itxk_…` API key every project is born with, verified inside the Secret Durable
Object; grants exactly one project, no user, no admin. The machine↔machine credential lane.

**Project-app-session**:
A narrow, short-lived (15-min), per-project HS256 grant minted by the front door for
on-behalf-of-a-user calls. The human↔machine credential lane.

**Dashboard (kernel-reserved)**:
The control-plane-served project dashboard + `/api`, always reachable regardless of
config-worker health. Reserved app name; the kernel intercepts it before the loader.

## The lattice

**The lattice**:
The set of independent hosting dimensions (ingress hostname · compute · data-at-rest ·
control plane · egress edge · each capability), each independently "ours" or "yours".
Any consistent combination is valid. "Levels" are named bundles of dimension values.
_Avoid_: the ladder (implies linear; it's a lattice), the tiers.

**Level 1 — iterate-hosted**: hostname/compute/data/capabilities/control-plane all ours
(you may still bring custom domains via Cloudflare-for-SaaS).

**Level 2 — BYO account**: our ingress (auto `iterate.app`) + our control plane, **your**
compute + data + (mixed) capabilities. We are HTTP edge in-and-out, **never a store**.

**Level 3 — full self-host**: everything yours, including control plane, directory, wall,
domain.

**Miniflare tier** (a value on the _compute_ dimension):
Your own container running the same bundle under `pnpm dev` / Miniflare — `wrangler login`

- `pnpm dev`, restart-on-crash (not HA). The floor: a Raspberry Pi on your LAN, no wall.

**Home-assistant mode**:
Our control plane + ingress + auth, project runner on your local box; **data never leaves
the box**. Because it's behind NAT, the runner **dials out** and holds a bidirectional
capnweb session; inbound HTTP routes _down_ that held session.

**Account-per-project** (north-star isolation idea, not a hard requirement):
A separate Cloudflare account per project runner — maximal isolation + budget control.
Architect so this is easy (likely via Workers-for-Platforms / cross-account provisioning).

## Movement

**Moving up/down the lattice**:
Any transition (level↔level or a single dimension) is **config + data-migration, never a
code rewrite** — the lattice moves under unchanged project code.

**Cross-account provisioning**:
A script (Alchemy-v2 / preview-env style) that, given the customer's Cloudflare API key,
idempotently creates the resources (KV, DO, R2, routes, DNS) in their account and returns
the identifiers we deploy with.
