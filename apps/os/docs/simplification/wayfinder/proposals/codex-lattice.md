# The project lattice

**Recommendation:** split Iterate into two deployable roles, keep one
project-shaped contract between them, and make placement a manifest rather than
a programming model.

The whole design can be remembered as:

> **Two workers, one project endpoint, two transports, one placement manifest.**

The control plane knows which project to call. A project runner knows how to run
exactly one project-shaped authority. In one Cloudflare account the call uses a
Service Binding. Across accounts, or into a machine behind NAT, the runner dials
out and the same authority is carried over a bidirectional Cap'n Web session.
Everything above and below that seam is unchanged.

This proposal deliberately builds on the decisions in the
[self-hosting plan](../self-hosting-plan.md), the
[clean-room kernel](../../../../kernel/README.md), and the current
[OS topology](../../worker-topology.md). It is a decomposition of the current
system, not a replacement product.

## 1. The proposal

### 1.1 The three concepts

There are only three architectural concepts:

1. **Control plane** — a multi-project Worker. It owns public ingress, the
   hostname-to-project directory, human authentication and membership,
   provisioning, placement records, and the dashboard/MCP front doors. It may
   also supply metered platform capabilities such as Iterate-managed AI and
   integrations.
2. **Project runner** — a project-scoped Worker authority. It owns project
   state, the durable event log, secrets, files, agents, config-worker loading,
   and the first egress door. It has no hostname directory and no human
   authentication wall. It accepts already-authorized, project-bound grants.
3. **Project link** — the uniform interface between them. It has an ITX facet
   and a `fetch` facet. A same-account link is a Workers RPC/HTTP Service
   Binding. A remote link is a persistent, reconnectable Cap'n Web session.

The config Worker is still important, but it is guest code _inside_ the runner,
not a third infrastructure plane. Auth can remain a separately deployed service
behind the control plane. Builder and typechecker workers can remain sidecars.
None of those facts leak into the project contract.

```text
 browser / MCP / webhook
            |
            v
   +-------------------+       Project link       +-------------------+
   |   CONTROL PLANE   | =======================> |  PROJECT RUNNER   |
   | many projects     |  RPC/fetch or Cap'n Web  | one project scope |
   | wall + directory  | <======================= | state + execution |
   +-------------------+   platform capabilities  +---------+---------+
                                                               |
                                                        explicit ITX only
                                                               |
                                                    +----------v----------+
                                                    | config / agent code |
                                                    +---------------------+
```

“One project” is an authority boundary, not necessarily one paid Worker script
per hosted project. A hosted runner deployment may receive a project ID in
trusted entrypoint props, as the current `ProjectWorkerEntrypoint` does, but
every resulting endpoint, binding, Durable Object name, and guest capability is
scoped to that one project. A BYO or local runner will normally be configured
for only one project. This lets the hosted fleet stay economical without
reintroducing a directory or cross-project authority into the runner.

### 1.2 One project endpoint

The project endpoint has two facets:

- **ITX** is the project capability tree: streams, agents, files, secrets,
  repositories, integrations, AI, and system operations. On the network it is
  still the existing `/api` Cap'n Web door. Its public object graph remains
  `UnauthenticatedOs.authenticate(...) -> Session.projects.get(...) -> Project`
  during migration, so existing clients and credential lanes keep working. The
  runner's directory is trivial: a grant can resolve only its bound project.
- **Fetch** serves the project's config Worker and app routes. It takes a normal
  request plus a control-plane-issued ingress grant and returns a normal
  response. The runner removes the grant before invoking guest code.

The two facets are one endpoint because they need identical placement,
authentication, observability, and failure semantics. They are not forced
through one wire representation:

- Same account: Workers RPC carries ITX capability calls; Service Binding
  `fetch()` carries `Request`, `Response`, streams, and WebSocket upgrades.
- Remote: Cap'n Web carries ITX object references. A tiny standard
  `FetchTarget` represents request bodies, response bodies, and upgraded socket
  halves as pull-based capabilities on that same session. Pulls carry byte
  limits, so backpressure is end-to-end; no side has to buffer an unbounded
  body. This adapter is kernel code, never project code.

This is intentionally _not_ the old project-configurable `remoteCapability`.
Remote placement is trusted deployment configuration, not a URL and headers
chosen by project code. `/api` terminates normally at each edge and remote
capabilities are re-exported by a placement membrane. Fetch and upgraded
WebSockets have a tested streaming adapter rather than relying on a transparent
HTTP `101` proxy. Before implementing it, re-read the failure that led to the
old mechanism's removal in #2156 and turn each failure mode into a conformance
test.

Every endpoint must pass the same transport-neutral suite:

- authenticate and acquire exactly one project;
- invoke, pipeline, pass, and release capabilities;
- stream a large request and response with bounded memory;
- cancel work from either side;
- relay an upgraded WebSocket in both directions;
- disconnect during a mutation, reconnect, and reacquire the root;
- reject a stale placement generation and a grant for another project.

### 1.3 Two transports, selected once

The control plane resolves a project to a `ProjectLink` once. Callers never
branch on hosted versus remote.

**`ServiceProjectLink`** wraps a statically configured runner Service Binding.
The project ID and delegated actor are trusted entrypoint props. This is the
hosted path and the normal full-self-host path when both workers share an
account.

**`CapnWebProjectLink`** wraps a live remote session. Cap'n Web is symmetric, so
the party that opened the socket can immediately export a `ProjectEndpoint` and
receive a `PlatformEndpoint`. The runner can therefore dial out through NAT and
still be called by the control plane. The reverse capability supplies only the
platform services named in the placement manifest.

Each remote project has:

- a **Link Broker Durable Object** in the control-plane account, keyed by link
  ID, which accepts the socket, authenticates it, holds the current remote
  endpoint, and serializes link replacement;
- a **link agent** beside the runner: a normal process for local/container
  runners, or a small runner-side Durable Object for Cloudflare runners;
- a monotonically increasing **lease epoch**. A newer authenticated connection
  atomically replaces an older one. Calls carry both placement generation and
  lease epoch, so a stale socket cannot accept work after a move or reconnect.

The link credential authenticates the two deployments, not a user. The
control-plane wall authenticates a user or machine, checks membership, and
mints a short-lived **project grant** containing issuer, audience, project ID,
actor/audit identity, allowed surface, placement generation, expiry, and nonce.
The runner verifies that grant and returns a scoped ITX capability. It never
receives an Access cookie, queries the organization directory, or grows its own
wall.

The initial implementation can extend the existing 15-minute
`project-app-session` wire shape and provision a per-placement verifier. The
destination should be an asymmetric signed grant so a runner holds only a
public verification key. The born `project-secret` remains the project-scoped
machine credential and recovery/bootstrap lane; it is not the long-lived
cross-account transport secret.

Remote links are persistent in the protocol sense but leased in the operational
sense. A local runner can keep its outbound socket open indefinitely. A
Cloudflare runner-side Durable Object cannot hibernate an outbound WebSocket,
so it heartbeats, reconnects with bounded exponential backoff, and renews a
short lease. If no current lease exists, ingress returns an explicit
`runner_offline` response with `Retry-After`; it does not silently queue
unbounded work. Reconnection invalidates old capability references, and callers
reacquire the project root, following the useful redial shape already proven by
Tasks' `ProjectDial`.

### 1.4 The placement manifest is the lattice

All variants use the same runner bundle and project code. A typed placement
manifest supplies the bindings:

```ts
type ProjectPlacement = {
  projectId: string;
  generation: number;
  runner: { transport: "service"; deployment: string } | { transport: "capnweb"; linkId: string };
  capabilities: {
    streams: "runner";
    files: "runner";
    secrets: "runner";
    ai: "runner" | "control-plane";
    integrations: "runner" | "control-plane";
  };
  egress: "direct" | "runner-then-control-plane";
  ingress: "control-plane";
  residency?: { r2Jurisdiction?: "eu" | "fedramp" };
};
```

The real schema will be more precise, but it should not be more clever.
Top-level capabilities are sourced locally or from the reverse
`PlatformEndpoint`; project code always sees the same ITX types. A source is
trusted operator configuration, never an arbitrary remote mount. Provisioning
rejects incoherent manifests—for example, level 2 may not place streams, files,
or secrets in Iterate's control-plane account.

This gives the useful rungs without separate products:

| Mode           | Control plane and ingress         | Runner and durable data                   | Link            |
| -------------- | --------------------------------- | ----------------------------------------- | --------------- |
| Iterate hosted | Iterate account                   | Iterate account                           | Service Binding |
| BYO data plane | Iterate account                   | Customer Cloudflare account               | Cap'n Web       |
| Full self-host | Customer account                  | Same customer account                     | Service Binding |
| Local/private  | Iterate or customer control plane | Laptop, container, or Home Assistant host | Cap'n Web       |

An entirely local `pnpm dev` runs the same two roles and connects them with a
local service adapter. `pnpm dev --connect` changes only the link to outbound
Cap'n Web and registers the local runner with a deployed control plane.

### 1.5 Ownership and the no-storage promise

The control plane may durably store control metadata: project ID, organization
membership, hostnames, placement, link public key, status, and billing counters.
It must not store level-2 project payloads, event bodies, files, prompts, secret
values, app responses, or webhook bodies.

The authoritative placement record is strongly coordinated. A KV
hostname-to-project map is only its read-optimized edge projection. Records have
states such as `provisioning`, `ready`, `moving`, and `failed`, plus a
generation. The control plane publishes a route only after the target runner
has initialized and passed a signed health challenge.

For level 2, the control plane is an HTTP edge, not a data store:

- bodies stream through memory with caching and body logging disabled;
- observability records IDs, sizes, timings, status, and classified errors, not
  payloads;
- a webhook is acknowledged only after the runner durably accepts its
  idempotency key and event;
- when the runner is offline, the default is a retryable failure. A bounded,
  encrypted, short-TTL transit spool can be an explicit customer option, but it
  is not project state and its existence, maximum retention, deletion, and
  overflow behavior must be observable.

“Data never leaves the customer's machine” must not be used to mean “bytes
never transit the network.” Remote HTTP responses and any prompt deliberately
sent to Iterate-hosted AI necessarily transit the control plane. The precise
promise is: durable project data stays at the selected runner; only data
explicitly sent through a remote capability leaves it; Iterate does not retain
level-2 payloads at rest.

### 1.6 The kernel stays small

The runner composes a project ITX tree from sourced capabilities, then loads
config code with only:

- that project-scoped `ITX` binding; and
- `globalOutbound` redirected to the project's first egress door.

No raw KV, R2, Durable Object namespace, API token, account ID, directory, or
placement manifest enters guest code. This is exactly the clean-room
confinement boundary and the direction of the current
`DynamicWorkerRunner`.

The runner owns the durable log before it owns fancy agents. A mutation is
accepted when its project-local durable authority records it, not when the
control plane saw it. Integrations and AI may be remotely sourced, but their
results are recorded back in the runner before subsequent durable processing
depends on them.

### 1.7 Moving up and down

Movement changes a placement record, not project code:

1. provision the target runner from the same pinned runner build;
2. copy project-owned data and verify counts/hashes (the detailed live data
   migration protocol remains a separate design);
3. place the source in a bounded read-only/catch-up state;
4. run the endpoint conformance suite and a project semantic smoke on the
   target;
5. atomically advance the authoritative placement generation;
6. publish the KV route projection and wait for its global safety window;
7. drain old requests, retain a time-bounded rollback copy, then destroy it by
   an explicit command.

Project ID, hostname, config bundle, credentials, and ITX types stay stable.
Moving hosted → BYO → full self-host → local therefore needs a provisioning
script and data transfer, but no code edit.

## 2. Scripts

There should be a small public workflow over the existing app-local deployment
primitives. All commands emit a versioned, redacted JSON manifest as well as
human-readable progress; all mutations are idempotent and resumable.

| Command                                                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm cli lattice bootstrap --mode hosted                         | self-host                                                                                                                                                                                                                                                                                                                                                                                       | local` | Bring up a complete system. For Cloudflare, ensure and deploy the control plane first, then runner, create the service binding or link registration, configure the first domain and admin, and run end-to-end smoke tests. For local, start both roles and local resources from the same manifest. |
| `pnpm cli lattice provision-runner --project <id> --account <id>` | The D11 cross-account path. Using the customer's one-shot Cloudflare credential, discover the account, ensure runner resources, deploy the exact pinned runner artifact, install runner secrets, establish the link identity, and return resource IDs, runner build digest, public key, link ID, residency, and rollback instructions. It must not retain the customer's Cloudflare credential. |
| `pnpm cli lattice pair --project <id> --control-plane <url>`      | Pair an already-running local or private runner. Exchange a single-use claim for mutual link identity, pin the control-plane issuer, start the outbound dial, and print lease/health state. This command is usable by a Home Assistant add-on or container entrypoint.                                                                                                                          |
| `pnpm cli lattice move --project <id> --to <placement.json>`      | Plan, provision, copy, verify, cut over by generation, drain, and optionally decommission. Default is `--dry-run`; destructive cleanup requires the explicit source placement and confirmation. It never edits application code.                                                                                                                                                                |
| `pnpm cli lattice doctor --project <id>`                          | Read-only diagnosis: verify DNS/certificate, route generation, auth issuer/audience, runner build digest, link lease, capability sources, egress chain, data residency, and both endpoint facets. It returns classified failures, not a generic unhealthy result.                                                                                                                               |
| `pnpm dev` / `pnpm dev --connect <control-plane>`                 | Run the same two-worker topology locally, or pair the local runner to a deployed control plane. It records its random local ports and link ID as the current dev tooling does.                                                                                                                                                                                                                  |

Those workflows should call, not replace, narrow operator scripts:

- `ensure-resources --role control-plane|runner` remains create-only and
  idempotent. It prints discovered identifiers for review, following today's
  [`ensure-resources.ts`](../../../scripts/ensure-resources.ts).
- `deploy --role ... --artifact <digest>` validates configuration, deploys
  secrets atomically with code, and smokes the exact version, following today's
  [`deploy.ts`](../../../scripts/deploy.ts). Target runner deploys must consume
  a content-addressed artifact built by us; a customer credential must not be
  able to swap the bundle silently.
- `smoke --role ...` is independently runnable and includes a real RPC call,
  streamed fetch, WebSocket relay, durable append/read, and classified trace
  audit.
- `erase-data --role runner --project <id> --placement <id>` keeps today's
  refusal to infer destructive targets from ambient state. It never deletes a
  worker route as a side effect.

The first provisioning implementation may accept the broad account credential
chosen in D3, but should immediately introspect permissions and print the
minimal API-token policy for the next run. Long term it should use a short-lived,
scoped token. Partial provisioning is recorded step-by-step in a local
provisioning receipt; rerunning reconciles the same named resources rather than
creating siblings.

`envs.ts` remains the typed map for Iterate-operated environments. A customer's
returned placement manifest plays the same role for project runners; resource
IDs do not migrate into Doppler, and Doppler remains secret-only.

## 3. Main stories

### 3.1 Create a project

1. A user reaches the control plane through dashboard, API, or MCP. The wall
   verifies its configured issuer and audience; Auth resolves organization
   membership.
2. The control plane reserves a stable project ID and slug in the authoritative
   directory and writes a `provisioning` placement generation. Nothing is in
   the edge routing KV yet.
3. The selected placement is ensured. Hosted creation resolves the existing
   runner Service Binding. BYO creation invokes `provision-runner`. A paired
   local runner must hold a current lease.
4. The runner idempotently creates the project-local durable authority,
   appends the birth batch, and creates the born project API key. This keeps the
   useful current creation semantics in
   [`rpc-targets.ts`](../../../src/rpc-targets.ts).
5. The control plane challenges the new endpoint, checks its build digest,
   project ID, capability manifest, append/read behavior, and fetch facet.
6. Only then does it mark the generation `ready`, write the hostname projection
   to KV, and return the project capability to the caller. A failed step leaves
   a classified, resumable `failed` record, never a routable half-project.

### 3.2 Hosted serving

1. A request reaches the Iterate control-plane Worker on an Iterate project
   hostname or an attached custom hostname.
2. Ingress resolves hostname → project ID → ready placement. Control-plane
   surfaces require the wall; a project's public app route follows that app's
   own policy.
3. The placement resolver returns `ServiceProjectLink`. The control plane calls
   the runner's `fetch()` through its same-account Service Binding with trusted
   project and actor props.
4. The runner constructs the project ITX tree, loads the config Worker with
   only ITX and scoped egress, and returns its streaming response.
5. The control plane adds only edge headers/telemetry and returns it. Durable
   state was touched only by the runner.

The ITX path is identical: `/api` authenticates at the control plane, membership
selects a project, and the returned project capability is a membrane over the
same runner entrypoint.

### 3.3 Full self-host on its own domain

1. The operator runs `lattice bootstrap --mode self-host` with an account,
   zone, Access issuer/audience, and desired hostname bases.
2. The script deploys the same control-plane and runner artifacts into that
   account, creates their data resources, binds control plane → runner, and
   configures a wildcard or explicit custom domains.
3. The customer control plane verifies the customer's Access JWTs and owns its
   Auth/directory. The runner still has no wall.
4. Project requests use the same same-account Service Binding path as Iterate
   hosted. The only differences are manifest values, account-owned secrets,
   and domains.
5. Updates deploy compatible runner first, then control plane, then remove old
   contract fields. The operator owns update timing and receives a manifest
   diff before mutation.

There is no call to Iterate in the request, data, auth, AI, or egress path unless
the operator explicitly sources an Iterate capability.

### 3.4 BYO Cloudflare account: our control plane, your data

1. The customer creates the project in Iterate and runs the printed
   `provision-runner` command against its Cloudflare account.
2. The script deploys the same runner bundle and its Durable Object/R2/KV
   resources, then pairs that runner to the project's Link Broker. The runner
   dials out; no cross-account Service Binding is attempted.
3. A browser request still lands on Iterate's control plane. The edge resolves
   placement, authorizes it, and invokes the remote `fetch` capability.
4. Headers and body stream down the link. The customer runner executes config
   code and writes events/files/secrets only to customer bindings. Its response
   streams back over the same link.
5. Iterate retains route, membership, metering, sizes, timings, and result
   classification. It does not retain request/response bodies or project
   state. Cache and payload logging are disabled for this lane.
6. Webhooks are successful only after customer storage acknowledges them. An
   offline runner yields a retryable response or the customer's explicitly
   selected short-TTL transit policy.

Iterate is the first and last HTTP contact, but never the durable data plane.

### 3.5 Local `pnpm dev` or Home Assistant runner behind our control plane

1. `pnpm dev --connect` or a Home Assistant add-on starts the identical
   project-runner contract with local adapters for the durable log, files, and
   secrets.
2. `lattice pair` consumes a single-use claim. The local process verifies the
   control-plane issuer and opens an outbound `wss:` connection, which works
   through ordinary NAT/firewalls.
3. It exports its project endpoint. The control plane can now invoke it because
   Cap'n Web has no protocol-level client/server direction.
4. Project apps, MCP, and dashboard work through the normal hostname and `/api`
   doors. Home Assistant data is read locally. Only the explicit results,
   requests, or remote capability calls chosen by project code cross the link;
   no project database is replicated into the control plane.
5. If the laptop sleeps, the lease expires and the UI reports
   `runner_offline`. On wake, the process reconnects, obtains a new epoch, and
   callers reacquire capabilities. There is no hidden infinite retry or
   control-plane backlog.

A wholly local `pnpm dev` skips pairing and uses the local link adapter, but all
project code and ITX types are identical.

### 3.6 MCP connect → emerge with a project

1. An MCP client connects to the control-plane MCP endpoint and completes the
   normal human OAuth/Access flow or machine credential flow.
2. Before a project exists, it receives only an account-scoped bootstrap
   capability: list allowed placements, create project, inspect provisioning,
   and reconnect. It does not receive a synthetic all-powerful ITX root.
3. `createProject({name, placement})` runs the creation state machine above and
   streams classified progress.
4. When the ready generation is published, the bootstrap capability returns a
   project-scoped MCP/ITX handle. The session has “emerged” into the project;
   subsequent tools are generated from the ordinary project ITX tree.
5. Reconnect repeats authentication and directory lookup, not provisioning.
   The stable project ID resolves to whatever rung it occupies now.

Thus MCP is another vessel over `/api`, not a parallel management API.

### 3.7 Agent LLM call through ITX

1. Agent or config code calls the typed `itx.ai.run(...)` capability. It cannot
   read an AI provider token.
2. The runner's capability resolver consults the placement manifest:
   - `ai: "runner"` invokes a customer/local Workers AI binding or provider
     egress beside the data;
   - `ai: "control-plane"` invokes the reverse `PlatformEndpoint` over the same
     Cap'n Web session or the same-account binding.
3. The control-plane implementation applies project budget, model policy,
   metering, and AI Gateway/provider credentials. Its credential never crosses
   the capability boundary.
4. Tokens stream back to the caller. The runner records the chosen model,
   provider request ID, usage, and durable result needed for replay before the
   agent advances.

For a sovereignty-sensitive local project, the manifest must source AI locally.
Selecting Iterate AI explicitly allows prompt/result transit and must state any
provider or AI Gateway retention; “no project data at rest in the control
plane” must not obscure downstream provider logging.

### 3.8 Two-level egress across accounts

Every dynamic/config Worker has exactly one network path:

```text
guest global fetch
      |
      v
runner egress door  -- local policy, local secret expansion, audit context
      |
      +---- egress: direct -------------------------------> Internet
      |
      +---- egress: runner-then-control-plane
                         |
                         v
                 Cap'n Web egress capability
                         |
                         v
                 control-plane egress door -- plan, meter,
                                              platform secret expansion
                         |
                         v
                      Internet
```

The first door always exists and is the only `globalOutbound` visible to guest
code. It rejects forbidden destinations, attaches project/operation context,
and expands only customer-owned placeholders. If configured to chain, it
passes a sanitized request to the control-plane egress capability. The second
door applies Iterate policy, spend limits, and only Iterate-owned placeholders.
Secret namespaces make double substitution impossible.

The response returns through both doors so both can classify duration, bytes,
status, and failures without logging bodies. Direct egress supports full
self-host and strict locality. Chained egress supports level 2's “our platform
is last HTTP contact,” central billing, and integrations whose credentials must
stay with Iterate.

## 4. Difficulties and trade-offs

### Cross-account latency and chattiness

A same-account Service Binding is effectively local; a remote link adds at
least one geographic round trip and serializes through a WebSocket. Fine-grained
capability calls that were cheap in one isolate become expensive. Promise
pipelining helps dependent calls, but the API still needs coarse operations for
hot paths, batching for event delivery, stream backpressure, and placement of
compute beside state. The trace model must show each cross-link span and bytes,
not hide it inside a generic RPC duration.

### Long-lived outbound WebSockets

Cloudflare's WebSocket hibernation applies to the server/accepted side, not the
outbound client side. The runner-side link Durable Object therefore costs
duration while kept awake, and an outbound connection stops preventing eviction
after the documented window. Heartbeats, alarms, lease expiry, and reconnect
make this bounded, but they do not make it free. This path needs a multi-hour
preview soak, forced eviction/network partition tests, and cost measurement
before level 2 is claimed production-ready. A future Cloudflare-native
connector or hibernatable outbound primitive could replace only the link agent.

### Authentication is two different problems

Mutual link identity says “this is the paired runner”; a project grant says
“this actor may do this operation on this project now.” Combining them into one
long-lived bearer secret would make revocation, audit, and project moves unsafe.
Grants require clock-skew policy, key rotation, audience pinning, nonce/dedup
rules for mutations, and explicit behavior when Auth or the link is unavailable.
The runner must fail closed without growing a second organization directory.

### No-store is harder than no database table

CDN cache, exception capture, request logs, AI Gateway logs, temporary spools,
analytics payloads, and support tooling can all become accidental storage.
Level 2 needs an enumerated data-flow audit, payload-free telemetry schemas,
cache bypass tests, retention assertions, and a canary payload that is searched
for across all Iterate stores. Short-TTL transit buffering is a named product
choice, not an invisible reliability fallback.

### NAT and offline semantics

Outbound dialing solves reachability, not availability. Laptops sleep, routers
rebind, and Home Assistant restarts. A lease makes the state truthful.
Interactive requests fail quickly with a stable error. Webhook senders retry
only when their protocol supports it. Scheduled work whose durable source is
the runner resumes there after reconnect. The control plane never invents
exactly-once delivery; mutating calls have operation IDs and the runner's
durable authority deduplicates acceptance.

### Provisioning another account

Cloudflare APIs are eventually completing workflows, not one transaction:
resource creation, Worker upload, secret installation, routes, DNS validation,
and certificates can each partially succeed. API permissions and plan
entitlements differ. The provisioner needs deterministic names, create-or-read
steps, receipts, bounded polling, permission preflight, and a reversible
failure report. It must not make deletion part of normal retry. Custom hostname
certificate activation and R2 jurisdiction are explicit readiness gates.

### Routing consistency

KV is an excellent global hostname projection but not an atomic project
registry. Newly created and moved routes can be stale at an edge. Generation
checks at the runner prevent stale authority, while the control plane falls back
to the authoritative registry on a miss/mismatch and refreshes the projection.
Moves must budget the KV propagation window rather than declaring instant
global cutover.

### Resource and sovereignty boundaries

Cloudflare resources cannot simply be rebound across accounts. Durable Object
IDs/namespaces, R2 buckets, KV, secrets, AI accounts, and custom hostnames need
new target resources and explicit data transfer. R2 jurisdiction is chosen at
creation and cannot later be changed. “Move by config” means no application
code change; it does not mean moving terabytes is instantaneous or free.

### Streaming and WebSocket correctness

ITX capability forwarding is easier than arbitrary app traffic. Request and
response cancellation, half-close, backpressure, header filtering, client
disconnects, and upgraded WebSockets all cross two independent sessions.
This is why `fetch` is an explicit facet with a conformance suite, rather than a
claim that generic RPC automatically proxies HTTP.

### Version skew

Control plane and runner move independently. The link handshake exchanges
contract version, runner artifact digest, feature bits, and minimum compatible
version. Changes are additive first: deploy runner, deploy control plane,
migrate, then remove. An incompatible link is a classified provisioning or
upgrade error, never a best-effort compatibility shim.

## 5. Fragments of knowledge

These facts are load-bearing. If one changes, revisit the design.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Consequence for this proposal                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Cloudflare Service Binding target “must be on your Cloudflare account”; the binding supports both RPC methods and HTTP `fetch`, and same-account calls normally run on the same thread/server. [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)                                                                                                                                                                                                                                        | Workers RPC is the correct fast in-account transport, but it is not a cross-account plan. Cross-account traffic needs an authenticated network transport.                                                             |
| Cap'n Web is symmetric: either party can call capabilities exported by the other, and callbacks/objects are passed by reference over a WebSocket or custom transport. [Cloudflare's Cap'n Web introduction](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)                                                                                                                                                                                                                                                                                 | A runner behind NAT can dial out, export its project endpoint, and still be called “inward”; the same socket can carry platform capabilities back to the runner.                                                      |
| Accepted WebSockets can hibernate in a Durable Object, but outbound WebSockets cannot; an outbound connection keeps an object alive for at most 15 minutes before normal eviction rules resume. [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)                                                                                                                                          | Put the accepting broker in the control plane, treat the runner's outbound session as a renewable lease, and measure heartbeat/reconnect cost. Do not promise an immortal socket.                                     |
| SQLite-backed Durable Object storage is transactional, strongly consistent, and private to one object. [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)                                                                                                                                                                                                                                                                                                                                               | It is suitable for the authoritative per-project log/state and for serialized placement/link state.                                                                                                                   |
| Workers KV reads are eventually consistent; changes and even negative lookups may remain stale for 60 seconds or more, and KV is not an atomic transactional store. [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)                                                                                                                                                                                                                                                                                                          | KV is a hostname routing projection, never the sole source of truth for project creation, moves, or revocation.                                                                                                       |
| Dynamic Workers receive only explicitly supplied custom bindings; capability references cannot be forged. `globalOutbound: null` blocks network, while a service stub redirects it. [Dynamic Worker bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/) and [Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)                                                                                                                                                                                      | The clean-room kernel's `ITX` plus scoped egress is a real confinement boundary, not convention. Keep raw resources and placement out of guest code.                                                                  |
| Cloudflare for SaaS can attach customer vanity domains as custom hostnames, while a wildcard dispatch route can route subdomains and vanity domains by KV or hostname metadata. [Custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/) and [hostname routing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/)                                                                                                              | One control-plane ingress Worker can serve Iterate hostnames and customer domains. Certificate/DNS status is part of provisioning readiness. Custom metadata is an optional optimization, not a required registry.    |
| A Worker behind Access must still validate the `Cf-Access-Jwt-Assertion` header against the account JWKS, issuer, and application audience; the application token carries `aud`, `iss`, and `sub`. [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) and [application-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)                                 | The clean-room wall has the right shape. Validation belongs at the control plane; the runner receives a narrower delegated grant, not an Access token.                                                                |
| Cloudflare Tunnel demonstrates the same reachability property: an outbound-only connector enables traffic back into an origin with no inbound firewall rule. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)                                                                                                                                                                                                                                                                                | Outbound runner dialing is a well-founded NAT pattern, although Iterate's application protocol remains Cap'n Web rather than making `cloudflared` mandatory.                                                          |
| Workers AI is available through a Worker binding and can stream output. AI Gateway also has an account-authenticated REST surface, but Gateway Run tokens are account-scoped rather than restrictable to one gateway. [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/), [AI Gateway REST](https://developers.cloudflare.com/ai-gateway/usage/rest-api/), and [Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)                                             | Wrap AI in a project capability. Never give a remote runner an Iterate AI Gateway token; enforce tenant scope in the control-plane Worker or isolate accounts.                                                        |
| R2 jurisdiction restrictions guarantee storage within a selected jurisdiction, and jurisdiction cannot change after bucket creation. [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)                                                                                                                                                                                                                                                                                                                                   | Residency belongs in the provisioning manifest and a move may require a new bucket plus verified copy.                                                                                                                |
| Workers for Platforms supplies dispatch namespaces, isolated user Workers, outbound Workers, and effectively unlimited tenant scripts. [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)                                                                                                                                                                                                                                                              | It is a good hosted implementation option for guest-code scale, but it does not erase the cross-account boundary or replace the project link.                                                                         |
| The clean-room POC already loads config code with only project ITX and controlled outbound, reserves dashboard paths, implements the `/api` door, and verifies an issuer/audience wall. [Kernel README](../../../../kernel/README.md), [kernel source](../../../../kernel/src/kernel.ts), and [wall](../../../../kernel/src/wall.ts)                                                                                                                                                                                                                     | The runner should promote this small confinement skeleton, then replace only its in-memory capabilities with the current durable implementations.                                                                     |
| Current OS already has a canonical `itxForScope`, project-secret and project-app-session credential lanes, a born project API key, a project-scoped Workers RPC entrypoint, a Dynamic Worker runner with ITX and egress only, and one project egress choke point. [`rpc-targets.ts`](../../../src/rpc-targets.ts), [`auth.ts`](../../../src/auth.ts), [`itx-entrypoint.ts`](../../../src/domains/itx/itx-entrypoint.ts), [`worker-runner.ts`](../../../src/domains/workers/worker-runner.ts), and [`egress.ts`](../../../src/domains/projects/egress.ts) | Split and reuse these boundaries. Do not rebuild a smaller but incompatible OS beside them.                                                                                                                           |
| Current `/api` already supports Cap'n Web over WebSocket and HTTP batch transport; Tasks' `ProjectDial` already authenticates over a WebSocket session and reacquires after failure, while `config-bridge.ts` proves the stateless vessel/reverse-proxy shape. [`worker.ts`](../../../src/worker.ts), [`checkout-do.ts`](../../../../tasks/src/checkout-do.ts), and [`config-bridge.ts`](../../../../tasks/src/config-bridge.ts)                                                                                                                         | Build the remote link as a hardened placement transport on the existing door and credential lanes. The new work is pinning, reverse export, streaming fetch, leases, and operational proof—not inventing another API. |
| Today's deployment scripts already separate idempotent create-only resource ensuring, typed IDs in `envs.ts`, atomic code+secret deployment, smoke checks, and explicit destructive erasure. [`ensure-resources.ts`](../../../scripts/ensure-resources.ts), [`deploy.ts`](../../../scripts/deploy.ts), [`erase-data.ts`](../../../scripts/erase-data.ts), and [`envs.ts`](../../../../../envs.ts)                                                                                                                                                        | Generalize these into role-aware bootstrap/provision/move workflows instead of introducing Terraform state or a second deployment philosophy.                                                                         |

## 6. Three radical reshapings

These are intentionally not variants of the recommendation. Each removes a
load-bearing premise.

### 6.1 Sovereign projects; no always-on control plane

**Pitch:** every project runner is its own origin, wall, directory slice, and
MCP endpoint. DNS or a signed public directory points clients directly to it.
Iterate operates an optional discovery, billing, and update service, but no
request proxy. A local project uses a Cloudflare Tunnel or user-managed relay
only when it wants public reachability.

This is the purest sovereignty story: BYO and full self-host are the default,
cross-account latency disappears from project operations, and Iterate cannot
retain data it never sees. Movement is DNS plus state transfer.

**Key trade-off:** every runner now needs the complexity deliberately kept in
one control plane—human auth, OAuth/MCP callbacks, hostname certificates,
integration webhooks, abuse protection, updates, and recovery. Global hosted
onboarding and metered platform capabilities become harder, offline local
runners need a separate ingress product, and revocation is eventually
distributed.

### 6.2 One Workers-for-Platforms empire

**Pitch:** put every project in Iterate's Cloudflare account as a WfP tenant
Worker. A single dispatch Worker routes hostnames directly to isolated user
Workers; outbound Workers mediate all network and platform access. Store project
data only in platform-selected tenant resources. Eliminate the control
plane/runner link entirely.

This is operationally beautiful for the hosted product: one edge hop, native
tenant limits and observability, effectively unlimited scripts, and no
persistent cross-account sessions. The project itself is the deployable unit.

**Key trade-off:** BYO-account and local become exports to a different product
rather than rungs of the same system. Account-bound bindings and platform
namespaces dominate the model, customers must trust Iterate's account as the
data plane, and moving out requires translating Cloudflare-specific resources.
It optimizes the present hosted case by abandoning the north star.

### 6.3 Everything is a replicated command log; no live project RPC

**Pitch:** control plane and runners never hold capability references to one
another. They exchange signed commands and results through per-project,
content-addressed logs. HTTP ingress appends a command; a runner syncs,
executes, and appends the result. ITX becomes a local API over that log.
Offline-first replication, deterministic operation IDs, and encrypted payloads
make location and intermittent connectivity ordinary.

This gives excellent auditability, resumability, migration, multi-runner
replication, and laptop-offline behavior. Cross-account transport can be any
object store or message relay, and durable state has a single universal form.

**Key trade-off:** interactive HTTP, token streaming, WebSockets, callbacks,
and object-capability composition become awkward simulations over an
asynchronous bus. The control plane must store encrypted transit records or
depend on a third-party relay, violating the clean level-2 “HTTP edge but never
store” promise. It replaces the proven `/api` programming model with a new
distributed system whose conflict, garbage-collection, and key-recovery
problems are much larger than the split we need.
