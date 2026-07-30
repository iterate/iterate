# opus-lattice — one interface, four rungs

_An architecture proposal for the iterate kernel + control plane + project runner. Grounded in the
clean-room POC (`apps/kernel`) and today's `apps/os`. North star: the cross-account self-hosting
**lattice** — one uniform ITX/`/api` interface makes hosted, BYO-account, full-self-host, and
local-container **the same system**, and a project moves between rungs with config + a script, never a
code change._

---

## 1. The proposal

### 1.1 The whole thing in one breath

There are **two workers and one interface**.

- **Control plane** — knows about _many_ projects. Ingress (hostname → project), the routing table
  (KV), the wall (auth verification), the directory (registry + membership), the dashboard, and — when
  we're the billing counterparty — the outer egress + metering door. **One per deployment.**
- **Project runner** — knows about _one_ project. It **is** the ITX capability tree
  (`ProjectWorkerEntrypoint`): `authenticate → session → projects.get → streams / secrets / ai / repos /
fetch`. Confined. **No wall in front of it** — it derives identity from what it's handed. Reachable
  as a default-export worker at `/api` (capnweb) **and** as a Workers-RPC entrypoint (`env.ITX`).

Everything — the dashboard, the control plane, a browser, an MCP client, a sibling capability, a
home-assistant box — reaches a project runner through **that one interface**. What changes between
deployments is never the code; it is (a) the **transport** the interface rides, and (b) two JSON knobs
(`wall`, `directory`) plus the **source of each capability**.

> The unification, stated as an invariant: _the caller never knows, and never needs to know, whether the
> project runner is a service binding in this account, a WebSocket to another account, or a laptop behind
> NAT. It calls `session.projects.get(id).streams.get(path).append(e)` and the transport is a deployment
> fact._

### 1.2 The four transports of one interface

The interface is fixed. Only how bytes cross the gap changes:

| rung                             | where the runner lives                              | transport                                                                    | who dials whom                                                                    |
| -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **same-account**                 | our (or your) CF account, next to the control plane | **Workers RPC** (service binding, `env.ITX`, `WorkerEntrypoint`/`RpcTarget`) | in-process; no network                                                            |
| **cross-account (both cloud)**   | your CF account; control plane in ours              | **capnweb over WebSocket** to your `/api`                                    | control plane dials the runner                                                    |
| **local / NAT (home-assistant)** | your laptop / Pi in Miniflare, behind NAT           | **capnweb over WebSocket, runner-initiated**                                 | the _runner_ dials **out** and holds the session; inbound HTTP routes **down** it |
| **browser / MCP**                | any runner, reached from a client                   | **capnweb over WebSocket** to `/api`                                         | the client dials in with a `project-app-session`                                  |

This works because **capnweb is a re-implementation of Workers RPC that is transport-agnostic and
bidirectional** (§5.1). A `Session`/`Project`/`streams` object is an `RpcTarget` in both worlds — the
_same class_. So "cross-account" is genuinely "the same call, a different socket," not a parallel code
path. This is exactly what `apps/kernel` already does: `newWorkersRpcResponse(request, new Os(...))`
serves the tree, and `apps/tasks`'s `ProjectDial` already dials it back over a WebSocket and calls
`os.authenticate(cred).projects.get(id)` (§5.4).

### 1.3 The fractal: a capability is sourced through the _same_ interface

The lattice's elegance is that **the control-plane→runner edge and the runner→capability edge are the
same edge**. A project's ITX tree is a set of capabilities (`ai`, `repos`, `streams`, `secrets`,
`egress`). Each capability is **either a local binding or a remote stub reached by the same capnweb
dial**. So:

```
control plane ──(transport)──► project runner ──(transport)──► ai (our account, discounted)
                                              └──(transport)──► streams (your account)
                                              └──(local binding)─► secrets (this account's DO)
```

Every arrow is the identical mechanism (Workers RPC when same-account, capnweb WS when not). "Source
`ai` from us and `repos` from you" is not special wiring — it is **one capability node whose transport
is a dial instead of a binding**. This is why the monolithic RPC targets must break into a _sourced
capability tree_ (plan R5/M3): the tree becomes the config surface, and the lattice falls out for free.

### 1.4 The two authorities (unchanged from the POC — keep them)

Identity stays exactly the clean-room shape, because it is already right:

- **`wall`** — _who authenticated you_. The kernel does **no login**; it verifies a JWT some ingress
  wall (Cloudflare Access, an auth.iterate.com forward-auth proxy, Caddy) injected on a header. `~47
lines` (`apps/kernel/src/wall.ts`). No wall ⇒ wide open. Cloudflare Access and auth.iterate.com are
  the _same code, different `WallConfig`_.
- **`directory`** — _which projects exist + who's a member_. Two real modes: **`kv`** (single-tenant
  self-host, a local KV registry, no auth worker) and **`auth.iterate.com`** (multi-tenant SaaS, over a
  same-account `AUTH` service binding), plus **`open`** as the zero-config default. Collapse `local`
  (a test fixture). **The registry half of the directory _is_ the ingress routing table** — same data,
  two uses.

The wall belongs to the **control plane**; the runner has no wall (plan D7). Identity crosses the
boundary as data — a verified caller published into the tree, or a minted `project-app-session`.

### 1.5 The bundle invariant (the north star)

**One platform bundle, byte-for-byte identical across every deployment.** Hosted vs self-host is
`APP_CONFIG` + secrets, never a fork. This is not aesthetics: an identical bundle is edge-cached
everywhere, so cold starts are ~free. It forces the two design rules that make the whole lattice
possible:

1. **No deployment-specific behavior compiled in** — differences are config.
2. **Runtime capabilities live in the platform worker behind ITX, not in userspace** — the LLM door,
   the durable log, egress. Userspace config workers stay thin and call _into_ them (`ITX.ai`,
   `ITX.streams`). That is _also_ what lets a capability be re-sourced to another account without
   touching project code.

CI asserts `sha256(hosted) == sha256(selfhost)` (M0). Per-project **config workers** are the user's
code and are loaded dynamically (Worker Loader), so they never break the invariant.

### 1.6 The concept count (deliberately tiny)

Two workers · one interface (the ITX/`/api` capnweb tree) · two transports (Workers RPC · capnweb WS) ·
two authorities (wall · directory) · one confinement primitive (Worker Loader + props) · one egress
door · one narrow token (`project-app-session`) · one machine key (born `project-secret`). Nothing else.
The lattice is not new machinery; it is **these pieces placed on either side of an account boundary**.

---

## 2. Scripts

Placement is a free matrix, so the scripts are the thing that _moves a project_ on it. Each is a normal
TypeScript CLI (per `docs/cli-scripts.md`), Doppler-scoped per env.

- **`pnpm deploy --env <name>`** _(exists — keep)_. Build the **identical** platform bundle → `wrangler
deploy` with atomic secrets → smoke. Ships the `+2` compiler sidecars (typechecker, worker-bundler)
  first, then OS. Self-host and hosted run the _same_ script; only the Doppler config differs.

- **`assert-identical-bundle`** _(M0, new — CI gate)_. Build with the hosted profile and a self-host
  profile; `sha256` both platform bundles; fail on inequality. This is the invariant that stops drift
  and must land first.

- **`provision --account <cf-api-token> --env <name>`** _(M6, new — the cross-account
  `ensure-resources`)_. The Alchemy-v2 / preview-env-style script (plan D11). Given a customer's
  Cloudflare API token, **idempotently** create in _their_ account everything a runner needs and return
  the identifiers the control plane must hold:
  - KV namespaces (`DIRECTORY_KV`, routing/`PROJECT_DIRECTORY`, `WORKER_BUILD_CACHE`);
  - DO namespaces + migrations for the runner's DO classes (streams, secrets, capability host, …);
  - R2 buckets (artifacts, files, backup);
  - the `worker_loaders` binding (confinement);
  - routes + wildcard DNS + Total TLS for the project hostname base; and, if serving customer domains,
    the Cloudflare-for-SaaS **fallback origin** + `custom_hostnames` wiring (§5.6).
    Idempotent means "ensure," not "create" — re-runnable, converging. Output is a small JSON descriptor
    (namespace ids, route ids, worker name) the control plane persists.

- **`link --project <id> --runner <origin> --account <cf-api-token?>`** _(M5/M7, new — bootstrap the
  cross-account edge)_. Establish the **mutual** credential and the **pinned session**, the two genuinely
  new bits (plan D13). It: (1) mints/stores the runner's born `project-secret` so the control plane can
  authenticate _as the project's machine_ to the runner; (2) issues the runner a control-plane **Access
  service token** (`CF-Access-Client-Id/Secret`) so the runner can authenticate _to us_ when it dials
  out; (3) writes the `hostname → { projectId, runnerOrigin, transport }` entry into the control-plane
  routing KV. After `link`, ingress can route down the correct transport with no further config.

- **`pnpm dev`** _(exists — the floor of the ladder)_. Miniflare, wide open (no wall) + a local `kv`
  directory, zero external deps. `wrangler login` supplies the account for cloud-only capabilities
  (`ITX.ai`); a truly-offline build uses only local capabilities. Restart-on-crash, not HA — explicitly
  a supported low-stakes _tier_ (a home-assistant container), not just dev sugar.

- **`migrate --capability <name> --from <acct> --to <acct>`** _(M8, sketch — mechanics parked, D10)_.
  Move a stream/R2/repo capability's data between accounts and repoint its source. The point of the
  lattice is that this is **the only thing that changes** — project code is untouched.

Rough order mirrors the plan: `assert-identical-bundle` → `pnpm dev`/`deploy` (rungs 0–1) → `provision`
→ `link` → `migrate`.

---

## 3. Main stories (end-to-end)

Throughout, `os` = the `UnauthenticatedOs`/`Os` capnweb root; `session = os.authenticate(cred)`;
`project = session.projects.get(id)`.

### (a) Create a project

Browser (or CLI, or MCP) dials `/api`, `os.authenticate(...)`, then
`session.projects.get("acme").create({ organizationSlug })`. On an unknown slug, `projects.get` returns a
**prospective** handle whose `create()` births it through **whichever directory is configured** — the
same call in both modes (`auth.createProjectForOrganization` hosted; a `project:acme` KV write
self-host). The routing table gets its `acme.<base> → { projectId }` entry at create — **registry and
router are the same write** (plan R13). Proven live in the POC against `auth-prd` (`kernel-poc-1`).

### (b) Hosted serving (rung 1)

HTTP hits `acme.iterate.app`. Control-plane ingress resolves `{ projectId, app }` (`resolveIngress`),
verifies the wall JWT if present, then runs the **confined config worker** via the Worker Loader, handed
**one props-scoped `ProjectEntrypoint` as both `env.ITX` and `globalOutbound`**. Same account ⇒ the
interface is a **Workers RPC** call, no network. `dashboard--acme.iterate.app` is kernel-reserved: served
directly (never via the config worker) so a broken config worker can't lock you out; the control plane
mints a narrow `project-app-session` and proxies to the dashboard vessel. Custom domains work _even fully
hosted_ via Cloudflare-for-SaaS (§5.6).

### (c) Self-host, your own domain (rung 3)

`pnpm deploy --env selfhost` puts the **identical bundle** in your account with `APP_CONFIG = { hostBase:
"you.com", wall: <Cloudflare Access>, directory: { provider: "kv" } }`. Wildcard `*.you.com` + Total TLS.
Projects at `foo.you.com`, dashboards at `dashboard--foo.you.com`; Access scoped per app-hostname keeps
`foo.you.com` public while gating the dashboard (proven live: `demo.shiterate.com → 200`,
`dashboard--demo.shiterate.com → 302`). Ingress "only cares that the HTTP request reached the worker and
a KV entry says which project it is." You own upgrades (`git pull && pnpm deploy`, plan D9).

### (d) BYO-Cloudflare account — our control plane, YOUR data (rung 2, _the product_)

You run `provision` with your CF API token; we run `link`. Now:

1. HTTP hits **our** ingress at `acme--you.iterate.app`. We verify the wall, resolve the routing entry:
   `transport = capnweb, runnerOrigin = <your account's worker>`.
2. The control plane **dials your runner's `/api` over a persistent capnweb WebSocket**, authenticates as
   the project's machine (`{ type: "project-secret" }`), and calls the interface — `project.fetch(request)`
   for HTTP, or `project.streams…` for data. Cross-account, but the _same interface_.
3. Your runner reads/writes **your** streams/R2/DOs; the response flows back down the socket and out our
   edge. Some capabilities (`ai`, discounted-3p) are sourced from **us** (§(g)); storage is **yours**.
4. **We are the HTTP edge, never the store** (plan R7): request/response and even **webhooks** transit us
   but are never durably stored — the control plane holds only _routing state_ + a short-TTL buffer.
   Data-at-rest lives only in your account.

The provable claim: run a rung-2 project, assert all data-at-rest (incl. webhook payloads) is in the
customer account and **nothing durable** in ours.

### (e) Local `pnpm dev` / home-assistant runner behind our control plane (data never leaves)

Your Pi runs `pnpm dev` (Miniflare) behind NAT. It can't be dialed _into_. So the **runner dials out**:
on boot it opens a WebSocket to our control plane and, over that capnweb session, **passes us a stub of
its own ITX tree** (capnweb lets the dialing side be called into — §5.1). We hold that stub. When HTTP
arrives at `home--you.iterate.app`, ingress finds `transport = pinned-link` and **calls down the held
session** — `runnerStub.fetch(request)`. The request executes on your Pi; **data never leaves the box**.
Cloud-only capabilities (artifacts, Workers AI) are sourced from _our_ account back up the same fabric;
purely local capabilities stay local. Reliability is restart-on-crash: if the Pi drops, the link
re-establishes on reconnect. This is `ProjectDial` inverted — the runner is the dialer, the control plane
the holder.

### (f) MCP connect → emerge with a project

An MCP client authenticates through the **same wall** — Managed OAuth injects a JWT the 47-line verifier
checks; permissions come from the directory, exactly like a browser. The MCP surface is just another
caller of `/api`: `os.authenticate(<mcp jwt>)` → `session.projects.list()` / `.get(id).create()`. "Emerge
with a project" = `projects.get(newSlug).create({ organizationSlug })` over that authenticated session —
identical to story (a), different front door. No MCP-specific auth stack.

### (g) Agent LLM call via ITX

Userspace (an agent processor / config worker) calls `itx.ai.run(model, messages)`. `ai` is a **platform
capability**, not compiled into the project. Its **source** is a config fact:

- rung 1/3: a local binding to the account's Workers-AI / AI-Gateway endpoint;
- rung 2: a **remote stub** — the runner's `ai` node is a capnweb dial to _our_ control-plane `ai`, which
  fronts AI Gateway with our key (volume-discounted, metered). The agent code is identical; only the
  capability's transport differs. AI Gateway is reached over HTTPS + bearer, so it crosses accounts
  cleanly (§5.7) — unlike an RPC binding, which cannot.

### (h) Two-level egress across accounts

A project's outbound is always funneled through **one door** — `globalOutbound` = the project's
`ProjectEntrypoint.fetch` (workerd routes _every_ sandbox `fetch`/`connect` through it). In rung 2 that
door is the **inner** door (secret-substitution, per-project policy) in _your_ account; it then hops to
the **control-plane egress door** in _our_ account (across the boundary over capnweb/HTTP), where our
metering/approval/billing policy sits because we're the counterparty. Two doors, chained, same shape:
inner = project policy, outer = platform policy. Neither stores payloads.

---

## 4. Difficulties & trade-offs

- **Cross-account latency.** Workers RPC in-account is a zero-network call; a capnweb WS hop to another
  account is a public-internet round trip. Mitigations: (1) **persistent** sessions, not HTTP-batch-per-
  call — dial once, reuse (plan D4/R11); (2) **promise pipelining** — `projects.get(id).streams.get(p).
append(e)` resolves in _one_ round trip even chained (§5.1/5.2); (3) source chatty/latency-sensitive
  capabilities locally and only cross the boundary for the ones that must live elsewhere. Trade-off: rung
  2 will always be slower than rung 1 on the crossing hop; the design makes the crossing _rare and
  batched_, not free.

- **The persistent stub can't be a naive Workers-RPC stub.** Workers RPC stubs **cannot be persisted past
  an execution context** (§5.3) — fatal for a pinned control-plane↔runner link. This is _why_ the link is
  **capnweb over a real WebSocket**, held by a Durable Object (the natural home for a long-lived socket +
  hibernation), redialed on failure — exactly the `ProjectDial` "redial once on stale" discipline (§5.4).
  Trade-off: we own connection lifecycle (heartbeats, backoff, eviction recovery) ourselves.

- **Auth across the boundary is mutual, and today's lanes are one-directional.** Each existing lane is a
  client presenting to a server (`project-secret`, `project-app-session`). The link needs **both ends to
  trust each other**: the runner authenticates to us (Access service token) _and_ we authenticate to the
  runner (its born `project-secret`). Building this on the existing `/api` door + two lanes (plan D13) is
  far less risky than resurrecting `remoteCapability` (removed in #2156 for good reasons — §5.8).

- **NAT / home-assistant inverts who dials.** Behind NAT nobody can reach the Pi, so the runner must dial
  out and be _called into_. This only works because capnweb sessions are bidirectional (§5.1). Trade-off:
  availability is the runner's — if the box is off, the project is off (restart-on-crash, not HA).

- **Provisioning is a trust handoff.** Rung 2 requires the customer's **Cloudflare API token** (plan D3)
  — no finer scoping yet. The `provision` script must be idempotent and least-privilege in what it
  creates. Trade-off: we hold a powerful credential to their account; mitigate by scoping the token and
  storing only the returned resource ids, not the token.

- **Directory drift vs the routing table.** Registry and router are the same data, but in rung 2 the
  _directory_ (membership) is ours while _data_ is theirs — the routing entry must be authored at create
  and kept consistent through moves. Control-plane-owned routing (plan D8) keeps this a single owner.

- **Bundle-identical vs per-account resource ids.** The bundle is identical, but resource ids
  (namespaces, routes) differ per account. Those live in `APP_CONFIG`/secrets/`envs.ts`, never in the
  bundle — the discipline that keeps M0 green while `provision` varies everything around it.

---

## 5. Fragments of knowledge (load-bearing, cited)

### 5.1 capnweb is bidirectional and transport-agnostic — the whole lattice rests on this

- "Supports bidirectional calling. The client can call the server, and the server can also call the
  client." A party passes a function or an `RpcTarget`; the peer receives a **stub** and invoking it calls
  back to the origin. → the NAT'd runner dials out yet is _called into_.
  ([github.com/cloudflare/capnweb](https://github.com/cloudflare/capnweb),
  [blog.cloudflare.com/capnweb-javascript-rpc-library](https://blog.cloudflare.com/capnweb-javascript-rpc-library/))
- Works over "HTTP, WebSocket, and `postMessage()` out-of-the-box" — **not tied to Cloudflare account
  boundaries**; any two parties over the public internet. (same)
- **Promise pipelining**: an `RpcPromise` is a stub for the eventual result; chained dependent calls
  resolve "in a single network round trip." → cross-account chattiness collapses to one hop. (same)
- `RpcTarget` = pass-by-reference; the peer gets a stub whose methods/getters are callable. A stub "can be
  passed across RPC again, including over independent connections." → capabilities pass in both
  directions, recursively. (capnweb README)

### 5.2 Workers RPC — the same shape, in-account, zero-network

- Public `WorkerEntrypoint` methods "can be directly called by other Workers **on your Cloudflare
  account**." Service bindings "send HTTP requests to another Worker without those requests going over the
  Internet."
  ([Service bindings RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
  [Wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/))
- I/O supports functions (→ callback stubs), `RpcTarget` classes (→ stubs), streams, and
  `Request`/`Response`; promise pipelining is native.
  ([Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/))
- Same-account face: `apps/os` uses `env.ITX` / `WorkerEntrypoint` in one script (no cross-script DO, no
  service bindings between OS pieces); the POC binds one `ProjectEntrypoint` as both `env.ITX` and
  `globalOutbound`.

### 5.3 The hard limits that _force_ the design

- **RPC cannot cross Cloudflare accounts** — service bindings are same-account only (§5.2). → any
  cross-account edge must be HTTP/WebSocket over the public internet.
- **RPC stubs cannot be persisted past an execution context**: "A proxy connection cannot be persisted
  for later use"; a client Worker "is considered to have disconnected when its own execution context
  ends." ([RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)) → the
  pinned control-plane↔runner link must be a capnweb WebSocket held by a DO, not a stashed RPC stub.

### 5.4 Our own proven building blocks

- **The `/api` capnweb door = the project runner.** `newWorkersRpcResponse(request, new Os(...))`
  (`apps/kernel/src/kernel.ts:347`); `apps/os` serves the same via `newWorkersWebSocketRpcResponse` /
  `newHttpBatchRpcResponse` at `/api` (`apps/os/src/worker.ts:267-287`). WebSocket is the blessed
  transport (lint `iterate/no-capnweb-http-batch` forbids HTTP-batch in source).
- **`ProjectDial`** (`apps/tasks/src/checkout-do.ts:373-416`) already proves a **persistent, redial-on-
  stale** capnweb dial from a stateless worker: `fetch("/api",{upgrade:"websocket"})` → `socket.accept()`
  → `newWebSocketRpcSession<UnauthenticatedOs>(socket)` → `os.authenticate(cred).projects.get(id)`
  (pipelined), with "on any error, redial once" in `withProject`. This _is_ the cross-account link
  mechanism, minus the pinning + mutual credential.
- **Config-worker reverse proxy** (`apps/tasks/src/config-bridge.ts` `TasksApp.create`): member-gate
  (`itx.auth.get(policy).fetch(request)`) → host-rewrite → `fetch()`. A **proxy, not a capability mount**
  — keeps the vessel credential-free and forwards the user's `project-app-session`.

### 5.5 The two credential lanes + the mint (reuse verbatim)

- **Born `project-secret`** — every project born with a readable `itxk_…` key at
  `/secrets/project-api-key` (`apps/os/src/rpc-targets.ts:5379`), verified **inside the Secret DO**
  (`secret-durable-object.ts:509`, constant-time; material never leaves the DO; one-bit answer). Grants
  exactly one project, no admin, no user (`auth.ts`). The machine↔machine credential for the link.
- **`project-app-session`** — narrow, 15-min, per-project HS256 grant, verified locally
  (`apps/os/src/auth/project-app-session-token.ts`; POC `project-app-session.ts`). The front door mints
  it (`mintProjectAppSession`) so a project app acts _as_ the user without holding the user's session —
  `published()` strips raw tokens at the boundary (identity's "don't hand the sandbox raw bindings").

### 5.6 Cloudflare for SaaS — customer domains even when fully hosted

- Custom hostname points a customer's vanity domain at your zone; routed to a **fallback origin** (a
  proxied DNS record to your worker). Recommended CNAME target can be a **wildcard**
  (`*.customers.saasprovider.com`). Provision via the Create Custom Hostname API; ready when
  `status == active && ssl.status == active`.
  ([Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/),
  [getting-started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/))
- We already drive this: `apps/os/src/domains/projects/custom-domains.ts`
  (`createCloudflareCustomDomainProvisioner` → `/zones/{id}/custom_hostnames`, stamps
  `custom_metadata.projectId`, reconciles into `PROJECT_DIRECTORY` KV under `hostname:<host>`), plus the
  `*/*` SaaS catch-all route in `generate-wrangler-config.ts`. Ingress decouples from CF specifics: "it
  just matters the HTTP request reached the worker and a KV entry says which project."

### 5.7 Access JWT shape + AI Gateway (the cross-account auth + LLM facts)

- **Access**: user JWT on header **`Cf-Access-Jwt-Assertion`**; JWKS at
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; verify **RS256** with `iss =
https://<team>.cloudflareaccess.com`, `aud =` the app's **AUD tag**, plus `email`/`exp`. **Service
  tokens** (`CF-Access-Client-Id`/`CF-Access-Client-Secret`) are the machine lane — service-token JWT has
  `type:"app"`, `sub:""`. → the runner→control-plane auth in `link`.
  ([validating JSON](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
  [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/))
- **AI Gateway** unified REST API (`api.cloudflare.com/.../ai/...`, OpenAI- & Anthropic-compatible) reached
  over HTTPS + a Cloudflare API token → **works across accounts** (unlike RPC). BYOK stores provider keys
  in Secrets Store; Unified Billing enables discounted 3p access with no provider key. → `ITX.ai` sourced
  from our account, metered.
  ([AI Gateway REST](https://developers.cloudflare.com/changelog/post/2026-05-21-rest-api/),
  [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/))

### 5.8 Confinement + the removed `remoteCapability` (prior art, don't rebuild blindly)

- **Confinement** = Worker Loader (`worker_loaders`, `env.LOADER.get(id, () => ({modules, env:{ITX},
globalOutbound}))`) — each config worker its own isolate, sees only `["ITX"]`, props unforgeable;
  `globalOutbound: null` fully severs network.
  ([Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)) The
  strongest project↔project firewall is a **separate CF account per project** (plan) — architect for it,
  which the sourced-capability tree already enables.
- **`remoteCapability`** was a platform-side capnweb capability **mount** (expose a remote app's caps
  _into_ the ITX tree), added in #2148, **removed in #2156** for the HTTP reverse proxy (simpler,
  credential-free vessel, real-user attribution). Plan **D13**: build the link on the existing `/api`
  door + two lanes; add only (1) a mutual credential and (2) a pinned session; **re-read #2156 before
  resurrecting a mount.**

---

## 6. Three radical reshapings

Three architectures that discard a core assumption of the proposal above. Each is a genuine fork, not a
tuning knob.

### 6.1 "The link is the only interface" — delete the same-account fast path

**Pitch.** Stop maintaining two transports. The project runner is reached **only** over capnweb — even
same-account, even in `pnpm dev`. There is no `env.ITX` service-binding path; the control plane always
opens a WebSocket (loopback when local). One code path, one auth story, one lifecycle. The four "rungs"
collapse into "which URL do I dial," and cross-account stops being a special case because _everything_ is
already a dial.

**Key trade-off.** You pay the WebSocket/serialization cost even in-account where a zero-network RPC call
was free — measurably worse cold-start and per-call latency on rung 1 (the common case), to buy uniformity
you only strictly need on rungs 2–3. Bet: capnweb loopback is cheap enough that the simplification is
worth the tax. (Directly contradicts the plan's "same path, different transport" — here there's only one
transport.)

### 6.2 "Everything is the durable log" — the runner is a stream, not a tree of RPC targets

**Pitch.** Replace the `Os → Session → Project → capability` RPC tree with **one primitive: an append-
only event log per project** (`ITX.streams` as _the_ interface, not one capability among many). Every
action — create, auth, an LLM call, egress, a webhook — is an event appended to the project's log;
capabilities are **stream processors** that fold the log and emit effects. Cross-account isn't RPC-over-
capnweb; it's **log replication** between accounts (the customer's account holds the authoritative log;
ours holds a short-TTL tail for routing). "Move a project" = repoint which account the log lives in.
Self-host, BYO, local all become "where does the log live + who replicates it," and iterate's "edge never
stores" becomes literally true (we forward events, we don't retain the log).

**Key trade-off.** Everything becomes eventually-consistent and asynchronous — request/response HTTP
serving (the dashboard, a project website) fits awkwardly onto a log, needing a synchronous read-model
projection in front. You gain a stunningly uniform data model and trivially-correct "data in your account"
semantics; you lose the natural request/response ergonomics the RPC tree gives for free, and you must
solve log-replication consistency across accounts (the parked M8/OQ-e problem, now central).

### 6.3 "Account-per-project, no cross-account link at all" — provision, don't proxy

**Pitch.** Take the plan's "separate Cloudflare account per project is the strongest firewall" to its
limit and make it the _only_ model. There is **no persistent cross-account link and no two-level egress**.
Instead, the control plane is a thin **provisioner + DNS/router**: for each project it uses the customer's
(or a per-project) API token to deploy the _whole identical bundle_ into that project's own account, wires
Cloudflare-for-SaaS so `acme.iterate.app` resolves _directly_ to the project's own worker, and steps out
of the data path entirely. iterate holds only the routing table and billing metering (pulled from CF
analytics, not from proxying traffic). Rung 2 and rung 3 merge: BYO-account _is_ self-host, we just ran the
`provision` script for you.

**Key trade-off.** You lose first-party HTTP/webhook ingress and two-level egress — the very things that
make rung 2 "our convenience without our data-store" _and_ our metering point. Billing/first-party webhook
ingress must be re-solved without being in the request path (harder), and every project pays full cold-
start (no shared edge-cached multi-tenant worker). Maximal isolation and a dead-simple mental model
("every project is just a self-host we operate"), at the cost of the shared-edge economics and the
first-party-ingress product wedge the lattice was designed to keep.

---

_Grounding: `apps/kernel/src/{kernel,wall,directory,project-app-session,config-worker}.ts`;
`apps/os/src/{worker,rpc-targets,auth,env}.ts`, `apps/os/docs/{worker-topology,architecture-and-operations,
remote-apps}.md`; `apps/tasks/src/{checkout-do,config-bridge}.ts`;
`apps/os/docs/simplification/{self-hosting-plan,clean-room-status}.md`; and the cited Cloudflare / capnweb
first-party docs._
