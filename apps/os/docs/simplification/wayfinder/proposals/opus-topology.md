# Proposal — two workers, one capability tree: the control plane and the project runner

_One architect's complete proposal. Grounded in the clean-room kernel (`apps/kernel`, ~850 lines)
and the current `apps/os` monolith, and biased — per my brief — toward making the
**control-plane / project-runner split** and its **deploy + provision scripts** crisp and buildable._

---

## 0. The whole thing in one breath

There are **two workers and one tree**.

- **The control plane (`iterate-cp`)** knows about _many_ projects. It owns ingress
  (hostname → project), the **wall** (verify an injected JWT), the **directory/registry** (which
  projects exist, membership, and the ingress routing table), project birth, and the
  kernel-reserved **dashboard**. One per deployment. It holds _no_ project data.
- **The project runner (`iterate-runner`)** knows about _one_ project at a time. It **is** the ITX
  capability tree — `ProjectRunner` (`WorkerEntrypoint<Env, {projectId}>`) — exposed as a default
  worker with `/api` (capnweb) **and** the Workers-RPC equivalent. It holds the raw Cloudflare
  bindings (streams DO, R2, KV, AI, egress) and hands the confined config worker exactly one thing:
  `env.ITX`. **No wall in front of it** — it derives identity from what it is handed
  (props, or the `authenticate()` call), because the wall is a control-plane concern (D7).

The **one tree** is the unification. Everything reaches a project through the _same_ code path —
`authenticate() → session → projects.get(slug) → Project → project.<capability>.get(path)`. What
changes is only the **transport** and **who vouched for the caller**:

| door                | transport                                      | caller established by                  |
| ------------------- | ---------------------------------------------- | -------------------------------------- |
| in-worker `env.ITX` | Workers RPC, 1 isolate hop, same account       | stamped by the control plane (trusted) |
| `/api`              | capnweb over WebSocket                         | `authenticate({...})`                  |
| `/mcp`              | capnweb-behind-MCP                             | wall JWT via Managed OAuth             |
| **cross-account**   | **persistent bidirectional capnweb WebSocket** | a mutual cross-account credential      |

Because "cross-account" is _just a different transport onto the same tree_, the placement matrix is
free (Part B of the plan): control-plane {ours} × runner {our account · your account · per-project
account · your container}. Same tree, dialed differently.

This is deliberately close to what exists today: `apps/os/src/rpc-targets.ts` already has
`UnauthenticatedOsRpcTarget → Session → projects.get → Project` served over capnweb at `/api`, and
the clean-room kernel already proves confinement + the wall + the directory in ~850 lines. **The
proposal is mostly a _cut_, not a rewrite**: draw the seam between "knows about many projects"
(control plane) and "is one project's capability tree" (runner), and make that seam a network
boundary you can stretch.

---

## 1. The proposal — components, workers, and how they bind

### 1.1 The control plane worker (`iterate-cp`)

A pure-play worker (no nodejs_compat, so it edge-caches everywhere and runs in Miniflare on a Pi —
R1/R3). It is the clean-room kernel's `default { fetch }` router, promoted to its own deployable.
Per request:

1. **Ingress.** `resolveIngress(host)` → `{ projectId, app }`. Two shapes, unified by a **routing
   table** (KV): (a) sibling namespace `<slug>.<base>` and `<app>--<slug>.<base>` (one `--` label so
   one wildcard cert covers it — see §5); (b) a fully custom hostname resolved via a KV lookup
   `hostname:example.com → { projectId }`. The clean-room `resolveIngress` (kernel.ts:169) does (a)
   today; (b) is the current `apps/os` `PROJECT_DIRECTORY` KV pattern (envs.ts already carries
   `hostname:iterate.com` entries and `ownedProjectCustomApexes`). **These are the same table** —
   the registry half of the directory _is_ the ingress router (R13). Routing table is always
   control-plane-owned (D8), no matter where compute/data live.
2. **Wall.** If `APP_CONFIG.wall` is set, verify the JWT the ingress wall injected on a header
   (`wall.ts`, ~47 lines: JWKS + issuer + optional audience). No wall ⇒ everyone anonymous
   (first-class, R3). Cloudflare Access and an auth.iterate.com forward-auth proxy are the _same_
   code, different `WallConfig`.
3. **Directory.** Resolve membership + registry through the configured provider (`directory.ts`):
   `kv` (single-tenant self-host) or `auth.iterate.com` (multi-tenant SaaS, over the same-account
   `AUTH` service binding), plus `open` as the zero-config default. **Collapse to these two real
   modes + `open`; delete `local`** (R13, clean-room §8).
4. **Reserved control surfaces served directly** (never via a project's config worker, so a broken
   config worker can never lock you out — R14): `/api` (the capnweb front desk), `/mcp`, OAuth
   callbacks, first-party webhook ingress, and the **`dashboard` app** (proxied to the dashboard
   vessel with a minted `project-app-session`).
5. **Everything else → the runner.** The control plane looks up where this project's runner lives
   and forwards the request down the correct transport (below).

The control plane holds **no `env.ITX`, no streams DO, no R2**. Its bindings are: `LOADER` (only in
the _collapsed_ single-account deployment — see §1.4), the routing/directory KV, the `AUTH` service
binding (hosted), `PROJECT_APP_SESSION_SECRET`, and a **runner locator** (how to reach each
project's runner: a service binding for same-account, or a dialed capnweb session for cross-account).

### 1.2 The project runner worker (`iterate-runner`)

This is the current monolith's centre of gravity — `ProjectWorkerEntrypoint` / the god-object
`rpc-targets.ts` — extracted and slimmed. It is the ITX capability tree and nothing else:

```ts
export class ProjectRunner extends WorkerEntrypoint<RunnerEnv, { projectId: string }> {
  // INBOUND handlers (the kernel/CP calls these):
  fetch(req); // run this project's confined config worker (via LOADER)
  processEvent(event); // deliver a committed stream event to the config worker

  // OUTBOUND capability tree (what env.ITX binds to, what /api serves):
  authenticate(creds?); // → Session → projects.get → Project → .<cap>.get(path)
  //   caps: streams, secrets, ai, repos, artifacts, browser, ai-search, egress(fetch), kv, mcp…
}
```

The runner holds the **raw Cloudflare bindings** (`RunnerEnv`: the stream/log DO namespace, R2, KV,
`AI`/AI-Gateway, the egress fetcher) and exposes them only as capabilities — the core-boundary
principle (core-model-grounding: _"raw bindings live in the kernel/runner; no project holds raw
bindings"_). It runs the confined config worker through `LOADER.get(...)`, handing it exactly
`{ ITX: projectEntry }` as both `env.ITX` and `globalOutbound` (the one egress door) — the
clean-room confinement, verbatim (kernel.ts:371-379). **Props (`{projectId}`) are unforgeable to
the sandbox — that is the confinement.**

Crucially the runner has **no wall and no ingress table**. It trusts its caller because of _how it
was reached_:

- Reached via **service binding** (same account): the control plane is trusted; it stamps the
  verified, secret-stripped caller as a header (`x-iterate-caller`) exactly as the clean-room does
  today (kernel.ts:388).
- Reached via **`/api` capnweb** (cross-account or external): the caller must present a credential
  to `authenticate()` — a `project-app-session`, the born `project-api-key`, or (new) the mutual
  cross-account credential.

This is why the runner **must** break out of the monolith (R5): once it is independently deployable
and reached identically wherever it lives, the placement matrix opens up.

### 1.3 The capability tree is the config surface (R5 — the structural unlock)

The single most important refactor: **break the god-object `rpc-targets.ts` (7,667 LOC) into a tree
of independently-sourced capabilities.** Today `ai`, `repos`, `artifacts`, `secrets`, `streams`,
`egress`, `browser`, `ai-search`, `kv` are ~30 hardcoded getters. Each should instead be a
**sourced capability**: a small descriptor saying _where this capability resolves_ —

```ts
type CapabilitySource =
  | { kind: "local"; binding: keyof RunnerEnv } // resolve from this runner's own account
  | { kind: "remote"; session: "control-plane" | Url }; // resolve over a capnweb session to another account
```

`itx.repos.get(x).clone()` hits **your** account if `repos` is sourced locally (private code stays
in your account); `itx.ai.run(...)` can still hit **our** account's AI-Gateway binding over the
persistent control-plane session (volume-discounted, metered — R9/D5). The capability tree becomes
the config surface, and every lattice transition (Part C) is _repoint one source_, never a code
change (R12). The `capability-host` mount mechanism to express this already exists in `apps/os`
(core-boundary §"built-ins → mounts"); this proposal says: use it for the built-ins too, and let a
source point _across an account boundary_.

### 1.4 How it all binds together — three physical shapes of the same logical system

The logical system is always CP + runner + one tree. Physically it collapses or stretches:

- **Collapsed (dev / Pi / M1 self-host).** One worker, both roles, `LOADER` in-process. This is the
  clean-room kernel exactly as it stands: `default fetch` (CP role) + `ProjectEntrypoint` (runner
  role) + config workers loaded inline. `pnpm dev` in Miniflare. No cross-account anything.
- **Split, same account (hosted, level 1).** `iterate-cp` + `iterate-runner` in our account, bound
  by a **Workers RPC service binding**. The CP forwards `req → runner.fetch(req)` and dials
  `runner.authenticate()` for `/api`. This is the pure "unify internal + external on one tree" step
  (D6): internal calls go through the same `ProjectRunner.authenticate` path so that later the _same
  path over capnweb_ works cross-account.
- **Stretched, cross-account (level 2 / level 3 / home-assistant).** `iterate-cp` in our account,
  `iterate-runner` in your account (or your container). They are bound by a **persistent
  bidirectional capnweb WebSocket** (R11/D4), because **Workers RPC service bindings cannot cross
  Cloudflare account boundaries.** For the NAT/home case the runner _dials out_ and inbound HTTP
  routes _down_ the held session (proven pattern: `apps/tasks` `ProjectDial` /
  `checkout-do.ts`, per plan Part H).

The bundle is byte-identical in all three (R1/M0) — only `APP_CONFIG` + which bindings are present
differ. Same code, config not fork (R4).

---

## 2. Scripts — the deploy & provision story (my north star)

Grounded in the existing `apps/os` script family (`envs.ts` is the SoT; each app has
`generate-wrangler-config`, `deploy`, `ensure-resources`, `erase-data`, driven by
`scripts/lib/env-context.ts`, `--env <name>`, Doppler for secrets). I keep that shape and add the
control-plane/runner and cross-account pieces.

**`envs.ts` stays the reviewed source of truth**, extended so a `DeployedEnv` names _both_ workers
and the runner's placement:

```ts
interface DeployedEnv {
  cloudflareAccountId: string;         // the CONTROL PLANE's account
  controlPlaneWorkerName: string;      // e.g. "iterate-cp-prd"
  runnerWorkerName: string;            // e.g. "iterate-runner-prd"
  runnerPlacement:                     // where the runner lives, per the lattice
    | { kind: "same-account" }                                   // L1: service binding
    | { kind: "cross-account"; accountId: string; dialUrl: Url } // L2/L3: capnweb session
    | { kind: "collapsed" };                                     // dev/Pi: one worker
  projectHostnameBases: string[];      // <slug>.<base> namespace (already exists)
  cloudflareForSaasProjectHostnameBases: string[]; // custom-hostname zones (already exists)
  resources: { routingKvId; workerBuildCacheKvId; authDbId; streamsDoMigrationTag; r2Bucket; … };
}
```

### The scripts

- **`deploy --env <name>`** (per app: cp and runner). Build → `generate-wrangler-config`
  (fills routes, bindings, `APP_CONFIG` from `envs.ts` + Doppler) → `wrangler deploy` with atomic
  secrets → smoke. **Ordering matters** (as today): the runner depends on the `worker-bundler`
  (and `typechecker`) sidecars, so those deploy first — name-binding a missing script fails
  (worker-topology.md). **Byte-identity gate (M0):** CI asserts `sha256(bundle | hosted config) ==
sha256(bundle | selfhost config)` for the runner _and_ the cp — the north-star invariant (R1).
  Workers are never deleted (existing rule).

- **`ensure-resources --env <name>`** (idempotent, as today). Creates whatever is `UNPROVISIONED`
  and prints real IDs to paste back into `envs.ts`: the **routing KV** (registry + hostname table),
  the worker-build-cache KV, the auth D1 (hosted), the **streams DO** migration + **R2 bucket** for
  the runner, and — for a custom-hostname zone — the **Cloudflare-for-SaaS fallback-origin catch-all
  route** (already an `apps/os` concern via `cloudflareForSaasProjectHostnameBases`). Deploy refuses
  to ship `UNPROVISIONED`.

- **`provision-account --account <id> --token <cf-api-token>`** (**new** — M6, the cross-account
  `ensure-resources`; D11 says assume "a script creates the stuff and returns identifiers"). Given a
  _customer's_ Cloudflare API token, use the Cloudflare REST API to idempotently create, **in their
  account**, everything a runner needs: KV namespaces, R2 bucket, the DO-bearing runner worker
  deploy, routes/DNS, and the AI-Gateway if `ai` is sourced there. Returns a `runnerPlacement`
  descriptor (accountId + dialUrl + resource IDs) that the CP stores in its routing table and that
  gets written to `envs.ts` for a managed customer. This is the Alchemy-v2 / preview-slot pattern
  pointed at someone else's account.

- **`create-project --env <name> --slug <s> [--org <o>] [--hostname <h>]`**. Calls the CP's
  `session.projects.get(slug).create({organizationSlug?})` — the _same_ capnweb call the dashboard
  and MCP use — which writes to the configured directory (auth-prd hosted, or local KV self-host),
  then writes the ingress routing entry (`<slug>` and/or `hostname:<h>`), and (custom hostname)
  registers the custom hostname with Cloudflare-for-SaaS. No new mechanism: project birth is one
  directory write + one routing write.

- **`self-host bootstrap`** (the getting-started script, R3/R3b). `wrangler login` → pick a domain
  with wildcard DNS → `ensure-resources` in _your_ account → `deploy` the collapsed worker with a
  `kv` directory and (optionally) a Cloudflare Access wall → open `controlplane.you.com` and
  `create-project`. Miniflare variant: `pnpm dev`, wide-open, local KV, zero external deps —
  restart-on-crash reliability (R3b), not HA.

- **`migrate --from <env> --to <env> --capability <streams|repos|…>`** (**parked mechanics, D10**;
  scaffold only). Repoint a capability source in `envs.ts` and move the underlying data
  (streams/R2/repos) between accounts. Requirement: **no project code changes** (R12/M8) — the
  script moves the lattice under the code.

**What a single deployment needs, concretely** (from `envs.ts` + `RunnerEnv`): control plane =
routing/registry KV + (hosted) `AUTH` binding + app-session secret; runner = streams DO namespace +
R2 bucket + KV + AI-Gateway + worker-build-cache KV + `LOADER`. Two accounts today (prd,
preview-and-dev); the lattice adds "customer account" as a third kind the provision script targets.

---

## 3. Main stories (end-to-end)

**(a) Create a project.** Browser/CLI/MCP calls the CP `/api`: `authenticate() → session →
projects.get("acme")`. Unknown slug ⇒ a _prospective_ handle; `.create({organizationSlug})` writes
through the directory (auth-prd or KV) and the CP writes the routing entry (`acme → projectId`, plus
any custom `hostname:` key). The project is born with a readable `project-api-key` at
`/secrets/project-api-key` (machine lane, already exists). No runner work yet — a runner is
project-agnostic and spun up on first request.

**(b) Hosted serving (L1).** `GET acme.iterate.app` → CP ingress resolves `{acme, app:""}` → wall
(none on the public host ⇒ anonymous) → CP forwards `runner.fetch(req)` over the **service binding**,
stamping the caller header. The runner `LOADER.get("project:acme:<hash>")` runs the confined config
worker with `env.ITX` = the project's capability tree. `dashboard--acme.iterate.app` → CP serves the
dashboard vessel directly with a minted `project-app-session` (never the config worker — R14).

**(c) Self-host your own domain (L3).** `self-host bootstrap`: `wrangler login`, `ensure-resources`
in your account, deploy the collapsed worker to `*.you.com` (wildcard route + Total TLS), `APP_CONFIG`
= `{hostBase:"you.com", wall: <your Access>, directory:{provider:"kv"}}`. `create-project foo` →
`foo.you.com` serves, `dashboard--foo.you.com` demands Access login. Identical bundle to hosted (R1);
you own your upgrades (`git pull` + `deploy`, D9).

**(d) BYO Cloudflare account (L2 — the product).** You give us a Cloudflare API token (D3).
`provision-account` stands up a **runner in your account** (KV, R2, streams DO, routes) and returns
its `runnerPlacement`. Our CP keeps ingress at `--acme.iterate.app` and the routing table, and dials
your runner over a **persistent capnweb session** (R11). `GET acme.iterate.app` → our CP → _your_
runner over capnweb → reads/writes _your_ streams → egresses back out through _our_ edge (two-level
egress). **Data at rest lives only in your account** (R7); our CP retains only routing + short-TTL
buffers. `ai` (and other discounted-3p capabilities) are _sourced_ from our account over the same
session, metered (R9/D5).

**(e) Local `pnpm dev` / home-assistant runner.** Collapsed Miniflare worker, wide-open, local KV —
the Pi floor (R3). Home-assistant mode is the interesting variant: our **CP + ingress + wall** in
our cloud, but the **runner is `pnpm dev` on your box behind NAT**. The runner **dials out** and
holds a bidirectional capnweb session with the CP; inbound HTTP for `you.iterate.app` routes _down_
that held session to your box, where data never leaves (D12). Cloud-only capabilities (artifacts,
Workers AI) are simply _sourced_ back from our account over the same session.

**(f) MCP connect → emerge with a project.** An MCP client hits the CP `/mcp`. Managed OAuth (the
same wall) injects a JWT the CP verifies; the MCP tools are the _same tree_ — `projects.get`,
`create`, capability calls — authorized by the directory exactly like a browser (clean-room §4). So
"connect over MCP and end up with a project" is just `create-project` reached through the MCP door.

**(g) Agent LLM call via ITX.** The agent is **userspace** — a stream processor in the config worker
(core-boundary: _the agent is userspace, not core_). It calls `this.itx.ai.run(model, prompt)`. The
runner resolves `ai` by its **source**: locally (its account's `AI`/AI-Gateway binding, `byok`
transport as in `envs.ts`) for L1/L3, or over the persistent control-plane session for L2 (our
gateway, metered). The config worker never sees a raw AI binding — only `itx.ai` (core-model-grounding
Sketch B). The load-bearing "makes the LLM request" piece is a platform capability, not compiled
userspace (clean-room §5).

**(h) Egress with a substituted secret.** The config worker's `fetch(...)` is routed through
`globalOutbound` — the runner's **one egress door** (`ProjectRunner.fetch`, kernel.ts:327). The door
looks up a secret from the runner's secret store, substitutes it into the outbound request (e.g.
`Authorization: Bearer <the real key>`), applies policy/approval/metering, and only then hits the
network. In L2 the door chains: project-egress-door → **control-plane egress door** (across the
account boundary over the session) — the metering/policy seam when we are the billing counterparty
(clean-room §6). The confined worker never holds the secret; substitution happens at the door.

---

## 4. Difficulties & trade-offs

1. **The runner extraction is the whole ballgame, and it's big.** `rpc-targets.ts` is 7,667 LOC of
   fused capability-provider + feature-host. The split (§1.3) is a gradual, tracer-bullet effort
   (`kv` first — 66 LOC, zero deps — then `ai`/`browser`/`files`, then `agents`/`integrations`).
   Risk: half-migrated, the "one tree" invariant leaks. Mitigation: keep `authenticate()` the sole
   entry and route _internal_ calls through it from day one, so the seam is exercised before it's
   stretched.
2. **Cross-account is a persistent WebSocket, with all that entails.** A held capnweb session must
   survive DO eviction/restart (proven-ish: `ProjectDial`), reconnect with backoff, and re-announce.
   Every cross-account capability call now has WAN latency + a liveness dependency the local binding
   never had. Chatty capabilities (streams subscribe) hurt most; pin what you can locally.
3. **Two-level egress doubles the hop and the trust.** L2 outbound crosses the account boundary
   twice (out through your door, out again through ours). Metering must reconcile across both; a
   compromised customer runner must not be able to forge the control-plane door's provenance. The
   mutual cross-account credential (Part H, "genuinely new") is load-bearing and unbuilt.
4. **The wall lives at our edge but compute is yours (OQ-c).** In L2, Access fronts
   `--acme.iterate.app` (our zone), but the verified identity must cross into your runner. It crosses
   as the stamped caller over the session — but that means your runner _trusts our CP's stamp_,
   which is exactly the mutual-trust credential again. Get this wrong and identity is forgeable.
5. **Wildcard certs cover one label only.** `*.you.com` covers `acme.you.com` and
   `dashboard--acme.you.com` (the `--` trick) but **not** `dashboard.acme.you.com`. This forces the
   `--` app convention and "no paths" (R6). Custom apex domains need per-hostname certs via
   Cloudflare-for-SaaS — real ACM quota, which preview zones lack (`envs.ts` notes this).
6. **Identical-bundle vs per-capability sourcing tension.** R1 wants one byte-identical bundle;
   R5 wants each capability sourced differently per deployment. Resolved by making _sourcing a
   runtime config value_ (the `CapabilitySource` descriptors come from `APP_CONFIG`/directory), not
   a compile-time choice — but that means the runner must carry code for _every_ source kind even
   when a deployment uses one. Acceptable; keeps the bundle stable.
7. **Directory collapse touches live auth.** Deleting `local` and renaming to single/multi-tenant is
   easy; the risk is that `auth.iterate.com` is the _only_ multi-user/org authority today (OQ-b) —
   self-host multi-user is unbuilt, so self-host is "project isolation + whoever's through your
   wall" until someone builds orgs for `kv`.
8. **Home-assistant mode is architecturally required but may never ship.** Holding it as a
   constraint shapes the design (everything cross-account is a dialed session, not a binding), which
   is _good_ — but it's easy to let it rot untested. It should have at least one smoke test.
9. **The confinement primitive is beta.** Worker Loaders / Dynamic Workers are _open beta_ (since
   2026-03-24), not GA, and the per-worker-per-day fee ($0.002) is only waived during the beta —
   both the availability guarantee and the fleet economics of "a unique loaded worker per project
   config" could shift under us. The whole substrate rests on this one primitive.
10. **KV routing table is eventually consistent.** A new project's hostname can take up to ~60 s to
    route globally, and per-key writes cap at 1/sec — so create-project isn't instantly live
    everywhere, and the registry can't double as a hot-write store. Fine for a routing table, but a
    sharp edge for demos and for anything expecting read-your-write on the ingress path.

---

## 5. Fragments of knowledge (specific, load-bearing)

_Code facts I verified first-hand; Cloudflare facts I cite to source. (Some Cloudflare citations are
being tightened by a parallel docs sweep — the constraints below are the load-bearing ones.)_

**From our code:**

- The runner already exists in embryo: clean-room `ProjectEntrypoint` is bound as **both** `env.ITX`
  and `globalOutbound` (kernel.ts:362-379) — one props-scoped entrypoint = capabilities + the egress
  door. In `apps/os`, `ProjectWorkerEntrypoint` is the same idea (plan Part 0).
- `/api` is served by `newWorkersRpcResponse(request, new Os(...))` returned from a method literally
  named `fetch` — _the only place Cloudflare permits a WebSocket upgrade_ (kernel.ts:346-347). Lint
  `iterate/no-capnweb-http-batch` forbids HTTP-batch in source; **WebSocket is the blessed
  transport** (plan Part H).
- Confinement is the config worker seeing **only** `["ITX"]` in `env` (config-worker.ts:44-50);
  props `{projectId}` are invisible and unforgeable to it. Raw bindings never enter the sandbox.
- The loader cache key includes a hash of the config-worker source (`project:<id>:<CONFIG_HASH>`,
  kernel.ts:371) so a config change busts the isolate cache.
- Two credential lanes already exist and are reusable verbatim (plan Part H): the born
  **`project-api-key`** at `/secrets/project-api-key` (machine↔machine, verified constant-time
  inside the Secret DO, `rpc-targets.ts:5379`, `auth.ts:282-298`), and the **`project-app-session`**
  (narrow, 15-min HS256, project-scoped, verified locally — `project-app-session.ts`,
  `auth.ts:300-313`). The clean-room reimplements the latter in ~90 lines.
- The directory is a clean DAG: **`kernel → auth`, auth never calls back** (directory.ts:1-13) —
  what keeps it acyclic. Membership resolves by the stablest key the wall JWT carries: `custom.sub`
  (Access maps auth's `sub` there) else verified `email` (directory.ts:192-203).
- `published()` strips the raw signed token before any secret-free identity crosses a boundary
  (kernel.ts:155-157) — "identity's version of don't hand the sandbox raw bindings."
- Current deploy SoT is `envs.ts` (501 lines): per-env `os`+`auth` worker names, one account,
  three resource IDs (**projectDirectoryKvId** = slug→project + `hostname:` routing; workerBuildCache
  KV; auth D1). Custom hostnames ride `cloudflareForSaasProjectHostnameBases` +
  `ownedProjectCustomApexes` with a fallback-origin catch-all route. AI-Gateway is `unified` vs
  `byok` per env — **prd is `byok`** (correct prompt-cache pricing; response cache preview/dev only).
- The monolith to split: `rpc-targets.ts` = 7,667 LOC, the fused god-object (core-boundary).

**Current apps/os reality (what we're splitting):** one worker per env (`os-prd`, `os-preview-N`)
holds the dashboard SSR, `/api`, ingress, and **~18 same-script Durable Object classes** (Agent,
CapabilityHost, Project, Repo, Scheduler, Secret, Stream, StatefulWorker, WorkerBuildCoordinator,
WorkspaceV2, + 6 sandbox classes), plus **two stateless sidecars**: `os-<env>-typechecker` and
`os-<env>-worker-bundler` (esbuild-wasm) — deployed _before_ os because name-binding a missing
script fails (worker-topology.md). The "project runner" **already exists but only as in-worker
dynamic loading**: `DynamicWorkerRunner` builds config-repo source via the `WORKER_BUNDLER` sidecar,
caches artifacts in `WORKER_BUILD_CACHE` KV (single-flight via `WorkerBuildCoordinatorDurableObject`),
and loads them into a `LOADER` isolate with a scoped `env.ITX` + egress via the `ItxEntrypoint` /
`ProjectEgressEntrypoint` loopback entrypoints (`ctx.exports`). Extracting `iterate-runner` = making
this loop a deployable rather than an in-process detail. Entry symbols to preserve verbatim:
`UnauthenticatedOsRpcTarget` (`rpc-targets.ts:6085`, `authenticate` at `:6108`) → `SessionRpcTarget`
(`:6031`) → `ProjectCollectionRpcTarget` (`:4703`) → `ProjectRpcTarget` (`:5238`, "an itx"); born
key readable via `SecretRpcTarget.reveal()` (`:2415`), verified constant-time in the Secret DO at
`authenticate` (`:6114`).

**Cloudflare / capnweb primitives (cited):**

- **Workers RPC service bindings are same-account only** — resolved by worker _name within the
  account_, with no account identifier in the binding, so they structurally cannot reference a worker
  in another account; cross-account must go over public HTTP/WS. This is _the_ reason cross-account
  uses capnweb (R11/D4). [service-bindings/rpc](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- **capnweb** (Cap'n Web) is Cloudflare's ~10 kB, JSON-serialized, object-capability RPC that
  _works over the open internet between different accounts_ — same model as Workers RPC, different
  reach. Transports: HTTP batch (`newHttpBatchRpcSession`; **stubs invalidate when the batch
  completes** — why lint forbids it in source), WebSocket (`newWebSocketRpcSession`; persistent,
  interactive), `postMessage`. Server side: `newWorkersRpcResponse(request, new Server())` extending
  `RpcTarget`. **Bidirectional**: pass a function/`RpcTarget` and the peer gets a stub that calls
  back — this is what makes "runner dials out, inbound routes _down_ the held session" possible
  (home-assistant/NAT case). [capnweb blog](https://blog.cloudflare.com/capnweb-javascript-rpc-library/), [npm](https://www.npmjs.com/package/capnweb)
- **We ship a fork**: `@iterate-com/capnweb@0.10.0` (aliased to `capnweb`), adding
  **WebSocket-over-RPC** (tunnel a `webSocket`-upgrade `Response` over an RPC stream pair — needed to
  proxy project WebSockets across a hop) and an **`onCall` per-call server hook** for tracing that
  propagates through pipelining. (`node_modules/.pnpm/@iterate-com+capnweb@0.10.0/…`;
  `packages/iterate/src/sdk/capnweb/`.)
- **RPC serialization is a security boundary**: classes extending `RpcTarget`/`WorkerEntrypoint`/
  `DurableObject` pass **by reference** (a stub); **instance properties are never exposed** — only
  declared methods/getters. Plain objects pass by value. This is why the capability tree is all
  getters vending sub-targets, and why the runner's raw bindings (`this.*`) never cross to a caller.
  [rpc/visibility](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)
- **Worker Loaders are open beta** (announced 2026-03-24, Workers Paid), not GA — a real risk to
  note. `env.LOADER.get(id, async () => code)` runs the callback **only on a cold isolate** (warm
  reuse skips fetching source — matches our `CONFIG_HASH` cache key). Isolates start **<5 ms**.
  Pricing **$0.002 per unique worker per day** (waived during beta). **`globalOutbound` has three
  states**: `undefined` = inherit parent egress; `null` = block _all_ egress; **a binding = funnel
  all `fetch`/`connect` through that gate** (our egress door). The dynamic worker sees _only_ the
  `env` the parent constructs; per-load identity rides via **`ctx.props`** on loopback entrypoints —
  exactly our `{projectId}` confinement. [dynamic-workers/api-reference](https://developers.cloudflare.com/dynamic-workers/api-reference/), [beta changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/)
- **Wildcard certs cover exactly one DNS label**: `*.base` covers `a.base` **and `a--b.base`**
  (double-hyphen is still one label) but **not `a.b.base`** — this is _why_ the `<app>--<slug>`
  single-label convention and "no paths" exist (kernel.ts:169-188). A **worker can be the SaaS
  fallback origin** for all custom hostnames via a `*/*` route; per-tenant custom apexes get
  per-hostname SSL-for-SaaS certs; **Total TLS (ACM)** auto-issues for proxied hostnames but the
  one-label rule still holds. [advanced-certificate-manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/), [worker-as-origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)
- **Cloudflare Access** injects a signed JWT on `Cf-Access-Jwt-Assertion`, verified against
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` with a **per-application AUD** — so
  `dashboard--*.base` can demand login while `*.base` stays anonymous, no kernel change. Crucially
  for **OQ-c (where does the wall live in L2)**: Access's **Linked App Token** already forwards a
  verified identity from app A to app B (as `Cf-Access-Token`), re-minting a JWT scoped to B's AUD —
  a supported, off-the-shelf basis for propagating the CP's verified identity into a cross-account
  runner. [application-token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [linked-app-token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/linked-app-token/)
- **KV is eventually consistent with a ~60 s global propagation and max 1 write/sec/key** — a real
  constraint on the ingress routing table: a freshly-created project's hostname may not route
  globally for up to a minute, and per-key write-rate limits mean the registry can't be a
  hot-write path. DO SQLite (GA, **10 GB/object**, new namespaces must be SQLite) is the right home
  for the durable log; KV is right for the mostly-read routing table.
  [kv/write](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [DO SQLite GA](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/)
- **Cross-account provisioning** (`provision-account`, M6): every endpoint is
  `/accounts/{id}/...`; a token can only touch an account it was **created with membership in** —
  there is no account-A→account-B binding. Required permission groups on the customer token:
  **Workers KV Storage Edit, Workers R2 Storage Edit, Workers Scripts Edit** (DO-bearing deploys),
  **DNS Edit** (+ Workers Routes). [api/permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- **AI-Gateway BYOK nuance (load-bearing for R9/L2):** BYO-keys are **not supported for third-party
  models called through the `env.AI` binding** — third-party-via-binding uses Cloudflare **Unified
  Billing** (CF holds credentials, deducts credits); own-keys need the provider-native gateway
  endpoints. So "our volume-discounted keys, metered" (R9) is naturally the _Unified Billing_ lane
  when `ai` is sourced from our account — which fits our `envs.ts` `cloudflareAiGatewayTransport`
  (`byok` for own-key prompt-cache pricing; the discounted-3p story is a different transport).
  [ai-gateway/byok](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)

---

## 6. Three radical reshapings

Three genuinely different architectures, each a real alternative to §1.

### Reshaping A — "No control-plane worker: the routing table _is_ the edge"

Delete `iterate-cp` as a worker. Put ingress + wall + routing entirely in a **Cloudflare
Worker-in-front-of-Workers-for-Platforms dispatch namespace**: a tiny dispatch worker looks up the
hostname in KV and `env.DISPATCHER.get(runnerName)` dispatches straight to the customer's runner
(user worker) with the wall JWT attached. Directory/registry become plain KV + a dashboard that is
itself just another dispatched project.

- **Pitch:** the control plane stops being a _service_ and becomes _configuration of the edge_.
  Workers-for-Platforms already does multi-tenant dispatch, isolation, and per-tenant limits —
  we'd stop reimplementing it. Cold starts approach zero; the "many projects" worker disappears.
- **Key trade-off:** hard-binds us to Workers-for-Platforms (an enterprise product) and its
  dispatch-namespace model; the free `pnpm dev`/Pi floor (R3) gets much harder because Miniflare's
  dispatch-namespace story is weaker than a plain worker. We'd trade self-host simplicity for
  edge-native multi-tenancy.

### Reshaping B — "One capability tree, zero runners: the tree is a Durable Object mesh"

There is no long-lived "runner worker" per project. Instead **each capability is a Durable Object**,
and a project is just an `{projectId}`-addressed set of DOs (`streams@projectId`, `secrets@projectId`,
`egress@projectId`). The stateless control-plane worker resolves a request to `{projectId, capability,
path}` and calls the DO directly (DO names carry `{projectId,path}` — already how `apps/os` addresses
everything, per core-boundary "Addressing"). The config worker still runs in a Loader, but `env.ITX`
is a thin façade that fans out to DOs.

- **Pitch:** state and compute co-locate per capability; no "which account is the runner in" question
  — capabilities are individually placeable (a `streams` DO in your account, an `ai` DO stub pointing
  at ours) which is _exactly_ R5's per-capability sourcing made physical. Scales horizontally with no
  per-project warm worker.
- **Key trade-off:** DOs can't cross accounts either, so cross-account capabilities _still_ need a
  capnweb session per capability — you multiply the session-management problem by the number of
  capabilities. And the "one tree, one hop" mental model fragments into a mesh that's harder to reason
  about and to confine as a unit.

### Reshaping C — "The runner is a container, not a worker: self-host is the primary, the edge is the guest"

Invert the hierarchy. The **canonical runner is the Miniflare/`workerd` container** (R3b's home-
assistant tier promoted to _the_ model). Every deployment — even fully hosted — runs the project
runner as a `workerd` container instance; Cloudflare Workers become one _deployment target_ among
several (container on a Pi, container on Fly, `workerd` in our cloud). The control plane speaks only
capnweb to runners; it never assumes a service binding.

- **Pitch:** collapses the placement matrix to one transport (always capnweb to a container), which
  makes home-assistant/BYO-account/local-dev the _same path as production_ — no special-casing,
  maximal R1/R12 purity. "Data never leaves your box" becomes the default, not a mode.
- **Key trade-off:** throws away the biggest thing Cloudflare gives us for free — the globally
  edge-cached identical bundle with ~zero cold start (the entire premise of R1's _why_). Every runner
  is now a warm process someone pays to keep alive; you rebuild autoscaling, placement, and HA that
  the edge did for you. Great for sovereignty, expensive for a fleet of mostly-idle projects.

---

_End. Lean followed: the CP/runner split + the concrete deploy/provision scripts (§1–§2) are the
buildable core; everything else hangs off "one tree, dialed differently."_
