# The sourced capability tree — one design for kernel + control plane + project runner

*An architect's proposal (opus). Grounded in the `apps/kernel` clean-room POC and the current
`apps/os`. North star: **the ITX capability tree is the whole architecture.** Decomposing
`apps/os`'s monolithic RPC targets into independently **sourced** capabilities — each one bound
from our account *or* yours, over a local binding *or* a cross-account capnweb session — is the
single structural move that makes the entire self-hosting lattice fall out for free.*

Companion to `../self-hosting-plan.md` (requirements R1–R14, decisions D1–D13, milestones M0–M8)
and `../clean-room-status.md`. Where those disagree with this doc, they win on facts; this doc is
one opinion on shape.

---

## 1. The proposal

### 1.1 One idea, stated once

There is exactly **one interface in the system: the ITX capability tree.** Everything —
the browser, the agent, an MCP client, our own control plane, another Cloudflare account — reaches
a project through the _same_ path:

```
Os.authenticate(credentials?) → Session → session.projects.get(id) → Project
                                                                       ├── ai
                                                                       ├── repos
                                                                       ├── streams
                                                                       ├── secrets
                                                                       ├── scheduler
                                                                       └── fetch      (the egress door)
```

This tree already exists twice, nearly identically: as the 854-line clean-room kernel
(`kernel.ts` `Os`/`Session`/`ProjectCollection`/`Project`) and as the 7,667-line
`apps/os/src/rpc-targets.ts` god-object. The kernel proved the _spine_; `apps/os` has the _surface_.
This proposal keeps the spine and **melts the surface into a set of small, independently-sourced
capability sub-trees.**

The load-bearing sentence of the whole design:

> **A `Project`'s capability getter does not _contain_ an implementation. It _returns a source_ —
> and a source is either a local Cloudflare binding or a remote capnweb stub. To the caller they are
> byte-for-byte the same object, because capnweb's `RpcStub` and `cloudflare:workers`' `RpcTarget`
> are the same type.** (See §5.)

Once that is true, "self-host", "BYO account", "level 2", "home-assistant", "account-per-project"
stop being _modes_ and become _which source each capability is bound from_ — a value in
`APP_CONFIG`, never a code fork (R1, R4, R5, R12).

### 1.2 The components (conceptually minimal)

Four things, no more:

| #   | Component              | Knows about         | It _is_                                                                    |
| --- | ---------------------- | ------------------- | -------------------------------------------------------------------------- |
| 1   | **Control plane**      | _many_ projects     | ingress routing, the wall, the directory/registry. One per deployment.     |
| 2   | **Project runner**     | _one_ project       | the ITX capability tree (`ProjectEntrypoint`) + `/api`. Confined. No wall. |
| 3   | **Capability sources** | one capability each | `ai`, `repos`, `streams`, `secrets`, `egress`… each independently bound.   |
| 4   | **Config worker**      | the user's code     | `{ fetch, processEvent }` loaded into a sandbox that sees only `ITX`.      |

The kernel POC already _is_ components 1+2 fused in one worker; this proposal keeps them fusible
(same bundle) but makes the runner independently addressable so the placement matrix opens up
(Part 0 of the plan).

### 1.3 The two workers (identical bundle, R1)

**Both workers are the same byte-identical bundle** (M0 / R1); a boolean-ish `role` in `APP_CONFIG`
picks behaviour, and CI asserts `sha256(hosted) == sha256(selfhost)`. Why identical: an identical
bundle is edge-cached everywhere, so cold starts are ~free. The runtime that makes iterate _iterate_
(LLM, the durable log, egress policy) is **not compiled into userspace** — it lives behind ITX as
platform capabilities, called from userspace via `ITX.*` (R2).

- **Control plane** (`role: "control-plane"`). The `fetch` router: `hostname → { projectId, app }`
  (`resolveIngress`), verify the wall JWT if configured, then **dispatch to the runner for this
  project** — same account via a Workers-RPC service binding, cross-account via a held capnweb
  WebSocket. Serves two kernel-reserved paths itself: **`/api`** (the capnweb front desk) and the
  **`dashboard` app** (control plane; served directly so a broken config worker can't lock you out —
  kernel `DASHBOARD_APP`). Owns the **ingress routing table** (KV) and the **directory** (D8).
- **Project runner** (`role: "runner"`). Exposes `ProjectEntrypoint` as: (a) `env.ITX` +
  `globalOutbound` to the loaded config worker (in-worker Workers RPC), and (b) `/api` over capnweb
  (`newWorkersRpcResponse` → WS + HTTP-batch) for cross-account callers. **No wall** — it derives
  identity from what it is handed (props, or the `authenticate` credential). The wall is a
  control-plane concern (D7).

In the smallest deployments (Pi, `pnpm dev`, single-tenant self-host) the two roles are **the same
worker instance** and dispatch is a local method call. That is the kernel POC as it stands today.

### 1.4 The capability tree, decomposed and sourced (the heart)

Today `Project` (`ProjectRpcTarget`, `rpc-targets.ts:5238`) is a god-object with ~35 hardcoded
getters — `get ai` (5655), `get repos` (5821), `get streams` (5728), `get secrets` (5859),
`get egress` (5749), `get scheduler` (5846), plus `kv`, `files`, `browser`, `mcp`, `integrations`,
`email`, `agents`, `workers`, `capabilityHost`, `docs`, `auth`, … — each `new XxxRpcTarget(...)`,
all statically imported and news-up'd in one class. Two things make it _monolithic_: the static
construction recipe `itxForScope()` (`:5989`, the single place these are assembled) and the mount
collision-guard `ITX_SURFACE_MEMBER_NAMES` (`:5976`), which hard-couples "which names are built-in"
to this one class's prototype. **Decomposition = inject a source table into `itxForScope`, and make
the collision-guard read the source table instead of a prototype.** This proposal replaces the
getters with a **source table** resolved once when the `Project` handle is minted:

```ts
// The one new concept. A capability is bound from exactly one source.
type CapabilitySource =
  | { kind: "local"; stub: RpcTarget } // a same-account binding (a DO stub, an AI binding, an R2 wrapper)
  | { kind: "remote"; stub: RpcStub }; // a capnweb stub over a held WS to another account/box

type CapabilitySources = {
  ai: CapabilitySource; // LLM requests (holds the AI Gateway / Workers-AI binding + which gateway)
  repos: CapabilitySource; // source storage + clone/build (R2-backed; storage ⇒ defaults to yours)
  streams: CapabilitySource; // the durable log: append / subscribe / getEvents (DO + R2)
  secrets: CapabilitySource; // the vault + the substitution material for the egress door
  scheduler: CapabilitySource; // alarms / recurrence (the one internal time trigger)
  egress: CapabilitySource; // the one outbound door: policy + secret-substitution + metering
};

class Project extends RpcTarget {
  constructor(
    private projectId: string,
    private src: CapabilitySources,
  ) {
    super();
  }
  get ai() {
    return this.src.ai.stub;
  } // ← the getter just returns the source's stub
  get repos() {
    return this.src.repos.stub;
  }
  get streams() {
    return this.src.streams.stub;
  }
  get secrets() {
    return this.src.secrets.stub;
  }
  get scheduler() {
    return this.src.scheduler.stub;
  }
  // fetch (globalOutbound) routes through src.egress; see §3(h) and §4.
}
```

`CapabilitySources` is built by a single `sourcesFor(config, env, projectId)` function — the moral
successor to today's `directoryFor(cfg, env)` and `verifiersFor(cfg, env)`. It reads `APP_CONFIG`,
and for each capability picks:

- **local** → wrap the same-account binding: `env.STREAMS_DO`, `env.AI` (Workers AI / AI Gateway),
  `env.REPOS_R2`, `env.SECRETS_DO`. Zero network hops. This is level 1 and level 3.
- **remote** → obtain a capnweb stub by **pipelining** off a held session:
  `controlPlane.projects.get(id).ai` (level 2: `ai` from _our_ account) or
  `runnerSession.projects.get(id).streams` (control plane reading _your_ data). No await needed —
  capnweb promise-pipelines the whole path in one round trip (§5).

**This is R5, and it is the whole ballgame.** `itx.repos.get(x).clone()` can hit _your_ account's R2
while `itx.ai.generate(...)` hits _our_ volume-discounted gateway, in the same project, on the same
request — because `src.repos.kind === "local"` and `src.ai.kind === "remote"` independently. The
capability tree _is_ the config surface. There is no other config surface.

### 1.5 The two authorities (unchanged from the POC — keep them)

Orthogonal to sourcing, the kernel's two pluggable knobs stay exactly as built:

- **`wall`** — identity. Omit ⇒ wide open (anonymous, first-class — R3). Set ⇒ verify a JWT some
  ingress wall (Cloudflare Access, an auth.iterate.com forward-auth proxy, Caddy) injected on a
  header (`wall.ts`, ~47 lines). Cloudflare Access and auth.iterate.com are the _same_ code, different
  `WallConfig`.
- **`directory`** — which projects exist + membership + birth. Collapse the POC's four providers to
  the **two real modes plus the zero-config default** (R13): `open` (default), **`kv`**
  (single-tenant self-host — the registry half _is_ the ingress routing table), **`auth.iterate.com`**
  (multi-tenant SaaS, over a same-account `AUTH` service binding). **Delete `local`** (a test fixture
  in a provider's clothes).

Identity is "verify a voucher." The generalization the identity doc reaches for — a verifier
registry keyed by issuer (Access, auth.iterate.com, Slack HMAC, email DKIM, scheduler, a capability)
all emitting `{ who, issuer, claims }` — is the natural home for _webhook_ ingress identity too
(R8), and it is a small extension of `verifiersFor`, not a rewrite.

### 1.6 One picture

```
                    hostname
                       │
      ┌────────────────▼─────────────────┐
      │        CONTROL PLANE (one)        │   role=control-plane, identical bundle
      │  resolveIngress → {projectId,app} │
      │  wall.verify(JWT)?  directory      │
      │  /api  (capnweb front desk)        │
      │  dashboard app (served directly)   │
      └───────┬───────────────────┬────────┘
              │ same account:     │ cross account:
              │ Workers RPC        │ held capnweb WS (bidirectional)
              ▼                   ▼
      ┌───────────────────────────────────┐
      │        PROJECT RUNNER (one/proj)   │   role=runner, identical bundle, NO wall
      │  ProjectEntrypoint = the ITX tree  │
      │  ┌─────────────────────────────┐   │
      │  │ Project.sources:            │   │   each source independently local|remote
      │  │  ai ─────► remote (our AI)  │   │
      │  │  streams ► local  (your DO) │   │
      │  │  repos ──► local  (your R2) │   │
      │  │  secrets ► local + remote   │   │
      │  │  egress ─► local → cp door  │   │
      │  └─────────────────────────────┘   │
      │  Worker Loader → config worker      │   sees ONLY env.ITX (confinement)
      │     { fetch, processEvent }          │   globalOutbound = the egress door
      └───────────────────────────────────┘
```

---

## 2. Scripts

Scripts stay in the `apps/os`/`envs.ts` idiom (each app deploys with small scripts:
`pnpm run deploy --env <name>`, `ensure-resources`, `erase-data`). New/changed:

| Script                                                  | What it does                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy --env <name>`                                   | Build the **one identical bundle** → `wrangler deploy` with atomic secrets → smoke. `--env` selects a profile in `envs.ts` (the typed env map) that supplies only `APP_CONFIG` + secrets. Same bundle for control-plane and runner roles.                                                                             |
| `bundle-hash` (CI, M0)                                  | Build under hosted and self-host profiles; assert `sha256` equal. The north-star guardrail — fails the build if anything deployment-specific compiled in (R1).                                                                                                                                                        |
| `ensure-resources --account <ref>`                      | Idempotently create the resources a deployment needs **in a named account**: `DIRECTORY_KV`, the ingress-routing KV, the streams DO namespace, `REPOS_R2`, the Worker Loader binding, the wildcard route + proxied wildcard DNS + Total-TLS cert. Parameterised by account so it runs against ours _or_ a customer's. |
| `provision-customer-account` (M6, D11)                  | The cross-account "Alchemy-v2 / preview-env-style" script: given a customer's Cloudflare **API key** (D3), runs `ensure-resources` **in their account**, deploys the runner bundle there, and returns the identifiers the control plane needs to bind/dial it. Idempotent (OQ-f).                                     |
| `create-project <slug> [--org <slug>]`                  | Births a project through the configured directory (the same `session.projects.get(slug).create()` call, over `itx`), and writes the hostname→project entry into the ingress KV. Works in `kv` and `auth.iterate.com` modes unchanged.                                                                                 |
| `map-hostname <domain> <slug>`                          | Adds a second (custom) domain to a project: writes the ingress KV entry and, when fronted by us, provisions a Cloudflare-for-SaaS custom hostname. Ingress only cares that the request reached our worker and the table says which project (R6).                                                                      |
| `source-capability <slug> <cap> <local                  | remote> [target]`                                                                                                                                                                                                                                                                                                     | The **R5 knob as a command**: repoint one capability's source in `APP_CONFIG` (e.g. `source-capability acme ai remote our-gateway`, or `source-capability acme streams local`). No data move, no code change (M8, the "any single dimension" transition in Part C). |
| `migrate-data <slug> <cap> <from-account> <to-account>` | Parked mechanics (D10/OQ-e); today a documented stub that copies a stream/R2/repo between accounts, then flips the source. The _code_ never changes; only the source and the bytes move (M8).                                                                                                                         |
| `erase-data --env <name>`                               | Existing semantics — wipe a deployment's data; workers are never deleted.                                                                                                                                                                                                                                             |
| `dev` (`pnpm dev`)                                      | Miniflare, wide open, `kv` directory, both roles in one worker, all capability sources `local`. Restart-on-crash, not HA (R3/R3b). The Pi / home-assistant floor.                                                                                                                                                     |

---

## 3. Main stories (end-to-end)

Notation: **CP** = control plane, **RN** = project runner, **CW** = config worker (userspace, in a
Worker-Loader sandbox).

### (a) Create a project

1. Browser hits `iterate.com` (or a self-host control-plane URL) → CP.
2. If a `wall` is configured, the wall (Access / auth.iterate.com proxy) authenticated the human and
   injected a JWT; CP verifies it (`wall.ts`). Wide-open self-host: anonymous, fine.
3. Client dials CP `/api` over a capnweb WS: `os.authenticate()` → `Session` →
   `session.projects.get("acme")`. Unknown slug ⇒ a **prospective** `Project` handle.
4. `handle.create({ organizationSlug? })` → the directory writes the row (`auth.iterate.com`'s
   `createProjectForOrganization` over the `AUTH` binding, or the local `kv` registry). CP writes
   `acme → projectId` into the **ingress routing KV**. Same call in both modes; only config differs.
5. `acme.iterate.app` and `dashboard--acme.iterate.app` now resolve. Done.

### (b) Hosted serving (level 1)

1. Request to `acme.iterate.app` → CP `resolveIngress` → `{ projectId: "acme", app: "" }`.
2. CP mints the props-scoped `ProjectEntrypoint({ props: { projectId } })`, all capability sources
   `local` (our account), and Worker-Loads the CW with `env.ITX = globalOutbound = projectEntry`. CW
   sees only `["ITX"]` — that single-binding surface _is_ confinement (R10).
3. CW serves the project's public site; `dashboard--acme.iterate.app` is served **directly by CP**
   (kernel-reserved), which mints a narrow 15-min `project-app-session` and proxies to the dashboard
   vessel. A broken CW never locks you out of the dashboard.
4. Custom domains work even fully hosted: `map-hostname acme.com acme` provisions a
   Cloudflare-for-SaaS custom hostname; ingress resolves it via the same KV table (R6).

### (c) Self-host your own domain (level 3)

1. `wrangler login` (your account). `ensure-resources --account you` provisions `*.you.com` wildcard
   route + proxied wildcard DNS + Total-TLS, the KV/DO/R2 bindings, the Worker Loader.
2. `deploy --env selfhost` ships the **identical bundle** with `APP_CONFIG =
{ hostBase: "you.com", wall: <your Access>, directory: { provider: "kv" }, sources: all-local }`.
3. Everything runs in your account: CP + RN are one worker, all sources `local`. `create-project foo`
   → `foo.you.com` serves, `dashboard--foo.you.com` demands your Access login while `foo.you.com`
   stays public (Access scoped per app hostname; the kernel just verifies the Access JWT when
   present). This is exactly the POC's live `shiterate.com` deployment.

### (d) BYO-Cloudflare-account (level 2 — the product)

The commercially interesting middle: _we_ handle billing, hostname, webhook ingress; _you_ hold your
data.

1. `provision-customer-account` runs `ensure-resources` in **your** account via your API key (D3) and
   deploys the runner bundle there; returns identifiers.
2. Ingress stays ours: `acme.iterate.app` → **our CP** → `resolveIngress`. CP holds a **persistent
   bidirectional capnweb WebSocket** to your runner (R11/D4) and dispatches down it —
   `runnerSession.authenticate(...).projects.get("acme")`. Cross-account, because **Workers RPC
   cannot cross account boundaries** (§5); capnweb is the same RPC protocol over a WS, so the path is
   uniform.
3. On your runner, `sources.streams`/`sources.repos` are **local** (your DO/R2 — data at rest in your
   account). `sources.ai` is **remote**, pipelined back to _our_ AI capability (volume-discounted,
   metered — R9/D5). `sources.egress` is **local → our CP egress door** (two-level egress, §4).
4. Webhooks (Slack/GitHub) hit our first-party ingress, are held only in a **short-TTL buffer**, and
   cross-post into _your_ stream (R7/R8). Data + webhooks at rest live only in your account; nothing
   durable in ours. That is the level-2 promise, proved by asserting data-at-rest location (M7).

### (e) Local `pnpm dev` / home-assistant

1. **Fully local (Pi floor, R3):** `pnpm dev` → Miniflare, no wall, `kv` directory, both roles one
   worker, all sources `local`. Create + reach a project, zero external deps. Kill + restart ⇒ state
   intact from KV/streams (restart-on-crash, not HA).
2. **Home-assistant behind our control plane (D12):** our CP + ingress + wall; your runner runs
   `pnpm dev` on a home box behind NAT. The runner **dials out** and holds the bidirectional capnweb
   session; inbound HTTP for the project routes _down_ that held session (the `ProjectDial` pattern
   already proven in `apps/tasks/checkout-do.ts`). Data never leaves the box. Caveat: some sources
   (e.g. artifacts, real R2) require Cloudflare cloud, so a fully-local runner is limited to local
   capabilities (OQ-g) — those capabilities are simply sourced `remote` back to us, or absent.

### (f) MCP connect → emerge with a project

1. An MCP client (e.g. Claude) connects to iterate's MCP endpoint. Managed OAuth injects a JWT — the
   **same wall** verifies it (identity via one mechanism; §4 of clean-room-status).
2. The MCP server _is_ the ITX tree exposed as MCP tools. The session calls `authenticate()` →
   `Session`. `session.projects.list()` shows the caller's projects (directory membership); the
   caller's tool call `projects.get("new-thing").create({...})` **emerges with a project** — birth
   through the directory, mid-conversation.
3. Every subsequent MCP tool call is a method on the capability tree (`itx.streams.get(p).append`,
   `itx.ai.generate`), permissioned by the directory exactly as a browser is. MCP is not a special
   path — it is the tree with a different transport in front.

### (g) Agent LLM call via ITX

1. The agent is **userspace** — a stream processor (`processEvent`) running in the CW sandbox, not a
   kernel concept.
2. A committed event wakes the processor; it calls `env.ITX.ai.run(model, body)` (the real method —
   `AiRpcTarget.run`, `rpc-targets.ts:2685`).
3. `env.ITX` is the `ProjectEntrypoint`; `.ai` returns `sources.ai.stub`. Level 1/3: a local `AI`
   binding routed through an AI Gateway — one hop. Level 2: a **remote** capnweb stub; the call
   travels the held WS to our CP's `ai` capability, which calls the AI Gateway with _our_ key or a
   BYO key in Cloudflare Secrets Store (`cf-aig-authorization`), **meters** it via unified billing
   (D5/R9), and streams the response back down the same session. Promise pipelining means the request
   leaves in one round trip even though `.ai` was itself a pipelined path (§5).
4. The response is folded back into the project's stream. The agent never holds a model key; `ai` is
   a sourced capability, not compiled code (R2).

### (h) Egress with a substituted secret

1. CW (or the agent) does `fetch("https://api.stripe.com/…", { headers: { authorization:
"Bearer {{secrets/stripe}}" } })`. Because `globalOutbound` is the project's egress door, workerd
   routes _every_ sandbox `fetch`/`connect` through `ProjectEntrypoint.fetch` — the one choke point.
2. The egress door resolves the `{{secrets/stripe}}` placeholder from `sources.secrets` (your vault
   for your secrets; _our_ first-party vault for a volume-discounted third-party key — R9),
   **substitutes** the real value, applies egress policy/approval, and **never lets the raw secret
   reach the sandbox or a log/stream** (the substitution happens at the door, past the config
   worker's sight).
3. Level 2: the outbound hops project-egress-door → **CP egress door** (across the boundary over the
   held capnweb session), where _our_ metering/policy sits when we are the billing counterparty
   (D5). We are the first + last HTTP hop; we store nothing (R7).

---

## 4. Difficulties & trade-offs

- **capnweb over the public internet is the new failure domain.** A held bidirectional WS can drop;
  we need liveness, reconnection, and re-announcement (the `ProjectDial` redial + orphaned-stream
  re-announce patterns already exist). Every level-2 request now depends on a socket staying up.
  Latency-sensitive paths (LLM token streaming, chatty stream folds) ride this socket — acceptable
  because promise-pipelining collapses round trips, but it is real added tail latency vs. a local
  binding.
- **Two-level egress doubles the outbound path and adds a SPOF.** project-door → CP-door is where our
  metering lives, but it is also a hop that can fail and a place bytes transit our edge (D1 says
  transit-yes/at-rest-no is fine; still, it is a trust ask).
- **The customer Cloudflare API key (D3) is a big, coarse credential.** We hold a key that can do
  almost anything in the customer's account, for provisioning. Minimal scoping is "for now"; a real
  product wants scoped tokens. This is the least-elegant seam and should be named as such.
- **Secret substitution must be airtight.** Placeholders in headers/bodies, substituted at the door,
  never logged, never folded into a stream, never visible to userspace. Get the redaction wrong and
  a secret leaks into the durable log forever. (The POC has the door mechanism but not this policy.)
- **capnweb error semantics bite.** A rejected pipelined promise can _pass through_ silently (a
  vacuous reject); cross-account calls must wrap awaited stubs so a dropped session surfaces as an
  error, not a hang. (Known trap in our codebase; capnweb `RpcPromise` rejections need explicit
  handling.)
- **"Identical bundle" vs. real capabilities.** The rule forbids compiling deployment-specific
  behaviour in, so _all_ variation must live in `APP_CONFIG` + the source table. That is clean, but
  it pushes complexity into `sourcesFor` and demands discipline (the M0 CI hash is the enforcement).
- **Data migration up/down the ladder is unsolved (D10/OQ-e).** Repointing a source is trivial;
  moving the _bytes_ consistently (streams/R2/repos) between accounts, with cutover and no loss, is
  not — and it is the thing that makes "move up and down the ladder" (R12) actually usable.
- **Home-assistant honesty.** Some capabilities genuinely need Cloudflare cloud. "Data never leaves
  the box" is true for local capabilities; anything sourced `remote` (ai, artifacts) does leave. The
  boundary must be explicit, not implied.
- **Multi-user self-host (OQ-b).** `kv` gives single-tenant (anyone through your wall reaches any
  project). Real multi-user orgs today only exist in `auth.iterate.com`. Self-host that wants orgs
  must either bring an auth worker or accept single-tenant. Left open on purpose.

---

## 5. Fragments of knowledge (load-bearing, cited)

**capnweb (`capnweb@0.10.0`, in `apps/kernel/node_modules/capnweb`; Cloudflare's Cap'n Web):**

- Exports (verified in installed `dist/index.d.ts`): `RpcTarget`, `RpcStub`, `RpcPromise`,
  `RpcSession`; server helpers `newWorkersRpcResponse`, `newWorkersWebSocketRpcResponse`,
  `newHttpBatchRpcResponse`; client dials `newWebSocketRpcSession`, `newHttpBatchRpcSession`. **There
  is no `newWorkersRpcSession`** — the client dial is `newWebSocketRpcSession(url | ws, localMain?)`.
  The kernel uses `newWorkersRpcResponse(request, new Os(...))` at `/api`, which is a **dispatcher**:
  `POST` → HTTP-batch, `Upgrade: websocket` → WS, else 400 (verified in `dist/index.js`). apps/os
  splits them: `newHttpBatchRpcResponse` for POST + `newWorkersWebSocketRpcResponse` for WS
  (`worker.ts:284,286`). _(kernel `kernel.ts:347`.)_
- **`newWorkersRpcResponse` sets `Access-Control-Allow-Origin: *` and accepts cross-origin requests**
  — safe _only_ because authorization is **in-band** (credentials passed as RPC params to
  `authenticate()`), never ambient/cookie. This is exactly the design: identity crosses via the
  `authenticate` call, not the transport (D7). The library doc-comment warns to use
  `newWebSocketRpcSession`/`newHttpBatchRpcSession` directly if you _don't_ want open CORS.
- **capnweb `RpcTarget` IS the `cloudflare:workers` `RpcTarget`** — the same tree is reachable
  in-worker as `env.ITX` (Workers RPC) and on the wire over capnweb, and stubs from either
  interoperate. This is _why_ a `remote` source and a `local` source are indistinguishable to a
  caller. _(kernel-review §"capnweb `/api` shape"; clean-room `kernel.ts` header comment.)_
- **Promise pipelining**: you can call methods on an unresolved returned stub, and the whole path
  (`session.projects.get(id).ai.generate(...)`) is sent as one message — no round trip per hop. This
  is what makes a `remote` capability source cheap despite living across an ocean.
- **HTTP-batch is one-shot per request; the bidirectional WebSocket is a held, stateful session.**
  For chatty cross-account work you open a persistent WS and RPC through it (R11/D4), _not_
  HTTP-batch-per-call. Our lint `iterate/no-capnweb-http-batch` forbids HTTP-batch in source for this
  reason. _(self-hosting-plan Part H.)_
- **Vacuous rejects**: a rejected capnweb promise can pass through without surfacing; wrap awaited
  cross-account stubs so a dropped session errors rather than hangs. _(codebase memo.)_

**Cloudflare Workers RPC / bindings — the account boundary (the reason the tree must be sourceable):**

- **Workers RPC (service bindings) cannot cross Cloudflare account boundaries.** Same-account only.
  Cross-account chatty RPC ⇒ capnweb over a WS (R11). _(self-hosting-plan R11/D4; confirmed by CF
  service-binding docs — same-account.)_
- **Durable Objects, KV, and R2 bindings are same-account too** — every binding config shape (R2
  `bucket_name`, KV `namespace_id`, DO `class_name`/`script_name`) resolves _within one account_; none
  carries an account id (CF Wrangler config + R2/KV/DO binding docs). Reaching another account's data
  means either (a) going through _that account's worker_ (its ITX tree over capnweb) — the `remote`
  source — or (b) the **public REST API** `api.cloudflare.com/client/v4/accounts/<other>/…` with an
  **API token scoped to that account**, which traverses the network. This is why "data at rest in
  your account" (R7) requires the runner to live in your account, not merely a binding — and why
  cross-account **provisioning** (M6) is a REST-API script holding the customer's token (D3), not a
  binding.
- **`globalOutbound`** routes _every_ outbound `fetch`/`connect` from a (loaded) worker through a
  designated fetcher — this is the enforced egress choke point, workerd-level, no bypass. The kernel
  binds the _same_ `ProjectEntrypoint` object as both `env.ITX` and `globalOutbound` so the door
  shares the project's capability context. _(kernel `kernel.ts:319–330, 371–379`; review #7/#8.)_

**Worker Loader / confinement:**

- The **Worker Loader** (`env.LOADER.get(id, () => ({ mainModule, modules, env, globalOutbound }))`
  caches the isolate warm by `id`; `env.LOADER.load(code)` is the one-shot, no-cache variant) runs
  each config worker in an isolate seeing exactly the `env` you pass (here only `ITX`); `props`
  (`{ projectId }`) are unforgeable to it. `globalOutbound` scopes egress — set it to a Service
  binding to intercept all `fetch`/`connect`, or `null` to **block egress entirely**. The loader
  cache key includes a **hash of the config source** so a config change is a new isolate. Caveat:
  "two requests are _not_ guaranteed the same isolate" — durable state must live in a DO/KV, never in
  isolate memory. _(kernel `kernel.ts:192–197, 366–379`; review #12/#13 — capturing warm
  `ctx.exports` stubs in the loader `env` is the CF-sanctioned pattern; CF Dynamic Workers docs.)_
- **Workers-for-Platforms dispatch namespaces** are the account-scoped alternative for
  account/tenant-per-project (radical option 3); Worker Loaders are the in-worker sandbox we use
  today.

**Cloudflare for SaaS / Access / AI:**

- **Cloudflare for SaaS custom hostnames**: customers `CNAME` their domain to your zone; a single
  proxied (or **originless**, e.g. `AAAA 100::`) **fallback origin** + a Workers Route `*/*` routes
  all custom-hostname traffic into your worker (CF-for-SaaS "worker as origin" docs). Pay-as-you-go
  supports up to **50,000** custom hostnames. This is how custom domains work _even fully hosted_
  (R6). But the plan deliberately **decouples routing from CF-for-SaaS**: ingress only needs the
  request to reach our worker and a KV entry saying which project (R6/D8), so self-host isn't tied to
  enterprise CF-for-SaaS.
- **Cloudflare Access** injects `Cf-Access-Jwt-Assertion` at the edge; the kernel verifies it against
  the team JWKS `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (issuer + audience/AUD).
  Access scoped per _app hostname_ is what lets `dashboard--*.you.com` demand login while
  `*.you.com` stays public — no kernel change. Access's **Linked App Token** (App A forwards its
  assertion in `Cf-Access-Token` to App B, re-scoped to B's AUD) is prior art for the _mutual
  cross-account credential_ the lattice needs (D13, OQ-c). _(kernel README "selective Access";
  `wall.ts`.)_
- **AI Gateway** sits in front of model providers; BYO provider keys live in **Cloudflare Secrets
  Store** (`ai_gateway` scope), referenced by config and passed via `cf-aig-authorization`, with
  per-route rate/budget limits. The **universal endpoint** (`/ai/run`, `/ai/v1/chat/completions`,
  `/ai/v1/messages`) reaches OpenAI/Anthropic/Google/Workers-AI through one API with **unified
  billing** — no per-request provider key. Note: the plain `AI` binding does **not** support BYOK for
  third-party models; that path is the gateway/universal endpoint. `ITX.ai` holds _which_ gateway +
  key as capability metadata (R5), which is why `ai` can be sourced from our account
  (volume-discounted, metered — R9/D5) independently of where data lives.

**Our current code (what we build on, not over):**

- The `/api` capnweb door **already is** a project runner exposing its ITX tree:
  `UnauthenticatedOsRpcTarget.authenticate()` → confined tree (`rpc-targets.ts:6108`), served over
  WS. Two credential lanes already exist — the born **`project-secret` API key** (machine↔machine,
  verified in the Secret DO) and **`project-app-session`** (on-behalf-of, 15-min HS256, local verify).
  The genuinely new bits for the lattice are a **mutual** cross-account credential and a **pinned,
  long-lived** session (D13). Do **not** resurrect the removed `remoteCapability` mount without
  re-reading #2156. _(self-hosting-plan Part H.)_
- Today's built-ins are hardcoded getters that **always shadow** dynamic mounts
  (`rejectBuiltinCollision`, "the built-in always wins", `rpc-targets.ts:4114`). The migration to a
  sourced tree is already prototyped by `integrations` (a hardcoded branch and a provided
  `itx-expression` mount sharing one address shape). The `capability-host` mechanism
  (`resolveLongestPrefix`, `provideCapability`, `live` vs `itx-expression`) is the existing engine a
  sourced tree can lean on. _(core-boundary.md; core-model-grounding §A.)_
- The durable log is the first real runtime piece to build as `ITX.streams` (M4); `processEvent` is a
  stub in both the POC config worker and — historically — apps/os. Everything else is plumbing until
  it exists. _(clean-room-status §5; self-hosting-plan M4.)_

---

## 6. Three radical reshapings

Three architectures that are _genuinely different_ from the proposal above, each with a pitch and the
one trade-off that decides it.

### R1 — Log-centric: there is no RPC tree; the only primitive is the durable log

**Pitch.** Delete the capability tree. The one primitive is the append-only stream. A "capability" is
a **processor subscribed to a request stream**: `ITX.ai` is not a method — it is
`streams.get("/cap/ai").append({ type: "llm-request", … })`, and _some_ processor (sourced from
whatever account) folds it and appends `llm-response`. Cross-account is `acceptCrossPost` between
logs. Sourcing a capability = choosing whose account runs the processor subscribed to that stream.
Everything — agent, egress, ai, scheduler — is the same shape: append a request event, await a
response event. Audit, replay, provenance (appended-by-actor, per the identity doc) are _native_
because everything already is an event.

**Key trade-off.** Uniform, async, non-blocking, and audit-native — but request/response ergonomics
become awkward, and latency-sensitive streaming (LLM tokens, a synchronous egress that must return a
response body) fights a model built for eventual folds. You trade the ITX tree's directness for total
uniformity.

### R2 — Object-capability web: no sessions, no service bindings — every capability is a signed URL

**Pitch.** Drop both service bindings _and_ held capnweb sessions. Each capability is a
**URL-addressable, signed, attenuated capability** (the proven `use-my-computer` /
URL-addressable-capabilities pattern): `sources.ai` is `https://ai.iterate.com/cap/<opaque-sealed
-token>`, dialed on demand with a plain `fetch`. Sourcing is just _which URL_ you were handed; a
customer swaps `ai` by pasting a different capability URL. Cross-account is inherent — a URL doesn't
care about account boundaries — and there is no socket to keep alive. Confinement + attenuation live
in the sealed token, not in the binding.

**Key trade-off.** Maximally decoupled and stateless — but you lose promise pipelining and stateful
stubs, so chatty capabilities (a stream fold, a multi-step agent turn) become many independent HTTP
round trips, and revocation/rotation of long-lived capability URLs is its own hard problem.

### R3 — Account-per-project via Workers for Platforms: the control plane is a switchboard

**Pitch.** Take Jonas's "future model: a Cloudflare account per project" to its logical end _now_.
The control plane becomes a thin, stateless **Workers-for-Platforms dispatch switchboard**:
hostname → dispatch a **user worker** (the runner) in a per-tenant dispatch namespace, or literally a
separate account per project. iterate's account holds _only_ routing + billing + the shared `ai`
gateway; the runner holds everything else. Cross-account capnweb exists only at the two seams (ai in,
egress out). Isolation is by _account_, the strongest firewall there is; budgets are per-account and
enforced by Cloudflare, not by us.

**Key trade-off.** Maximal isolation and native budget control (exactly R10/D2 taken to the limit) —
but the provisioning and operational surface explodes: every project is an account/namespace to
create, deploy, meter, and garbage-collect, and _everything_ becomes cross-account, so the capnweb
session machinery moves from "level-2 feature" to "always on." You buy the strongest firewall with
the heaviest ops.

---

_End. The through-line: keep the kernel's spine, split the `apps/os` surface into a **sourced
capability tree**, and let `APP_CONFIG` decide — per capability — whether each subtree is a local
binding or a remote capnweb stub. Do that, and hosted, BYO-account, self-host, home-assistant, and
account-per-project are all the same code with a different source table._
