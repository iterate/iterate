# Fable's proposal — the control plane, the project runner, and the smallest set of cuts that gets us there

One architect's complete proposal for how "iterate kernel + control plane + project runner" should
work, grounded in both the clean-room POC (`apps/kernel`) and today's `apps/os`. The lean is
deliberate: **a minimal-divergence migration** — not a rewrite, not a port onto the kernel, but a
sequence of cuts that reshapes `apps/os` in place until it _is_ the two-worker architecture the
self-hosting plan calls for.

---

## 1. The proposal

### 1.1 The one inversion that makes this cheap

The self-hosting plan (Part 0) says: two workers, a **control plane** (knows many projects) and a
**project runner** (knows one project, _is_ the ITX capability tree). The obvious reading is "break
the project machinery out of `apps/os` into a new runner worker." **Do the opposite.**

> **Carve the control plane _out_ of `apps/os` as the new, small worker. The existing `os-<env>`
> script keeps its name, its Durable Object namespaces, and ~90% of its code — and becomes the
> project runner.**

Why this direction is forced, not stylistic: every project's durable state lives in Durable Objects
declared same-script on `os-<env>` (Stream, Agent, Project, Repo, Secret, CapabilityHost, Scheduler,
StatefulWorker, WorkspaceV2, the sandbox containers — `apps/os/src/worker.ts:43-74`). DO namespaces
are bound to the declaring script; moving the classes to a new script orphans every existing
stream/agent/project DO — `apps/os/docs/worker-topology.md` documents exactly this from the
11-worker cutover ("every existing stream/agent/project DO in that env becomes an unreachable
orphan. That's a data reset, not a code deploy"). The project state has gravity. The control plane
is the part with _no_ durable state of its own (OS famously "has no database" —
`architecture-and-operations.md`), so it is the part that can move.

### 1.2 The components

Four pieces, three of which already exist:

```
                    ┌──────────────────────────────────────────────┐
   browsers, MCP,   │  CONTROL PLANE  (new small worker, cp-<env>) │
   webhooks, CLI ──▶│  ingress · wall · directory client ·         │
                    │  dashboard · /api front desk · webhook router│
                    └──────┬───────────────────────────┬───────────┘
                           │ Workers RPC               │ persistent capnweb WS
                           │ (same account)            │ (cross-account / local)
                    ┌──────▼───────────────┐    ┌──────▼───────────────┐
                    │  PROJECT RUNNER      │    │  PROJECT RUNNER      │
                    │  (today's os-<env>)  │    │  (customer account,  │
                    │  the ITX capability  │    │   or `pnpm dev` on a │
                    │  tree + all DOs +    │    │   home box)          │
                    │  worker loader +     │    │  identical bundle    │
                    │  egress door         │    └──────────────────────┘
                    └──────┬───────────────┘
                           │ service bindings
                    ┌──────▼───────────────┐   ┌──────────────────────┐
                    │ worker-bundler       │   │  AUTH (unchanged)    │
                    │ typechecker sidecars │   │  directory + OIDC,   │
                    └──────────────────────┘   │  bound to CP only    │
                                               └──────────────────────┘
```

**The control plane** (one per deployment; `cp-prd`, or self-hosted on your domain) owns exactly
the concerns that span projects:

- **Ingress** — the one hostname/path routing decision (`decideIngressRoute`,
  `apps/os/src/ingress.ts`) plus the hostname→project lookup table: `PROJECT_DIRECTORY` KV and
  `project-hostname-directory.ts`. Control-plane-owned regardless of where compute/data live (D8).
- **The wall** — every _user_ credential lane from `apps/os/src/auth.ts` (`from-server-cookie`,
  `bearer`, `operator-session`, `admin-secret`, `impersonate`) and the OIDC relying-party
  middleware. In kernel terms this is the wall + login machinery; the runner never sees it (D7).
- **The directory client** — the `AUTH` service binding to `apps/auth` (`AuthWorker`:
  `getProjectBySlug`, `listProjectsForUser`, `createProjectForOrganization`, `mintProjectId`,
  `mintProjectAppSession`, `validateProjectAppSession`, `introspectAccessToken` — the _complete_
  7-method contract, `apps/auth-contract/src/worker.ts:80-96`). Self-host swaps this for the
  kernel's `kv` directory: same `Directory` interface, a KV namespace, no auth worker (R13).
- **The dashboard** — the TanStack Start app, kernel-reserved control plane (R14): always
  reachable, never behind a project's config worker.
- **The `/api` front desk** — the top of the capnweb tree: `UnauthenticatedOsRpcTarget`
  (`rpc-targets.ts:6085`), `SessionRpcTarget` (`:6031`), `ProjectCollectionRpcTarget` (`:4703`)
  and the create-side directory write (`#registerProject`, `:5444`). `authenticate()` and
  `projects.get()` are membership decisions — control-plane concerns. Everything from the
  `Project` handle down is served by the runner (capnweb pipelining makes the handoff invisible
  to callers — a stub returned across the hop pipelines like a local one).
- **Webhook ingress routing** — Slack/GitHub/Telegram signature verification and
  which-webhook→which-project routing (`domains/integrations/integration-webhook-api.ts`,
  inbound email). Payloads cross-post into the _project's_ stream (in the runner, wherever it
  lives) and are never durably stored control-plane-side — a short-TTL buffer at most (R7/R8).

**The project runner** (today's `os-<env>`, kept byte-identical across deployments — R1) is the ITX
capability tree behind one entrypoint:

```ts
// The runner's public face — the ProjectWorkerEntrypoint the plan asks for.
// It generalizes the two entrypoints apps/os already has:
//   - ItxEntrypoint (domains/itx/itx-entrypoint.ts): env.ITX.get() → itx for a scope
//   - kernel's ProjectEntrypoint (apps/kernel/src/kernel.ts:319): props-scoped, one project
export class ProjectRunnerEntrypoint extends WorkerEntrypoint<Env, { projectId: string }> {
  itx(opts?: { path?: string }): ProjectRpcTarget; // the capability tree, Workers-RPC face
  fetch(request: Request): Promise<Response>; // the fetch-native serve lane (apps, WS)
}

// AND the same tree over the wire: the runner's default export serves
// POST/WS /api with capnweb (newHttpBatchRpcResponse / newWorkersWebSocketRpcResponse),
// accepting exactly the narrow lanes: project-app-session, project-secret.
```

There is **no wall on the runner** (D7). It derives identity from what it is handed: unforgeable
`ctx.props.projectId` on the RPC face, or a verified narrow token (`project-app-session` /
`project-secret` — both lanes already exist in `apps/os/src/auth.ts:64-92` and verify without the
auth worker) on the wire face. The runner keeps: all RPC targets from `ProjectRpcTarget` down, all
Durable Objects, `DynamicWorkerRunner` + Worker Loader (confinement), `ProjectEgressEntrypoint`
(the egress door), the secrets store, streams, repos, agents, sandboxes, and the two compiler
sidecars as its service bindings.

**The waist already exists.** The tree has a natural cut line at exactly one function:
`itxForScope()` (`apps/os/src/rpc-targets.ts:5989`) — the single mint point for a project itx.
Everything above it (`UnauthenticatedOs`, `Session`, `ProjectCollection`) is deployment-global;
everything it returns (`ProjectRpcTarget`, `:5238`, and its whole subtree) is per-project and
touches only project-scoped DOs and platform bindings. It has exactly three call sites — the
human/API lane (`ProjectCollectionRpcTarget.get`, `:4750`), the create path
(`ProjectRpcTarget.create`), and the userspace lane (`ItxEntrypoint.get`,
`domains/itx/itx-entrypoint.ts:38`) — which is the exhaustive set of doors a runner needs.
`ProjectRunnerEntrypoint.itx()` is `itxForScope()` behind a props boundary; the proposal is
mostly a promotion of an existing seam to a worker boundary.

### 1.3 One uniform dial

The load-bearing rule from the plan: _internal calls go through the same path as external ones._
Concretely, the control plane reaches a project through one function:

```ts
// control plane — the ONLY way anything reaches a project
function dialProject(projectId: string): ProjectHandle {
  const placement = placementFor(projectId); // from the project's directory record
  switch (placement.kind) {
    case "local-binding": // hosted default: same-account Workers RPC
      return env.RUNNER.itx({ projectId }); // Service<ProjectRunnerEntrypoint>
    case "capnweb": // BYO-account / home-assistant: persistent bidirectional WS
      return runnerSessions.get(projectId).itx(); // held by a control-plane DO
  }
}
```

Both faces expose the _same_ `ProjectRpcTarget` tree, because capnweb's `RpcTarget` **is** the
`cloudflare:workers` one — the identical class serves service-binding callers and WebSocket
callers. "Cross-account" is the same path, different transport (R11). Workers RPC cannot cross
Cloudflare accounts, so the cross-account transport is a persistent bidirectional capnweb
WebSocket, not HTTP-batch-per-call (D4). For runners behind NAT (home-assistant mode, D12) the
_runner dials out_ and the control plane holds the session in a `RunnerSessionDurableObject`;
inbound HTTP for that project routes down the held socket. This is the same mutual-auth shape the
Tasks app and the clean-room dashboard already use (`project-secret` to authenticate the dial —
OQ-h answered: yes, build on it).

### 1.4 The sourced capability tree (R5/M3) — and the simplification that tames it

Break the monolith along its existing grain: `ProjectRpcTarget`'s built-ins (`streams`, `repos`,
`agents`, `secrets`, `workers`, `egress`, `ai`, `mcp`, `openapi`, `sandboxes`, `integrations`, …)
already resolve in the isolate as explicit members (`apps/os/src/README.md` §capabilities). Today
each is constructed directly from `env` bindings. The cut: construction goes through a per-project
**source table**, part of the project's config (the `metadata` JSON column on auth's `project` row,
mirrored into the directory record):

```jsonc
// default — today's behavior, byte-for-byte
{ "capabilities": {} }                        // everything { "source": "local" }

// a level-2 project: storage local (their account), ai metered from ours
{ "capabilities": {
    "ai":     { "source": "capnweb", "url": "wss://cp.iterate.com/capabilities/ai",
                "gateway": "byok-openai", "credential": "project-secret" },
    "browser":{ "source": "capnweb", "url": "wss://cp.iterate.com/capabilities/browser" }
} }
```

The **simplification** that keeps this from exploding: capabilities divide into two kinds, and only
one kind is sourceable.

- **Storage-shaped** (`streams`, `repos`, `secrets`, `workers`, `sandboxes`, files): these are
  _never_ sourced remotely — they are wherever the runner is. "Data in your account" means "your
  runner runs in your account," not "your streams capability points at a different account." Data
  has gravity; the runner is its center of mass.
- **Service-shaped** (`ai`, `browser`, `email`, search, discounted third-party access via our
  secrets): stateless request/response — these are sourceable per-capability, carrying their own
  metadata (which AI gateway, which billing counterparty — R9).

This collapses the lattice: the _data-at-rest_ dimension is decided by runner placement (one knob),
and per-capability sourcing only has to cover the cheap, stateless capabilities. Moving up and
down the ladder (R12) becomes: repoint a service capability = edit the source table (no data move);
move your data = move the runner (a data migration, D10, out of scope for now).

### 1.5 What stays exactly as it is

- **`apps/auth`** — unchanged. Still the directory of record (orgs, members, projects, OAuth/OIDC
  issuer), still never calls back into OS/CP (verified: its wrangler config has no OS binding).
- **The userspace contract** — `{ fetch, processEvent }` on `IterateWorkerEntrypoint`
  (`config-repo-template/worker.ts`), `env.ITX.get()`, the generated itx contract
  (`itx-api.generated.ts` — see fragment 21), capability hosts, `__describe()`. Projects notice
  nothing (R12's "no transition edits project code").
- **The sidecars** — worker-bundler and typechecker are already the proof that "carve a concern
  into its own worker, talk over a service binding" works in this codebase.
- **envs.ts** — grows a `cpWorkerName` per env and, later, per-project placement records; it stays
  the single source of truth for deployment topology.

### 1.6 The migration — an ordered sequence of PRs, no big bang

Each PR is shippable, testable, and leaves prd deployable. Nothing here waits on a data reset.

Three hard constraints shape the order (all verified in source):

- **Loader isolates are parent-bound.** A dynamic isolate carries its creator's loopback binding
  stubs; invoking it from a different parent fails with a redacted internal error — this is why
  `WORKER_SELF` is part of the loader cache key (`apps/os/src/env.ts:16-23`). Consequence: every
  `ctx.exports` mint (`DynamicWorkerRunner`'s constructor, `ItxEntrypoint`,
  `ProjectEgressEntrypoint`, `ScriptExecutionEntrypoint`) must execute _in the runner_; cp
  forwards Requests + resolved project ids and never constructs runner machinery.
- **`ItxAuth` is a live, mutable object** (`ensureCanAccessProject` widens itself in place,
  `auth.ts:186-200`) — it cannot cross an RPC boundary. The cp→runner contract carries a
  _serialized grant_ (the existing `ItxAuthToken` shape, `auth.ts:103-105`, generalized), the way
  `StreamContext` already crosses trusted hops as a header.
- **`rpc-targets.ts` imports `env` ambiently** (`import { itxEnv as env }`, `:445`), so the one
  file is implicitly typed against the union of both future workers' bindings. Splitting the
  `Env` interface is the single largest mechanical cost, and it has to come early.

The sequence:

1. **PR 1 — one dial.** Introduce `dialProject(projectId)` and route the three existing
   `itxForScope` call sites plus the serve path (`worker.ts:199-241`) through it. Today it
   returns the in-process target via `ctx.exports`. Pure refactor; zero behavior change. _This is
   the seam everything else cuts along._
2. **PR 2 — close the plane leaks.** The mapped spots where project-plane code reaches
   control-plane state (each becomes an explicit interface now, an RPC later):
   `KvRpcTarget` storing project KV in the _directory_ namespace under `projectkv:` prefixes
   (`rpc-targets.ts:7156-7191` → move to the Project DO's SQLite);
   `ProjectRpcTarget.identity()` reading `PROJECT_DIRECTORY` (`:5485`);
   `ProjectAuthRpcTarget` holding `env.AUTH` inside the project plane (`:5068-5111` → mint/verify
   moves cp-side, the runner keeps only local HS256 verification);
   `EmailCapabilityRpcTarget` and `AgentCollectionRpcTarget` reading the directory
   (`:3636-3660`, `:1481-1620` → the runner receives slug/hostname facts at create/update as
   events);
   `UnauthenticatedOs.authenticate` reaching into a project's Secret DO for the `project-secret`
   lane (`:6117-6128` → becomes a runner RPC: "verify this secret, one-bit answer");
   `ProjectCollection.list()` probing every project's processor (`:4790-4882` → cp lists from
   the directory; per-project status becomes a runner call the dashboard makes lazily);
   webhook ingress writing directly into project streams (`worker.ts:264` → goes through
   `dialProject(...).streams` like everything else);
   `serveProjectFileRequest` serving project R2 bytes from the ingress worker (`worker.ts:176`).
   This PR is the real de-tangling work, and it is _useful on its own_ — every leak it closes is
   a bug class removed from the current monolith too.
3. **PR 3 — split the monolith file + the Env.** Break `rpc-targets.ts` (7,667 lines) into
   `src/front-desk/` (UnauthenticatedOs, Session, ProjectCollection, #registerProject) and
   `src/project/` (ProjectRpcTarget and everything it vends — lines 517–4700, 5041–5237,
   6156–7667 in today's file), splitting `Env` into `FrontDeskEnv` (AUTH, PROJECT_DIRECTORY,
   config) and `RunnerEnv` (everything else). Mechanical, guarded by the generated contract:
   `itx-api-graph.generated.ts` is a machine-readable snapshot of the whole tree, so the split
   cannot silently change the public surface. Preserve the two structural invariants:
   `ITX_SURFACE_MEMBER_NAMES` (`:5978`) and the prototype-fallback registry (`:7622-7667` — no
   instance Proxies; workerd brand-checks pipelined results, cloudflare/workerd#6873).
4. **PR 4 — the runner entrypoint.** Add `ProjectRunnerEntrypoint` (as sketched above) as a named
   export of the os worker, subsuming `ItxEntrypoint`'s role; give the os worker's default fetch a
   runner-`/api` lane that serves the project tree over capnweb for `project-app-session` /
   `project-secret` credentials only. Ship it dormant behind the existing routes.
5. **PR 5 — the control-plane worker.** New `apps/cp` (thin — target < 2k lines of its own):
   `ingress.ts`, `project-directory.ts`, `project-hostname-directory.ts`,
   `domains/projects/custom-domains.ts` (the CF-API custom-hostname provisioner), `auth.ts` +
   `auth/*` (operator sessions), webhook verification/routing, dashboard hosting, front-desk
   `/api`. It binds `RUNNER: Service<ProjectRunnerEntrypoint>` to `os-<env>`. Routes for
   `os.iterate.com`, `mcp.`, `*.iterate.app`, and custom apexes move to `cp-<env>`; the os
   worker keeps `workers.dev` reachability for smoke. The os worker deletes ingress, the user
   credential lanes, the dashboard SSR entry, and webhook verification.
6. **PR 6 — sourced capabilities.** Thread built-in construction on `ProjectRpcTarget` through
   the source table with only `"local"` implemented. The anchor already exists:
   `PROJECT_BUILTIN_BLIPS` (`rpc-targets.ts:5128-5177`) is a declarative registry of built-ins
   keyed by member name — add a `source` column and derive both the blips and the reserved-name
   set from the one table. Then implement `"capnweb"` for `ai` first (M5's prove-step: `ITX.ai`
   served from another account over a persistent capnweb WS round-trips like a local binding).
7. **PR 7 — runner sessions.** `RunnerSessionDurableObject` in cp + the runner-side dial-out
   (`pnpm dev --control-plane wss://…` and the BYO-account deploy both use it). Prove
   home-assistant mode: local Miniflare runner, hosted cp, data never leaves the box.
8. **PR 8 — provisioning.** `provision-runner` script (D11: an ensure-resources-style idempotent
   script run with a customer Cloudflare API token — creates KV/DO bindings/R2/routes in their
   account, returns IDs, deploys the identical runner bundle). M6.
9. **PR 9 — lock R1.** CI asserts `sha256(runner bundle)` is identical across hosted/self-host
   build profiles (M0 formalized once the runner exists as a distinct build product; before the
   split this is unmeasurable because the bundle contains the dashboard).

Sequencing rationale (OQ-j): the structural unlock (PRs 1–5, ≈ M3) comes before new runtime
surface, because every later milestone (M5–M8) needs the seam. The durable log already exists in
apps/os (`StreamDurableObject`) — unlike the clean-room, we are not missing M4; we are missing the
_boundary_.

---

## 2. Scripts

What should exist once the dust settles (per-app, envs.ts-driven, Doppler-backed — the existing
pattern in `apps/os/scripts` and `docs/devops-cloudflare-doppler.md`):

| script                                                                                      | app                         | what it does                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                                                                                  | repo root                   | one Miniflare running cp + runner + auth + sidecars, wide open, kv directory, `<slug>.localhost` hosts. The R3 floor: this _is_ the Raspberry-Pi / home-assistant tier, restart-on-crash.                                                              |
| `pnpm dev --runner-only --control-plane <wss-url> --project <id> --secret <project-secret>` | apps/os                     | home-assistant mode: run only the runner locally and hold the dial-out capnweb session to a hosted control plane.                                                                                                                                      |
| `pnpm run deploy --env <name>`                                                              | apps/cp, apps/os, apps/auth | build → wrangler deploy with atomic secrets → smoke. cp deploys after os (its `RUNNER` binding needs the script to exist), mirroring how deploy.ts already orders the sidecars before os.                                                              |
| `pnpm ensure-resources --env <name>`                                                        | each app                    | create-only bring-up: KV namespaces, D1, DNS records, Total TLS/ACM for wildcard hosts, routes. Reconciles IDs into envs.ts.                                                                                                                           |
| `pnpm provision-runner --account-token <cf-token> --project <id>`                           | apps/cp                     | the cross-account ensure-resources (D11): stands up KV/R2/routes in a _customer_ account, deploys the identical runner bundle there, registers placement (`capnweb`, endpoints, credentials) in the directory record. Idempotent; prints what it made. |
| `pnpm erase-data --env <name>`                                                              | apps/os                     | wipe auth D1 rows + directory KV; DOs orphan (unchanged).                                                                                                                                                                                              |
| `pnpm cli itx …`                                                                            | apps/os                     | unchanged — connects to `/api` (now cp's front desk) with the admin secret; scripts run against a project's itx surface exactly as today.                                                                                                              |
| `pnpm auth:mint`                                                                            | repo root                   | unchanged — mint sessions against any env.                                                                                                                                                                                                             |
| `verify-bundle-identity`                                                                    | CI                          | R1 lock: builds the runner with hosted + self-host profiles, fails unless hashes match.                                                                                                                                                                |

Deleted, on purpose: nothing. Every existing script keeps its name and contract; two new ones
(`provision-runner`, `verify-bundle-identity`) and one new flag (`--runner-only`).

---

## 3. Main stories, end to end

**(a) Create a project.** Browser on `os.iterate.com` (cp) → `POST /api` one-shot capnweb batch →
`authenticate({type:"from-server-cookie"})` verifies the `iterate_session` cookie against the
Doppler-derived public JWK (no live auth hop) → `session.projects.get("acme").create({...})` → cp
calls `AUTH.createProjectForOrganization({organizationSlug, name, slug})` (idempotent: same
slug+org adopts the existing row; different org is a `conflict`) → primes `PROJECT_DIRECTORY` KV →
`dialProject(prj_id)` → the runner appends the Project + notification birth certificates and both
processor subscriptions to the root stream in one atomic batch, the Project processor creates the
root capability host, scheduler, email router, and the config repo seeded from
`config-repo-template`, builds the seeded worker, emits `project/ready` — exactly today's flow
(`src/README.md` §project creation), just with the create _decision_ on cp and the create _work_
on the runner. On self-host with the `kv` directory, the same `create()` writes a KV record and
skips orgs entirely (kernel `directory.ts` semantics).

**(b) Hosted serving.** `GET https://acme.iterate.app/` → cp's `decideIngressRoute` resolves slug
→ project id via KV (auth-worker fallback on miss) → stamps trusted headers (`x-itx-project-id`,
`x-iterate-app`, `x-iterate-host-kind` — always overwritten, never pass-through) →
`dialProject(prj).fetch(request)` over the `RUNNER` service binding — a real fetch hop, so
streaming bodies and WebSocket 101s tunnel natively (RPC method replay cannot carry them; this is
why the runner keeps the fetch-native lane `ItxEntrypoint.fetch` already built) → the runner's
serve envelope (`project-serve.ts`: cold-build budget, building/failed stand-in pages, overlay) →
`DynamicWorkerRunner` loads the config worker via Worker Loader with `env.ITX` = a scoped loopback
entrypoint and `globalOutbound` = the project egress fetcher → the config worker's `fetch` routes
on `x-iterate-app`.

**(c) Self-host on your own domain.** `wrangler login`; `ensure-resources` against your account
(one zone, wildcard `*.you.com` DNS + Total TLS, KV namespaces); `pnpm run deploy` ships the
_identical_ cp + runner bundles with your `APP_CONFIG`: `wall` = your Cloudflare Access team (cp
verifies `Cf-Access-Jwt-Assertion` against your team JWKS — the kernel's 47-line `wall.ts` model,
adopted as cp's sixth credential lane), `directory` = `kv`, hostBase = `you.com`. Projects at
`foo.you.com`, dashboard at `dashboard--foo.you.com` (single-label `--` convention so one
wildcard cert covers it). No auth worker deployed at all. Wide-open (no wall) is legal and is the
default (R3): your Caddy/tunnel/perimeter is the wall.

**(d) BYO Cloudflare account (level 2).** You give us a scoped CF API token (D3).
`provision-runner` stands up resources in your account and deploys the identical runner bundle
there. Your runner dials out to our cp and holds a persistent bidirectional capnweb session,
authenticated with its `project-secret`; the directory records placement `capnweb`. Ingress stays
ours: `acme--you.iterate.app` hits our cp, routes down the held session to your runner, your
streams/R2/DOs fill up in _your_ account. Your project's `ai` capability sources from us
(metered, D5); your `repos`/`streams` never leave your account. We are first and last HTTP contact
and never the store (R7); webhooks route through cp with a short-TTL buffer only (R8).

**(e) Local `pnpm dev` / home-assistant.** Floor tier: `pnpm dev` = cp + runner + kv directory in
one Miniflare on any box, wide open, zero external deps; kill it, restart it, state persists in
Miniflare's local KV/DO storage (R3b — restart-on-crash, not HA). Home-assistant variant:
`pnpm dev --runner-only --control-plane wss://cp.iterate.com …` — our cp, ingress, and wall; your
runner on the home box behind NAT holding the dial-out session; project data (streams, repos,
secrets) lives only on the box. Cloudflare-only capabilities (`ai` via Workers AI, artifacts)
source from our account over the same session — a fully-offline runner simply configures none of
them (OQ-g's answer: offline is a degenerate config, not a separate mode).

**(f) MCP connect → emerge with a project.** Claude connects to `mcp.iterate.com` → cp rewrites to
the dashboard app's `/api/mcp` mount → RFC 9728 protected-resource metadata points at the auth
worker's issuer → OAuth (auth is the OP; project selection stored in `oauthProjectSelection`) →
each MCP request authenticates the bearer token (`introspectAccessToken`), gets a fresh in-memory
MCP server exposing `exec_typescript` → the script runs through a one-shot capnweb batch into the
front desk → `projects.get(prj)` → runner → `capabilityHost.runScript(...)` in a confined dynamic
worker. A first-time user's script can call `session.projects.get("new-slug").create({})` and
emerge holding a live project — the same door as everyone else.

**(g) Agent LLM call via ITX.** A message appends `agents/context-added` to `/agents/<name>`; the
agent processor (hosted by the Agent DO on the runner) folds context, debounces, appends
`agent/llm-request-requested` _by reference_, rebuilds the request from committed events, then
calls **`itx.ai`** — which resolves through the capability source table: hosted = the local
`env.AI` binding through the Cloudflare AI Gateway in `byok` transport (unified billing meters
OpenAI-prompt-cached tokens at ~6× — the reason envs.ts pins byok everywhere); level-2 = the
`capnweb` source dialing our cp's metered `ai` endpoint over the held session. The journaled
request lifecycle and the assistant context item land on the agent's stream either way — the
events are identical because the capability surface is (R5's point).

**(h) Egress with a substituted secret.** Project code (or an agent script) does
`fetch("https://api.stripe.com/v1/charges", { headers: { authorization: "Bearer getSecret(/secrets/stripe)" }})`.
The bare `fetch` is `globalOutbound` = `ProjectEgressEntrypoint` (props-scoped to the project),
which forwards to the Project DO — one decision point for explicit `itx.egress.fetch` and bare
dynamic-worker fetch alike. The DO resolves the placeholder against the Secret DO **only if the
request origin is in the secret's egress allowlist**, substitutes material the sandbox never saw,
records a usage audit event, and sends. Interceptors (`itx.egress.intercept`) see placeholders,
never material. In level 2 with an _iterate first-party_ secret (R9's volume-discounted key), the
runner's door forwards the still-placeholder request over the capnweb session to cp's egress door,
which substitutes from _our_ secret store and meters it — two chained doors, each substituting
only secrets it owns.

---

## 4. Difficulties & trade-offs

- **The double hop.** Every hosted project request now crosses cp → runner. Same-account service
  bindings run on the same machine where possible with no added request fee, so the hosted-path
  cost is ~zero; but it is a real second isolate, and the cp must stay thin enough that its cold
  start doesn't stack meaningfully on the runner's (~130–160ms measured for the merged os script).
  The mitigation is architectural: cp has no wasm, no DO classes, no React SSR on project-host
  paths — target a sub-1MB bundle.
- **The dashboard's server side needs itx.** TanStack server functions today call
  `itxForScope(...)` in-process. On cp they dial the runner. Most dashboard data already flows
  over the browser's own `/api` WebSocket (which pipelines through cp to the runner), so the
  server-function surface to convert is small — but it's real work and a latency change on SSR.
- **capnweb ≠ Workers RPC, at the edges.** Same semantics by design, but the cross-account
  transport has real gaps to respect: no three-party handoff (a stub can't be forwarded to a third
  session), stub lifetime is session lifetime (a dropped WS kills live capabilities — the
  capability host's `itx-expression` durable mounts exist precisely because live mounts die with
  their connection), and WebSocket 101s can't ride RPC method replay at all (DataCloneError — the
  fetch-native lane is load-bearing on _every_ transport). Reconnect/replay logic for the
  persistent runner session is the new hard code in this design.
- **R1 vs containers.** The runner bundle contains sandbox container classes whose images are
  built at deploy (`sandbox/Dockerfile`). "Byte-identical bundle" is honest for the worker script;
  container images are account-local build products, and BYO-account provisioning must build them
  in the customer account (slow, and a Docker dependency in `provision-runner`). Declare the R1
  invariant over the worker bundle, and treat container images as versioned artifacts pinned by
  digest.
- **R1's cold-start premise needs honest downgrading.** Cloudflare documents no content-addressed
  "same bundle = warm everywhere" cache: isolate warmth is per-script(-version), per-machine,
  evictable at any time, with no routing affinity ([how Workers
  works](https://developers.cloudflare.com/workers/reference/how-workers-works/)) — and our own
  warmup experiment (PR #2115) confirmed warm-pinging is a placebo. Keep R1 for the reasons that
  are true — config-not-fork, one test matrix, provable self-host parity — and stop citing free
  cold starts as its justification.
- **Two workers to keep honest, not one.** The cp/runner boundary is a public contract
  (`ProjectRunnerEntrypoint` + the runner `/api` lanes). It will be tempting to punch same-account
  shortcuts through it (a shared KV here, a direct DO dial there). Every shortcut breaks level 2
  silently. The `dialProject` chokepoint plus a CI rule (cp may not import from `src/project/` or
  bind project DOs) is the guardrail.
- **Webhook R7 is a delivery-semantics problem, not a storage toggle.** "Short TTL only" at cp
  means a level-2 runner that's offline for longer than the TTL loses webhooks. Slack retries;
  GitHub retries briefly; email does not. The honest contract: cp buffers with a bounded TTL and
  surfaces gap events; at-least-once beyond that is the runner's availability problem (consistent
  with the restart-on-crash tier).
- **The directory's stale-claims dance stays.** Session JWTs lag project creation;
  `ensureCanAccessProject`'s claims-fast-path + directory-fallback + 30s cache
  (`apps/os/src/auth.ts:186-200,405-428`) moves to cp unchanged. It's ugly and it's correct;
  don't redesign it during the split.
- **Two directions we're _not_ taking, and why.** (1) Porting apps/os onto the kernel codebase:
  the kernel is 854 lines because it has no product in it; the migration value is its _boundaries_
  (wall/directory/confinement/one-egress-door), all of which land here as cuts to apps/os. (2)
  Runner-per-project isolates via Worker Loader for the _platform_ itself: the runner stays one
  multi-project-capable script whose per-request scoping is `props` — per-project _accounts_ are
  the isolation escalator (see reshaping #3), not per-project platform workers.

---

## 5. Fragments of knowledge

Specific, load-bearing facts discovered while grounding this proposal:

1. **`getUserGrants` / `getUserGrantsByEmail` do not exist in apps/auth.** The kernel's
   `AuthDirectory` slice (`apps/kernel/src/directory.ts:28-35`) declares them, and the
   self-hosting plan marks them ✅ — but auth's real contract has exactly 7 methods
   (`apps/auth-contract/src/worker.ts:80-96`) and no email-keyed lookup at all. The closest is
   `listProjectsForUser({userId})`. Any wall (Access) whose JWT carries only a verified email needs
   a new auth RPC before the kernel's hosted directory story works. _(Verified against source.)_
2. **Auth's `project` table already has a `metadata` JSON column** (globally-unique slug,
   `apps/auth/src/server/db/definitions.sql:46`), and `createProjectForOrganization` accepts
   `metadata` — the capability source table and placement record have a home with zero schema
   work.
3. **Project creation is idempotent by design**: same slug + same org adopts the existing row;
   deliberately no random slug suffix so an environment reset can recreate exact slugs
   (`apps/auth/src/server/project-directory.ts:96-127`).
4. **DO data gravity is documented, not theoretical**: the 11-worker→1 cutover orphaned every DO
   ("that's a data reset, not a code deploy" — `apps/os/docs/worker-topology.md`), and the same
   doc records why the merge won: sequential cross-script cold starts, cross-script RPC
   subscriptions pinning DOs awake for hours. The cp/runner split avoids both failure modes
   because cp holds no DOs and no long-lived cross-script subscriptions — it holds _sessions_ (in
   its own DO) and forwards.
5. **WebSocket upgrades cannot cross RPC method replay** — a 101's socket fails workerd
   serialization (DataCloneError). apps/os already engineered around this: HTTP into project
   workers is a fetch-native lane end-to-end (`ItxEntrypoint.fetch` +
   `x-iterate-worker-dispatch`, `worker-runner.ts:139-217`), and `invokeCapability` refuses
   upgrade requests loudly (`worker-runner.ts:243-250`). The cp→runner hop must be `fetch`, not an
   RPC method, for the serve path.
6. **The egress door is already a two-stage chokepoint**: `ProjectEgressEntrypoint` (the
   loader-visible Fetcher, `domains/projects/egress.ts:39-48`) immediately forwards to the Project
   DO so bare dynamic-worker `fetch()` and explicit `itx.egress.fetch` share one decision point;
   interceptors see `getSecret(...)` placeholders, never material (ADR 0002). Chaining a
   control-plane door for first-party secrets is an extension of an existing shape, not a new
   mechanism.
7. **Trusted-header ingress is the existing cross-worker idiom**: `x-itx-project-id` /
   `x-iterate-app` / `x-iterate-host-kind` are always stripped from the outside world and
   re-stamped by routing (`worker.ts:323-334`, `ingress.ts:126-140`) — the same
   strip-then-stamp pattern the kernel uses for `x-iterate-caller`. The cp→runner contract can
   carry request context this way on the fetch lane without inventing anything.
8. **OS deliberately has no database** — auth is the source of truth for existence/membership,
   fronted by `PROJECT_DIRECTORY` KV (`architecture-and-operations.md` §project directory). This
   is why the control plane can be carved out with no data migration: its entire durable state is
   one KV namespace and auth's D1, both already outside the os script.
9. **AI Gateway `byok` is pinned everywhere for a measured reason**: unified billing meters
   OpenAI-prompt-cached tokens at the uncached price (~6× at our hit rate), and byok benchmarked
   latency-neutral-or-better; the response cache only works on byok and is preview/dev-only
   (`envs.ts:91-105,157-161`). Any "ai sourced from iterate" capability must preserve these
   gateway/transport knobs per source — they are product economics, not plumbing.
10. **The dependency DAG is verified one-way**: auth has no service binding to OS and fetches no OS
    URL (`apps/auth/scripts/generate-wrangler-config.ts:101-160`) — `kernel → auth`, never back.
    The cp inherits this edge; the runner gets _no_ auth binding at all, which is what makes the
    runner deployable into a customer account without our directory credentials.
11. **The narrow tokens already exist on both sides**: `project-app-session` (15-min HS256,
    user-on-project, verified locally) and `project-secret` (the born
    `/secrets/project-api-key`, verified inside the Secret DO with a one-bit answer) are live
    credential lanes in `apps/os/src/auth.ts:64-92` and mirrored in the kernel
    (`project-app-session.ts`). These two lanes are exactly the runner's wire-face `authenticate()`
    surface — nothing new to invent for D7.
12. **capnweb's `RpcTarget` is the `cloudflare:workers` one** (`apps/kernel/src/kernel.ts:199-204`
    demonstrates it): one class tree serves in-process, service-binding, and WebSocket callers.
    This single fact is what makes "the runner is always reached through the same ITX code path"
    implementable without an adapter layer. Caveats from the capnweb README
    ([github.com/cloudflare/capnweb](https://github.com/cloudflare/capnweb)): fewer serializable
    types than Workers RPC (no Map/Set/cyclic values), and no true three-party handoff — a
    forwarded stub proxies through the intermediary session.
13. **Workers RPC does not cross Cloudflare accounts — verified.** "This Worker must be on your
    Cloudflare account"; no binding of any kind (service, DO, dispatch namespace) is
    cross-account ([service
    bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)).
    And the same doc gives the double-hop its cost model: same-account service-binding calls run
    "on the same thread of the same Cloudflare server" with zero added latency, billed as one
    request — the cp→runner hop is ~free in hosted mode. Cross-account hardening: Workers mTLS
    bindings **cannot** target a Cloudflare-proxied zone (520 —
    [mtls docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/)), so the
    runner dial secures with its `project-secret` (optionally behind an Access service token),
    not mTLS.
14. **Cloudflare for SaaS on Workers is cheap and concrete**: an originless `AAAA 100::` record +
    a zone `*/*` route captures all custom-hostname traffic with no per-hostname routes
    ([worker-as-origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/));
    100 custom hostnames free, then $0.10/hostname/month — but **wildcard custom hostnames are
    Enterprise-only**, so a customer's `*.customer.com` (vs `app.customer.com`) is a plan
    dependency ([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)).
    Self-hosters skip all of this: Total TLS covers subdomains of _their own_ zone, matching the
    kernel's proven `*.shiterate.com` setup.
15. **AI Gateway tokens are account-scoped, not per-gateway** — any `AI Gateway Run` token can
    drive every gateway in the account, including BYOK keys; Cloudflare's stated isolation answer
    is separate accounts or keeping the AI binding worker-side
    ([authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).
    Direct consequence: the metered level-2 `ai` capability must be _our worker proxying our
    binding_ (the capnweb source in §1.4), never a handed-out gateway token. The gateway itself is
    plain HTTPS, so it is callable from any account — billing isolation is the constraint, not
    reachability.
16. **Cross-script DO bindings and DO namespace transfer exist** (same-account `script_name`
    bindings; a newer `exports`-based flow can move a DO namespace between Workers —
    [DO migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).
    This softens — but does not remove — the data-gravity argument in §1.1: the transfer flow is
    an alternative to the inversion, at the cost of a riskier one-way namespace move per
    environment instead of zero moves.
17. **KV is eventually consistent with up to ~60s propagation**
    ([KV reads](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)) — fine for the
    hostname→project routing table (a new hostname taking a minute to go live globally is
    acceptable; creation flows prime the writing location, which is immediately consistent
    there), wrong for anything authorization-shaped, which is why membership stays in auth/D1
    with the KV strictly a cache.
18. **Worker Loader is now "Dynamic Workers", open beta** (2026-03-24), with facts we should
    exploit: `get(id, cb)` reuse is best-effort per-machine in-memory (content-hash cache keys —
    already our pattern — are the only warmth knob); `globalOutbound: null` means _no network at
    all_ (a useful egress-lockdown mode); loaded workers can attach tail workers and custom
    limits; and **DO facets** give dynamically-loaded code its own isolated SQLite
    ([api reference](https://developers.cloudflare.com/dynamic-workers/api-reference/),
    [changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/)).
19. **RPC hop mechanics that bound the design**: 32 MiB max serialized RPC payload, ~32 chained
    Worker invocations per request, and stubs cannot outlive the execution context that made them
    ([RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/),
    [limits](https://developers.cloudflare.com/workers/platform/limits/)) — the reason
    `dialProject` hands out per-request handles and the persistent cross-account session lives in
    a DO (which has no such lifetime limit on the WebSocket it holds, thanks to hibernation).
20. **Constructing a handle _is_ the authorization check.** Nearly every RpcTarget takes
    `{ auth, projectId }` and calls `auth.assertCanAccessProject(projectId)` in its constructor
    (e.g. `rpc-targets.ts:1622, 2251, 4153, 4890, 5245`); there is no per-method auth. Two
    targets deliberately drop auth — `ProjectEgressRpcTarget` (`:6360`, the Project DO is the
    policy point) and `DynamicWorkerRpcTarget` (`:4560`, authority comes from the hosting
    `ctx.exports`). This is exactly the capability discipline that survives a worker split:
    authority is where construction is, and construction moves to the runner wholesale.
21. **The contract of record is generated, and the README lies about it.**
    `apps/os/src/README.md` names `src/types.ts` as the public contract — that file no longer
    exists; the real contract is `itx-api.generated.ts` (4,180 lines) +
    `itx-api-graph.generated.ts` (2,639 lines), emitted from the `IterateRpcTarget<"Name">`
    phantom-type declarations. The graph file is a machine-readable snapshot of the entire
    capability tree — the natural regression pin for the monolith split, and the natural input
    for sourced-capability tooling. (Also stale in that README: `itx-client.ts` moved to
    `packages/iterate/src/itx/itx-node-client.ts`, and the fallback is a prototype-chain hop, not
    a Proxy.)
22. **`itx.kv` is secretly a control-plane binding**: `KvRpcTarget` (`rpc-targets.ts:7133`)
    stores project key-values in the `PROJECT_DIRECTORY` KV namespace under `projectkv:` prefixes
    — a project-plane capability living in directory storage. Harmless today; fatal for level 2
    ("your data in your account" must include your kv). It moves to the Project DO's SQLite in
    the de-leak PR.
23. **The `project-secret` door crosses the plane boundary by design**:
    `UnauthenticatedOs.authenticate` reaches into the _project's own Secret DO_ for a
    constant-time compare (`rpc-targets.ts:6117-6128`), receiving a one-bit answer, never
    material. After the split this is the one front-desk call that must dial the runner — which
    is correct: the runner owns the secret, so the runner answers whether a caller holds it.
24. **`ProjectCollection.list()` is a hidden N-runner fan-out** (`rpc-targets.ts:4790-4882`): it
    probes every accessible project's processor state. Fine same-script; a scaling and latency
    trap across a worker boundary, and impossible across accounts — the listing must come from
    the directory alone, with per-project health fetched lazily by the dashboard.
25. **There is no Queues binding anywhere in apps/os** — the stream spine (DO alarms + cursors +
    subscriber wake) is the queue, and search is `itx.docs.search` + `itx.mcp.exa`, not a
    dedicated capability. The capability inventory that actually needs _sourcing_ is smaller
    than the R5 list suggests: `ai`, `browser`, `images`/`media`, `email`, `parallel`, and the
    egress/secrets pair — everything else is storage-shaped and follows the runner (§1.4).

---

## 6. Three radical reshapings

Deliberately _not_ the proposal above — three completely different shapes, each with a pitch and
its price.

### R-1: "Projects are real workers" — Workers for Platforms instead of Worker Loader

Every project's config worker becomes an actually-deployed Worker in a **dispatch namespace**
(Workers for Platforms). The control plane is a dispatch worker: hostname → `env.DISPATCH.get(
projectWorkerName)`. The egress door becomes the namespace's **outbound worker** (a first-class
WfP feature — exactly our `globalOutbound`, platform-managed); per-project CPU/memory caps become
**custom limits**; per-project logs become **tail workers**. The runner as a script disappears:
platform capabilities are service bindings injected at upload time, and "deploy the project" is a
real `PUT /dispatch/namespaces/:ns/scripts/:name` with the user bundle.
**Pitch:** we stop maintaining our own loader/build/cache/serve envelope — Cloudflare's
multi-tenancy product does confinement, limits, and egress interception natively, and per-project
observability falls out.
**Key trade-off:** the edit-to-live loop becomes a real deploy (seconds, API-rate-limited) instead
of a warm Worker Loader isolate keyed by content hash — today's instant repo-edit → serve feel
dies, and dispatch namespaces don't cross accounts, so level 2 still needs everything in §1.3
anyway. WfP is also an enterprise-priced dependency exactly where we're most locked in, with its
own sharp corners (user Workers lose `caches.default` and gradual deployments —
[WfP limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)).

### R-2: "The kernel is the whole product" — one worker, OS is just a project

Collapse the split entirely: ship the 854-line kernel as _the_ platform worker — ingress, wall,
directory, confinement, one egress door, `/api` — and move **everything else into userspace**,
including the dashboard, the agent loop, and the front desk beyond `projects.get`. The OS
dashboard becomes a project like any other (`os-as-a-project`): a vessel app served through the
same confinement, holding a `project-app-session`, calling the same `/api`. Streams, agents, and
repos are SDK code running in _project_ workers against two platform primitives the kernel grows:
a durable log capability and a secrets/egress door. iterate-the-company operates the biggest
deployment of a tiny, finishable kernel.
**Pitch:** maximal conceptual integrity — one ~1,500-line auditable trusted core, everything else
demonstrably userspace; self-host is trivially credible because hosted _is_ self-host plus a wall.
**Key trade-off:** it's a rewrite wearing a simplification costume. The durable log, processor
hosting, sandboxes, and the build pipeline are years of hardened behavior in apps/os DOs that
would have to be re-expressed as kernel capabilities + SDK, with a full data migration; and
"dashboard is just a project" fights R14's guarantee (the control plane must survive a broken
config worker) unless the kernel grows special cases that erode the purity that justified it.

### R-3: "An account per project" — the control plane is a provisioner

Take Part 0's held idea to its limit: **every project is its own Cloudflare account** (created via
the tenant/partner API), containing exactly one runner deployment and that project's data. The
control plane keeps only: the directory, ingress (our edge forwards to per-account runner
endpoints over the persistent capnweb/HTTP path — the level-2 machinery becomes the _only_
machinery), billing aggregation, and the provisioning engine. Isolation between projects becomes
Cloudflare's account boundary — budgets, limits, blast radius, even compromise containment — and
"BYO account" stops being a tier: it's the architecture, and the only question is who owns the
account.
**Pitch:** the strongest possible multi-tenancy story with zero custom confinement code
load-bearing for cross-_project_ isolation (Worker Loader still confines code _within_ a
project); "move to your own account" is a billing transfer, not a migration.
**Key trade-off:** every hosted request pays the cross-account path (no service bindings, ever —
our own hot path rides the WAN transport), cold-start and quota management multiply by project
count, and account provisioning at signup speed requires a Cloudflare partnership relationship
that is a business dependency, not an engineering one. The per-project fixed costs (KV namespaces,
container builds, gateway configs) also stop amortizing entirely.

---

_Grounding: `apps/os/docs/simplification/self-hosting-plan.md` (Part 0, R1–R14, D1–D12),
`clean-room-status.md`, `apps/kernel/src/_`(read in full),`apps/os/src/{worker,env,auth,ingress}.ts`,
`apps/os/src/README.md`, `apps/os/docs/{worker-topology,architecture-and-operations}.md`,
`apps/os/src/domains/{itx/itx-entrypoint,projects/egress,workers/worker-runner}.ts`,
`apps/os/config-repo-template/worker.ts`, `envs.ts`, and the apps/auth contract
(`apps/auth-contract/src/worker.ts`, `apps/auth/src/server/project-directory.ts`).\*
