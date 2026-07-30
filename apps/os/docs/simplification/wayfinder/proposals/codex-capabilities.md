# The project is a capability root

This proposal makes one claim: **a project is an ITX capability tree, and placement is an
implementation detail of each branch of that tree**.

The control plane finds a project. The project runner binds its tree. Project code receives only
that tree. Whether `ITX.streams` is backed by a Durable Object in Iterate's account, a Durable
Object in the customer's account, or a local workerd adapter changes no project code and no
capability contract.

## 1. The proposal

### The whole system in three concepts

There are two main workers and one internal abstraction:

| concept                   | knows                                                         | owns                                                                                                    | must not own                                                        |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Control plane worker**  | many projects, people, hostnames, runner locations            | the wall, directory/membership, hostname routing, provisioning state, billing attribution, runner links | project payloads, repositories, stream contents, secret material    |
| **Project runner worker** | exactly one project per authenticated root                    | the project's ITX root, capability binding, confined userspace, project lifecycle, the one egress door  | fleet membership, public login, arbitrary access to another project |
| **Capability source**     | one capability contract and the project grant presented to it | the resource implementation behind one ITX branch                                                       | the entire project or a new public API                              |

A capability source is not necessarily another deployed Worker. It is a small adapter that can be
implemented by a local binding in the runner, a same-account Service Binding, or a remote
capability received over Cap'n Web. The distinction matters: **source boundaries are authority and
placement boundaries, not an instruction to create dozens of microservices**. In the hosted fast
path, the runner and its Durable Object classes can remain in one bundle, preserving the current
topology's cold-start behavior.

Compiler workers remain stateless implementation sidecars. They are not a third control plane and
do not enter the project's authority model.

```text
browser / webhook / MCP / custom domain
                    |
           control plane worker
      wall · directory · hostname route
                    |
          one ProjectRunner contract
             /                 \
 same account: Workers RPC      other account / local: Cap'n Web WebSocket
             \                 /
              project-scoped ITX
          /        |       |       \
      streams    repos   secrets    ai       ...
       yours     yours    yours     ours
          \        |       |       /
            one project egress door
                       |
       confined config Worker / agents / apps
```

This is the two-worker model in the
[self-hosting plan](../self-hosting-plan.md), with R5 taken literally. The runner is not a proxy
to a monolithic `ProjectRpcTarget`; it is the authority that assembles independently sourced
targets into one attenuated tree.

### One public object model

Keep the useful shape that exists in both systems:

```ts
Os.authenticate(credentials) -> Session
Session.projects.get(slug) -> ProjectITX
ProjectITX.create(options?) -> ProjectITX
```

Addressing an unknown slug remains side-effect free. The returned handle is prospective until
`create()` succeeds; other operations fail with a typed `project_not_born` outcome. This retains
the clean-room API and current apps/os behavior without introducing a second project object.

The project runner exposes the same root in both transports:

```ts
interface ProjectRunner {
  authenticate(grant: ProjectGrant): ProjectITX;
}
```

`ProjectGrant` is opaque, short-lived, audience-bound, and limited to one project and one caller.
For same-account calls, the control plane invokes this class through a Service Binding. For
cross-account calls, it invokes the same `RpcTarget` through a persistent bidirectional Cap'n Web
session. `/api` is the Cap'n Web door. There is no parallel REST model and no "remote project"
facade with different semantics.

The statement that a runner knows one project is about **authority**, not necessarily one
Cloudflare script upload per project. Every authenticated root and every Loader invocation is
fixed to one `projectId`; after binding, none of its methods accepts an arbitrary project ID. A
hosted runner deployment may serve many such roots over shared namespaces. A customer deployment
or future account-per-project deployment may contain only one. The byte-for-byte runner bundle is
the same.

HTTP serving also enters through the project root:

```ts
ProjectITX.fetch(request: Request, ingress: IngressContext) -> Response
```

Because `ProjectITX` is an `RpcTarget`, `fetch` has normal RPC semantics rather than the special
`WorkerEntrypoint.fetch` signature. `IngressContext` contains only verified, non-secret facts:
hostname, route generation, request ID, actor grant, and webhook kind if applicable. This lets
`Request`, `Response`, streams, and WebSocket upgrades travel over the selected transport without
creating a second serving interface.

The runner has no public auth wall. It validates only runner-pair credentials and project grants.
Human login, organization membership, Cloudflare Access, OAuth, and billing live at the control
plane. A self-hosted control plane may configure an open wall; that is still a wall decision, not
a runner fork.

### The capability binder is the kernel

The runner contains a deliberately small binder:

```ts
bind(projectId, capabilityName, sourceDescriptor) -> RpcTarget
```

It reads a versioned `ProjectManifest`, validates that every required source is reachable and
compatible, asks each source for a project-attenuated target, and publishes one immutable ITX root
for that manifest generation. A source gets the project ID, the minimum policy it needs, and an
unforgeable grant. It does not receive the user's full session or a fleet-wide environment.

A source descriptor has only four ideas:

```ts
{
  source: "local" | "peer",
  provider: "customer-data" | "iterate-ai" | "...",
  contract: "streams@1",
  config: { /* non-secret, capability-specific metadata */ }
}
```

- `local` means the source is available as a runner binding or loopback entrypoint. It can be in
  the runner bundle or behind a same-account Service Binding.
- `peer` means the source is an `RpcTarget` received from a mutually authenticated, pinned Cap'n
  Web peer session.
- `contract` is a small, explicit compatibility version. Providers add before they remove.
- `config` contains safe values such as an AI Gateway name, model allowlist, R2 bucket alias,
  residency, or retention policy. It never contains a Cloudflare API token or secret material.

The manifest lives with the runner. In Iterate-hosted mode the control plane is authorized to
advance it. In BYO mode the customer's provisioning process installs the accepted control-plane
identity and source policy locally; the hosted control plane may propose a new generation, but the
customer runner must authorize it. A source change is atomic: the old root continues to serve
until all new required sources bind successfully, then new requests see the new generation. There
is no silent source fallback. A broken `iterate-ai` source is an observable `capability_unavailable`
outcome, not permission to send a prompt to a different provider.

Every standard capability becomes a real mount. The ITX root owns getters and discovery, not the
implementation:

```text
ITX
├── ai
├── repos
├── streams
├── secrets
├── egress
└── capabilities.get(name)   # non-standard mounts
```

Direct standard names preserve the excellent scripting ergonomics of current apps/os. An explicit
`capabilities.get(name)` replaces prototype magic for extensions and makes collision and version
behavior legible. `ITX.__describe()` reports the safe provenance of each branch: contract version,
source label, account class (`iterate`, `customer`, `local`), region/residency, billing party, and
health. It never reports endpoints, credentials, Durable Object IDs, or raw binding names.

Nested scopes, such as an agent, receive another ITX root assembled from the same mounts but with
further attenuation. A project root may append anywhere in the project; an agent root may be
limited to its streams and workspace. This is capability passing, not repeated string-based
authorization at every leaf.

### The five load-bearing branches

The initial extraction should preserve current method shapes wherever possible. The important
change is who constructs the target.

#### `ITX.streams`

```ts
ITX.streams.get(path) -> Stream
Stream.append(...facts) -> committed facts
Stream.read(options) -> facts
Stream.follow(cursor) -> stream of facts
Stream.subscribe(processorCapability) -> subscription
```

The source owns the Stream Durable Objects, durable storage, optional R2 spill, and delivery
machinery. Stream paths are addresses, not processor names. Append remains the durable fact
boundary; creation remains an idempotent birth batch; a command that promises readiness waits for
the relevant processor offset and `/project/ready`. Moving `streams` moves the project's durable
log and processors to that source account without changing a caller.

`streams` is normally customer-sourced in BYO mode because it is the principal project data at
rest. The control plane may observe delivery metadata and usage counts, never facts or webhook
payloads.

#### `ITX.repos`

```ts
ITX.repos.get(path) -> Repo
Repo.files / Repo.git / Repo.checkout / Repo.commit / Repo.clone
```

The source owns the current Artifacts/R2-backed repository implementation and all code bytes.
`ITX.repo` can remain a convenience alias for `ITX.repos.get("/repos/config")`. In BYO mode this
defaults to the customer's account, so private source does not transit or rest in Iterate's
storage merely because Iterate supplies ingress or AI.

The compiler reads through the Repo capability or receives a content stream; it does not receive
an account-wide bucket binding. Compiled code is addressed by content/version and handed to Worker
Loader. Changing the repository source does not change config-worker imports.

#### `ITX.secrets`

```ts
ITX.secrets.get(path) -> Secret
Secret.create / update / collectFromUser / __describe
Secret.fetch(request) -> Response
```

Keep the current secret-cell invariant: ordinary secret material has no read method. Users enter
it through a purpose-built collection flow; metadata exposes presence, audit, refresh behavior,
and pinned egress origins, never value. The exceptional readable project API key remains an
explicit birth-time policy, not a generic escape hatch.

Secret placeholders remain ordinary request text, for example
`Bearer getSecret("/secrets/github/main", { field: "accessToken" })`. Interceptors see
placeholders. The secret source checks the target origin, substitutes only at the terminal egress
path, and never logs the prepared request.

The secret source and egress source may differ. When they do, substituted bytes cross the
mutually authenticated session in memory and are sent immediately by the terminal egress source.
That is the plan's explicit transit-yes/at-rest-no model. The prepared request must be
non-replayable, bound to the exact destination, method, request ID, and a short deadline; redirects
are manual and re-authorized. A stricter customer can require secrets and terminal egress to be
co-sourced so material never crosses the account boundary.

#### `ITX.ai`

```ts
ITX.ai.run(model, input, options?) -> value or stream
ITX.ai.models() -> permitted model metadata
ITX.ai.toMarkdown(...) -> conversion result
```

The source owns the Workers AI binding or provider credentials, AI Gateway selection, model
allowlist, rate/spend policy, and metering. The project sees the same contract whether AI is
Iterate-funded, customer-funded, or local. Source metadata must disclose gateway, billing party,
retention/logging mode, cache policy, and region where the platform can truthfully do so.

An AI source returns model output to the caller. The project decides whether to append that output
to its streams; the AI source records only declared billing/operational metadata. Integrated
billing is therefore a capability, not a reason to place the whole project in Iterate's account.

#### `ITX.egress`

```ts
ITX.egress.fetch(request) -> Response
ITX.egress.intercept(handler) -> disposable lease
```

There is exactly one project egress door. The runner passes it as Worker Loader's
`globalOutbound`, and it is also the implementation behind `ITX.egress`. Userspace gets no ambient
network and no raw fetch-capable binding. Platform capabilities that perform network I/O either
call this door or are explicitly modeled as their own audited egress authority.

The door is a chain, not a second capability tree:

```text
userspace request with placeholders
  -> project policy / live interceptor (placeholders only)
  -> secret source: authorize origin and substitute
  -> terminal egress source: meter, send, stream response
```

The manifest selects the terminal source. Level 2 normally selects Iterate, making Iterate the
last HTTP hop while storing nothing. Full self-host selects the customer's source. Local mode can
select the local network adapter. The chain is assembled by the binder, but only its single
`fetch` target is exposed.

### Confinement and resource ownership

The runner loads config code with exactly:

```ts
{
  env: { ITX: projectScopedItxBinding },
  globalOutbound: projectScopedEgressBinding,
  props: { projectId, codeVersion, manifestGeneration }
}
```

No raw `AI`, R2, KV, Durable Object namespace, Service Binding, Cloudflare API token, or fleet
directory enters the loaded isolate. The loaded code can reach only capabilities it was handed.
The Loader ID includes the project and immutable code version, so isolate reuse cannot cross a
project or accidentally retain changed code under the same cache key.

Durable state lives where the corresponding capability is sourced:

| state                                                | authority                                    | normal substrate                                                      |
| ---------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| organizations and membership                         | control plane directory                      | existing auth worker                                                  |
| hostname → immutable project identity                | control plane registry; KV is the read cache | directory authority + `PROJECT_DIRECTORY` KV                          |
| runner pairing and manifest generation               | project runner                               | small project metadata Durable Object/config                          |
| stream facts and processor state                     | `streams` source                             | Stream/processor Durable Objects, R2 where appropriate                |
| repos and artifacts                                  | `repos` source                               | current repository implementation, R2/Artifacts                       |
| secret ciphertext and refresh state                  | `secrets` source                             | Secret Durable Objects                                                |
| app/config isolate                                   | no durable authority                         | Worker Loader cache                                                   |
| request and webhook bodies at Iterate's level-2 edge | none                                         | memory; bounded encrypted retry buffer only when delivery requires it |

KV is never authorization. Hostname mappings should be immutable for a project identity. Deleting
a hostname tombstones it for at least the global cache horizon; reassigning it to another project
is a deliberate drain-and-cutover operation. If immediate mutable routing is later required, the
authority must be a strongly consistent routing Durable Object with KV as acceleration, not a
wish that KV has become transactional.

### The cross-account link

Each remote deployment has a `RunnerLink` Durable Object as a connection owner. It is internal to
the control plane or runner, not a third public worker.

Pairing is intentionally small:

1. Provisioning creates a one-use pairing code containing both deployment identities and expected
   public keys.
2. The runner dials the control plane's `/api` WebSocket, because this also works behind NAT.
3. Both ends prove possession, bind the session to the expected accounts/deployments, and exchange
   only their attenuated provider roots.
4. The `RunnerLink` retains the live session, heartbeat state, source contracts, and last failure.
5. Reconnect uses a rotated, revocable peer credential. It never reuses the customer's Cloudflare
   provisioning token.

All requests have deadlines and stable request IDs. Reconnect may resume transport, but it may not
blindly replay a non-idempotent capability call. Appends carry idempotency keys; ordinary reads
retry; prepared secret egress never retries after an ambiguous send. Link-down, source-down, and
deadline outcomes are distinct telemetry classes.

Cap'n Web HTTP batch remains useful for a one-shot CLI or browser call. It is not the
control-plane-to-runner transport: the batch ends and its stubs die, whereas serving, callbacks,
subscriptions, NAT traversal, and passed capabilities require a persistent bidirectional session.

### Control plane ingress is thin

The control plane performs, in order:

1. Reserve `/api`, dashboard, MCP, auth callbacks, and first-party webhook endpoints.
2. Apply the configured wall and validate its JWT or service credential.
3. Resolve the exact hostname to an immutable project identity and route generation.
4. Check membership/policy and mint a short-lived project grant.
5. Select the runner link and call the same project root used by internal RPC clients.
6. Stream the response back without buffering or durable payload storage.

Webhook ingress verifies the vendor signature before routing. It passes the original body stream
to the customer's runner, where the customer-sourced `streams` capability commits it. A bounded
retry buffer, if unavoidable, is encrypted, short-TTL, content-blind, and accompanied by durable
delivery metadata that explains every expiry. It is not a second webhook event store.

The dashboard is a vessel using the same project-scoped ITX contract, not privileged product code
inside the runner. Kernel-reserved routes mean a broken config worker cannot hide `/api` or the
dashboard. MCP is another adapter over `Session` and `ProjectITX`, not another authority model.

### How this grows out of the two existing systems

This proposal is an extraction, not a replacement:

- Keep the current authentication credential lanes, project-app-session grant, side-effect-free
  project addressing, project birth batch, stream processor semantics, secret cells, repository
  implementation, one egress decision point, and Worker Loader confinement.
- Keep the clean-room worker's tiny wall, directory modes, hostname resolution, dashboard vessel,
  `env.ITX` loopback binding, and `globalOutbound` redirection.
- Split current `rpc-targets.ts` by standard capability contract. At first, every source adapter is
  `local` and wraps exactly the existing class and binding. This is a mechanical seam with no data
  migration.
- Move `ProjectITX` construction into the runner and leave session/directory/ingress in the
  control plane. Put a Service Binding between them. This proves the two-worker boundary in one
  account.
- Replace selected local adapters with peer adapters one capability at a time. `ai` is the first
  low-state proof; `streams` and `repos` then prove account-owned data.
- Do not split every Durable Object into its own Worker merely because its TypeScript moved files.
  Extract a deployment only when placement, release cadence, authority, or measured performance
  requires it.

The desired end state has small files because it has small authorities:

```text
control-plane/
  ingress · wall · directory · routing · runner-link
runner/
  project-root · binder · loader · egress
capabilities/
  ai · repos · streams · secrets · ...
```

The enormous current target becomes a composition root plus independent targets, not another
framework.

## 2. Scripts

The scripts should describe outcomes, not Cloudflare products. All are thin TypeScript entrypoints
over shared libraries; dashboards, CI, MCP, and humans call the same underlying operations.

| script                                                                    | purpose and contract                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                                | Start one local control plane, one local runner, and local capability sources with the production contracts. Defaults to open wall and local data. `--control-plane <url>` pairs the local runner outward to a hosted control plane. `--remote ai` may source only AI from the logged-in Cloudflare account. Prints every capability source and data-residency choice before accepting traffic. |
| `pnpm ensure-resources --env <name> --role <control-plane\|runner\|both>` | Idempotently create the namespaces, KV, R2, routes, Access/SaaS prerequisites, and service bindings needed for that role. Returns a non-secret deployment descriptor. It does not deploy code, mutate project data, or retain an API token. This evolves the existing `ensure-resources`.                                                                                                       |
| `pnpm run deploy --env <name>`                                            | Build the control-plane and runner bundles once, assert the runner hash is identical across placement profiles, deploy dependencies before callers, install secrets atomically, and run smoke tests. It uses the typed `envs.ts` map rather than divergent Wrangler files.                                                                                                                      |
| `pnpm runner pair --project <slug> --control-plane <url>`                 | Perform the one-use mutual pairing handshake, pin both deployment identities, install the initial manifest, and prove a reconnect. A local/home-assistant runner always dials outward.                                                                                                                                                                                                          |
| `pnpm project create <slug> [--env <name>]`                               | Invoke the exact `Session.projects.get(slug).create()` saga used by UI and MCP, print progress from durable state, and return only after the requested readiness barrier. It is not a provisioning backdoor.                                                                                                                                                                                    |
| `pnpm project configure <slug> --set <capability>=<source>`               | Validate and propose one manifest generation, show a residency/billing diff, bind every new source, then atomically activate. It refuses incompatible contracts and never falls back. In BYO mode the runner requires its local authorization policy.                                                                                                                                           |
| `pnpm runner doctor [--project <slug>]`                                   | Read-only proof of wall configuration, directory authority, route generation, link identity, manifest generation, provider contracts, source health, egress path, and storage residency. Redacts all credentials and payloads.                                                                                                                                                                  |
| `pnpm smoke --env <name> [--project <slug>]`                              | Exercise `/api` over the configured transport, pipeline authentication and project lookup, serve a request, append/follow a canary stream, call only explicitly enabled metered capabilities, and verify telemetry classifications. It cleans up only its namespaced canaries.                                                                                                                  |
| `pnpm project export <slug>` / `pnpm project import <slug>`               | Eventually implement R12 as capability-specific, resumable migrations with checksums and a cutover generation. Until those semantics exist, these commands should say `not_implemented`; they must not imply that copying a few KV keys moves a project.                                                                                                                                        |
| `pnpm erase-data --env <dev-or-preview>`                                  | Preserve the current explicitly destructive development tool, hard-block production, resolve and print exact targets, require a second confirmation, and leave an audit record. It is not part of normal self-host upgrades.                                                                                                                                                                    |

`git pull && pnpm run deploy --env ...` remains the self-hoster upgrade model. The deploy command
must negotiate runner/provider contract compatibility and use add-before-remove releases because
Workers and Durable Object code do not become globally consistent at one instant.

## 3. Main stories

### a. Create a project

1. A user, CLI, or MCP client authenticates at the control plane and receives a `Session`.
2. `session.projects.get("acme")` performs a side-effect-free directory lookup and returns a
   prospective project ITX handle.
3. `.create()` asks the directory authority to reserve the slug and immutable project ID with an
   idempotency key. The control plane writes durable provisioning state; it does not yet publish
   the hostname route.
4. The placement policy chooses a runner and capability manifest. Hosted resources may already
   exist. A BYO runner is provisioned and paired. Each source returns a capability attenuated to
   the new project.
5. Through the runner's `ITX.streams`, creation appends the deterministic root birth batch. Through
   `ITX.repos`, it creates `/repos/config`. Through `ITX.secrets`, it seeds the readable
   `/secrets/project-api-key` without putting material in the journal.
6. The runner waits for the project processor and config-repo processor to reach the committed
   offsets and emit `/project/ready`. Every retry addresses the same identity and facts.
7. Only then does the control plane publish immutable hostname records and mark the route ready.
   The create call returns the same now-live `ProjectITX`.
8. If any step fails, the project remains in an explicit resumable or terminal provisioning state
   with the responsible source and last durable fact. It cannot look healthy while missing its
   repository or API key.

This is the current apps/os birth saga made placement-neutral, not replaced by an eventually
consistent collection of resource creates.

### b. Hosted serving

1. `dashboard--acme.iterate.app`, `app--acme.iterate.app`, or an active SaaS custom hostname
   reaches Iterate's control plane.
2. The control plane resolves the hostname from its KV routing cache, validates the wall/session,
   checks membership, and mints a grant for the immutable project ID and route generation.
3. Its same-account runner Service Binding calls
   `runner.authenticate(grant).fetch(request, ingress)`. This is the same root available at
   `/api`, without public HTTP serialization.
4. The runner loads the config-worker version from `ITX.repo`, supplying only project-scoped
   `env.ITX`, props, and the egress binding.
5. The config worker routes to an app or handles its request. Calls such as
   `ITX.streams.get("/orders").append(...)` resolve to locally sourced targets in the normal
   hosted profile.
6. The `Response`, including streaming bodies or an upgrade, returns through the control plane.
   Reserved dashboard and `/api` routes remain reachable even if user code fails.

### c. Self-host on an owned domain

1. The operator runs `ensure-resources --role both` in their Cloudflare account, then deploys the
   same control-plane and runner bundles.
2. They configure a wildcard domain and choose `open`, KV single-tenant, an existing auth
   directory, or Cloudflare Access as their wall. Access is verified by issuer, audience, and
   signature; the mere presence of an assertion header is not trusted.
3. The control plane and runner bind through same-account Workers RPC. The initial manifest points
   streams, repos, secrets, AI, and egress at sources in that account.
4. Creating `acme` installs `acme.example.com` and sibling app hostnames in the control-plane
   registry. Any additional hostname that reaches the worker can map to the same immutable project
   identity.
5. Project code and the config repository are unchanged from hosted mode. Upgrades are the
   operator's `git pull` plus deploy; data stays in their namespaces.

Cloudflare for SaaS is optional here. It is an onboarding/certificate product, not a condition in
the runner's routing model.

### d. Bring your own Cloudflare account

1. The customer authorizes the provisioning script with a Cloudflare API token and account ID.
   The script creates the runner, its local Durable Object/R2/KV resources, and a one-use pairing
   identity. The token is not a runtime binding. If the customer asks Iterate to manage future
   upgrades, retaining a narrowly scoped token is a separate, disclosed choice.
2. The customer runner dials Iterate's control plane and both deployments pin each other. Iterate's
   route record points to that live runner link.
3. The manifest normally sources `streams`, `repos`, and `secrets` locally in the customer's
   account; it may source `ai` and terminal `egress` from Iterate over the same bidirectional
   session.
4. An `app--acme.iterate.app` request reaches Iterate first, streams down the runner link, executes
   against customer-owned data, and streams back. The response body is never durably written in
   Iterate's account.
5. A GitHub or Slack webhook is verified at Iterate's configured first-party endpoint and delivered
   to the customer's `ITX.streams`. Iterate retains routing/delivery metadata and at most a bounded
   encrypted short-TTL retry blob, never a durable event copy.
6. Outbound HTTP can return through Iterate's egress target for policy and integrated billing.
   Secret values may transit the encrypted link after origin-pinned substitution but are neither
   logged nor stored there.
7. Every usage record states which source billed it. A source outage fails explicitly; it never
   moves storage or prompts into Iterate's account as a convenience fallback.

### e. Local `pnpm dev` and home-assistant mode

There are two profiles with the same contracts:

- Plain `pnpm dev` starts both workers and local adapters under workerd/Miniflare. It needs no
  Cloudflare account if all selected capabilities are local. State uses persistent local
  directories, and restart recovery is tested.
- `pnpm dev --control-plane https://os.iterate.com` starts only the local runner and dials outward.
  Iterate supplies hostname, auth, webhook ingress, and optionally AI; the runner supplies streams,
  repos, secrets, and local egress.

In home-assistant mode, the outbound link is the route into a machine behind NAT. No inbound port
or tunnel is required. Data at rest stays on the box. Any capability selected from the cloud
necessarily receives its declared inputs in transit; `runner doctor` must make that boundary
obvious rather than promise an impossible blanket "nothing leaves."

The reliability contract is deliberately modest: restart on crash, restore local durable state,
redial, and reconcile delivery from committed offsets. The control plane returns a typed
`runner_offline` response while the link is absent; it does not silently execute the project
elsewhere.

### f. MCP connect, then emerge with a project

1. An MCP client connects to the control plane's MCP route and completes the configured human or
   service authentication.
2. The MCP adapter receives the same `Session` capability as the dashboard. It can list accessible
   projects and return a side-effect-free prospective handle.
3. Onboarding explicitly calls `projects.get(chosenSlug).create()` when the user asks to create.
   Merely connecting never mutates state.
4. When create reaches `/project/ready`, the adapter selects that `ProjectITX` as the execution
   context. Its small tool surface can run typed scripts against ITX and discover
   `ITX.__describe()`.
5. Calls, callbacks, files, and streams are passed as capabilities over the existing connection.
   There is no generated project-specific MCP server and no separate permissions database.

The user experiences "connect, choose or create, now operate inside the project"; the system
experiences one normal authenticated project session.

### g. An agent makes an LLM call through ITX

1. The agent's loaded userspace holds an agent-attenuated ITX root and calls
   `ITX.ai.run("@cf/...", input, { stream: true })`.
2. The runner's getter returns the `Ai` target already bound for that manifest generation. No
   branch in agent code examines an account ID.
3. An Iterate-sourced target adds project billing attribution, enforces the project's model and
   spend policy, selects the declared AI Gateway, and calls its bound provider. A
   customer-sourced target performs the equivalent work in the customer's account.
4. Output streams back with flow control. Usage and failure classification go to operational
   telemetry; prompt/output persistence follows the source's declared retention policy. The agent
   appends anything it wants durable to the project's own `ITX.streams`.
5. If the selected source is down or denies budget, the agent receives that exact result. Model
   fallback occurs only when explicitly configured inside the selected AI capability and disclosed
   by its metadata.

### h. Egress with a substituted secret

1. An agent asks `ITX.secrets.collectFromUser` for `/secrets/stripe/prod`, including the exact
   permitted Stripe origin. The user enters the value on the collection page; it is born
   write-only and origin-pinned in the selected secret source.
2. Userspace constructs a `Request` whose authorization header contains
   `Bearer getSecret("/secrets/stripe/prod")` and calls `ITX.egress.fetch(request)`.
3. The project interceptor sees the placeholder and may allow, deny, or transform only
   non-secret parts. It cannot inspect the material.
4. The secret source parses placeholders, proves each secret belongs to this project, checks the
   exact destination origin and method policy, and substitutes into a short-lived prepared
   request. JSON bodies are templated only under the existing explicit header.
5. The manifest's terminal egress source sends the request with redirects disabled. Any redirect
   becomes a fresh request and repeats origin authorization.
6. Headers and bodies are never logged. The response streams back through the same door.
   Operational facts record project, source, destination origin, status class, byte counts, and
   request ID—not secret values or payloads.
7. An ambiguous network failure is not automatically replayed. The caller decides using its own
   idempotency semantics.

This preserves today's valuable secret-cell invariant while allowing the last HTTP hop and secret
storage to occupy different lattice positions.

## 4. Difficulties and trade-offs

### The abstraction cannot erase physics

Per-capability sourcing removes code coupling, not latency. A loop such as 1,000 sequential
`Stream.append` calls across accounts will be slow even with promise pipelining. APIs must stay
coarse enough to stream or batch useful work, and chatty processors should normally run beside
their streams. `__describe()` should expose source locality so diagnostics can explain a slow
path, but project logic must not branch on it.

Cloudflare Service Bindings also have a Worker invocation depth limit. Splitting every target into
a deployed Worker would consume that budget and recreate the cold-start topology the current
monolith deliberately removed. The proposal separates code and authority first; deployments split
only where the lattice requires them.

### A persistent capability session is a real distributed system

Cross-account WebSockets need heartbeats, disposal, backpressure, reconnect, credential rotation,
version negotiation, and bounded queues. Capability references from a dead session cannot be
magically revived. The `RunnerLink` must expose explicit session generations and reconstruct a new
ITX root on reconnect. Durable operations use application idempotency keys; transport reconnect is
not transaction replay.

NAT traversal makes the runner-originated link necessary, but it also means hosted ingress depends
on one long-lived path. Multiple links can provide availability later, yet only one generation may
own a project route at a time unless ordering and duplicate delivery are deliberately modeled.

### Capability attenuation must be tested as a security boundary

An `RpcTarget` exposes prototype methods, including an accidentally public helper. TypeScript
`private` is not sufficient at runtime. Every source interface needs negative tests showing that a
project cannot select another project ID, obtain a raw namespace, enumerate fleet data, reveal
write-only secret material, or pass a capability into a broader scope. Remote provider roots
should expose only `bind(grant)`, then disappear behind the attenuated target.

The control plane is trusted for membership and ingress when it is selected, but a BYO runner
should not let that fact silently authorize source-policy changes. Conversely, a malicious
customer runner must not forge billing identity against an Iterate AI or egress provider. Mutual
pairing and audience-bound grants solve different halves of that problem; both are required.

### Egress is only one door if every bypass is closed

Worker Loader's `globalOutbound` can redirect global `fetch` and `connect`, but an accidentally
passed raw binding can still carry its own network authority. Workers for Platforms' standard
Outbound Worker also does not intercept every Durable Object or mTLS path. The enforceable rule is:
userspace receives no raw binding; each platform capability declares whether it is pure, uses
project egress, or is itself an explicit limited egress authority. A code audit and adversarial
test, not the name `egress`, proves the invariant.

Cross-source secret substitution deliberately allows plaintext to exist in memory at the terminal
egress source. That satisfies transit-yes/at-rest-no, but not every customer's threat model. The
manifest therefore needs a constraint that secrets may be used only with a co-sourced egress
target. It is better to reject an impossible placement than to obscure the trust boundary.

### Routing KV is fast but eventually consistent

KV is appropriate for read-heavy hostname routing, not atomic reassignment. Immutable
hostname-to-project identity, tombstones, and a drain window make the normal path safe. Supporting
instant moves or frequent failover would require a strongly consistent routing authority and an
explicit cache invalidation protocol. The system must never route a recently reassigned customer
domain to a previous project's application for convenience.

The control plane may still need to query directory authority on a miss during creation because
negative KV lookups are cached too. Creation should show "hostname provisioning" until global
readiness rather than pretend every edge sees the write immediately.

### Data location is capability location

Durable Object namespaces and bindings are account resources; a remote runner cannot directly
bind another account's namespace. That is the point of the provider target, but it means moving
`streams` is a real state migration, not a manifest edit. R12 requires export, verify, quiesce,
tail-copy, atomic generation cutover, and rollback semantics per stateful capability. This
proposal creates the seam but does not claim those mechanics already exist.

R2 is strongly consistent through its APIs, while caches in front of a custom domain may serve
stale content. Repository and artifact code must distinguish storage consistency from HTTP cache
behavior.

### Provider contracts need boring evolution

Workers and Durable Object code can briefly run different versions during deployment. Every
contract must be additive across a release window, report a small explicit version, and fail
closed on incompatibility. The binder activates a manifest only when required branches pass a
contract smoke test. Dynamic `any`-shaped forwarding would make cross-account failures late and
unexplainable.

There should be no global capability ABI bureaucracy. Five standard contracts and a conventional
`capabilities.get(name)` are enough. Version only network-visible behavior; keep local
implementation types local.

### Observability can violate the privacy claim

Logs, exception strings, AI Gateway logging, tail events, request capture, and retry queues are all
data at rest. Level 2's claim is false unless headers, bodies, prompts, webhook payloads, Cap'n Web
frames, and secret placeholders are excluded or deliberately retained in the declared source
account. Telemetry should use stable IDs, source, operation, timing, sizes, and classified outcome.
Debug payload capture must be opt-in, scoped, expiring, and visibly changes the residency claim.

Noisy errors cannot be normalized as the price of remote operation. Link disconnects,
authentication rejection, provider incompatibility, timeouts, budget denial, and application
exceptions are different outcomes. Expected ones leave the error signal; unexplained ones block a
release.

### Custom domains and walls have external lifecycles

Cloudflare for SaaS hostname validation and certificate issuance complete independently. A domain
is not ready merely because its registry row exists. Access assertion headers must be
cryptographically validated for issuer and audience at the control plane. Self-hosting must also
work without either product, using a wildcard domain and an open or local wall.

### Local parity has limits

Miniflare can implement the contracts and persistence model, but Cloudflare-only capabilities such
as Workers AI require a remote source. A local adapter should not mimic unsupported semantics
poorly. `runner doctor` must label each branch local, remote, or unavailable, and `pnpm dev` should
fail before serving if a required branch is missing.

### The control plane remains important

Calling it "thin" does not make it disposable. It is the public trust boundary for hostname
ownership, auth, membership, billing, provisioning, webhook verification, and runner selection.
The simplification is that none of those responsibilities requires possession of project data or
implementation of project capabilities.

## 5. Fragments of knowledge

These facts carry the design. They are separated from preferences so a future change in the
platform can invalidate the right conclusion.

### Cap'n Web and Workers RPC

- Cap'n Web is an object-capability RPC system over HTTP, WebSocket, and `postMessage`. It passes
  functions and `RpcTarget` objects by reference, supports callbacks and promise pipelining, and
  sends `Request`, `Response`, and streams. Its persistent WebSocket form retains a live
  bidirectional object graph; an HTTP batch ends with its stubs unusable. The project currently
  uses an Iterate fork, but these core semantics are documented by
  [Cloudflare's Cap'n Web repository](https://github.com/cloudflare/capnweb) and
  [announcement](https://blog.cloudflare.com/capnweb-javascript-rpc-library/).
- Cap'n Web deliberately interoperates with Workers RPC: on Workers its `RpcTarget` aliases the
  runtime type, and Service Binding and Durable Object stubs can be passed through it. This is why
  one capability interface can have two transports rather than two implementations
  ([Cap'n Web README](https://github.com/cloudflare/capnweb#cloudflare-workers-rpc-interoperability)).
- Workers RPC is object-capability security: a peer may invoke only objects and functions whose
  stubs it received. Instance properties are not exposed, but prototype methods are; JavaScript
  `#private` is the reliable way to keep helpers off the RPC surface
  ([Workers RPC visibility and security](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)).
- Workers RPC can pass `Request`, `Response`, and byte streams with flow control. It can forward a
  received stub to a third Worker, but that proxy lasts only for the execution context
  ([Workers RPC overview](https://developers.cloudflare.com/workers/runtime-apis/rpc/)). A
  persistent cross-account provider therefore needs Cap'n Web session ownership, not an
  execution-context trick.
- Stubs retain remote resources and long-lived sessions require explicit disposal. Disconnect ends
  the execution context
  ([Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)).
  The same operational concern applies to the runner link's Cap'n Web graph.

### Cloudflare account and compute boundaries

- A Service Binding target **must be in the caller's Cloudflare account**. Service Bindings can
  invoke RPC methods or forward HTTP, normally run both Workers on the same server/thread, and
  count toward a maximum chain of 32 Worker invocations
  ([Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)).
  This directly forces the same-account Workers-RPC / cross-account Cap'n-Web split.
- Dynamic Worker Loader can provide an arbitrary environment containing Service Bindings and
  loopback bindings with `ctx.props`. Its `globalOutbound` can inherit network access, be `null`,
  or be redirected to a Service Binding. Omitting it normally grants public Internet access
  ([Dynamic Workers API](https://developers.cloudflare.com/dynamic-workers/api-reference/)).
  Confinement therefore requires an explicit ITX environment and explicit egress target, not
  merely the absence of documented bindings.
- Workers for Platforms provides untrusted user Workers in a dispatch namespace and supports
  dynamic invocation by name. It is a plausible hosted implementation for config workers, not the
  architecture's authority model
  ([Workers for Platforms architecture](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)).
- Workers for Platforms Outbound Workers can observe and alter user-worker fetches, but do not
  intercept fetches from Durable Objects or mTLS bindings
  ([Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)).
  Iterate still needs its explicit capability and Loader confinement invariant.

### Cloudflare storage and routing resources

- A Durable Object is a globally addressable, single-threaded coordination point with private,
  transactional, strongly consistent storage. It can own WebSockets and alarms
  ([What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)).
  This fits streams, processors, secret cells, and runner-link ownership.
- Durable Object code rolls out globally with a window in which callers and objects may run
  different versions
  ([Durable Objects known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)).
  Provider contracts must be forward/backward compatible across deploys.
- Workers KV obtains low-latency reads through caching and is eventually consistent. Changes and
  negative lookups may remain stale for 60 seconds or more; it is not suitable for atomic
  read-modify-write
  ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). It is a routing
  cache, not membership or mutable routing authority.
- R2 object writes, metadata updates, deletions, and listings are strongly and globally consistent
  through the R2 APIs. CDN caching in front of a custom domain relaxes what an HTTP client sees
  ([R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)).

### AI, hostnames, and the wall

- A Worker invokes Workers AI through an account binding with `env.AI.run(model, input, options)`,
  including streaming responses
  ([Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)).
  Account placement and gateway metadata belong inside the `ITX.ai` source.
- AI Gateway offers analytics/logging, caching, rate limiting, spend controls, retries, and model
  fallback
  ([AI Gateway](https://developers.cloudflare.com/ai-gateway/)). Those are provider policies that
  must be declared; especially, logging and fallback cannot be invisible consequences of choosing
  Iterate as a source.
- Cloudflare for SaaS custom hostnames have separate hostname and certificate readiness states;
  both must be active and DNS must point at the SaaS target before production use
  ([Cloudflare for SaaS setup](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)).
  The control plane owns this lifecycle; the runner only sees a verified hostname.
- Cloudflare Access sends an application JWT in `Cf-Access-Jwt-Assertion`, but the Worker must
  validate its signature, issuer, and audience against the account's keys
  ([Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)).
  Access can also issue service credentials for automated clients
  ([Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)).

### Facts already present in this repository

- The clean-room [kernel](../../../../kernel/src/kernel.ts) already resolves hostname and caller,
  reserves dashboard and `/api`, passes one props-scoped `ITX` loopback entrypoint into Worker
  Loader, and redirects `globalOutbound` to it. Its
  [README](../../../../kernel/README.md) proves hosted/self-host and open/walled profiles are
  configuration of one bundle.
- The clean-room [directory](../../../../kernel/src/directory.ts), wall, project-app-session, and
  mini dashboard establish the small substrate, while
  [clean-room status](../clean-room-status.md) correctly calls out streams, secrets, AI, and real
  egress as missing runtime capabilities.
- Current [rpc-targets.ts](../../../src/rpc-targets.ts) already has strong individual concepts:
  path-addressed `StreamRpcTarget`, `RepoRpcTarget`, write-only `SecretRpcTarget`,
  `AiRpcTarget`, `ProjectEgressRpcTarget`, and a journaled dynamic capability host. The structural
  problem is that `ProjectRpcTarget` constructs every built-in directly from ambient `env`; only
  unknown names use the mount table. This is precisely the seam R5 asks to invert.
- Current [worker.ts](../../../src/worker.ts) already serves Cap'n Web `/api` over WebSocket,
  supports project-host fetch and WebSocket traffic, and centralizes webhook and dynamic-worker
  routing. It supplies behavior to split, not evidence for a new protocol.
- Current [env.ts](../../../src/env.ts) shows why the split matters: AI, Browser, Loader, auth,
  directory, repositories, secrets, streams, projects, and many other resources are ambient in
  one worker. The target architecture moves those bindings behind branch-specific source
  adapters.
- The [config repository template](../../../config-repo-template/worker.ts) already expects
  `env.ITX.get()` and exposes `fetch` plus `processEvent`. That application-facing contract can
  survive the entire move.
- The [stream and processor design](../../../../../docs/domain-objects-and-stream-processors.md) establishes
  explicit birth events, atomic/idempotent birth batches, append-before-reduce semantics, and
  readiness barriers. Project creation must preserve those facts across source placement.
- The [worker topology](../../worker-topology.md) records a measured reason for merging Durable
  Object classes into the product Worker: prior cross-script cold starts hurt. Per-capability
  source code should therefore not imply per-capability deployment.
- The [architecture and operations guide](../../architecture-and-operations.md) establishes the
  auth directory as authority with project-directory KV as cache, and
  [envs.ts](../../../../../envs.ts) is already the typed deployment/resource map. The proposal
  narrows those responsibilities rather than adding another database.
- Part H of the [self-hosting plan](../self-hosting-plan.md#part-h--the-control-plane--project-runner-interface-what-already-exists-resolves-oq-h)
  identifies reusable machine and on-behalf-of credential lanes and a proven persistent-redial
  pattern. The new work is mutual peer identity, session pinning, and per-capability binding—not a
  new authentication universe.

## 6. Three radical reshapings

These are intentionally not variations of the proposal. Each deletes one of its central
assumptions.

### Reshaping A: one sovereign appliance per project

**Pitch.** Delete the multi-project runner and shared request path. Provision a complete
single-project Cloudflare appliance—ingress, wall, runner, Durable Objects, R2, secrets, and
egress—into a dedicated account. Iterate's hosted service is only a provisioning, update, billing,
and marketplace console. DNS points directly at the appliance; no request, webhook, prompt, or
response transits Iterate after setup. Shared capabilities are conventional outbound HTTPS APIs
with metered tokens.

This produces the strongest comprehensible isolation boundary: the Cloudflare account is the
project. Budgets, logs, compromise radius, data deletion, and ownership all align. It also removes
the cross-account serving tunnel and most of the source binder.

**Key trade-off.** Provisioning and operating an account per project is heavyweight, slow, and
possibly constrained by Cloudflare product/account economics. First-party webhook ingress,
`iterate.app` serving, callbacks, and interactive capabilities lose their seamless capability
semantics. Moving one capability becomes an API integration rather than an ITX rebind. This is a
good high-assurance product tier, but a poor default collaborative platform.

### Reshaping B: a capability exchange with no project runner

**Pitch.** Delete the stable runner. Every compute node and provider—browser session, local agent,
stream actor, repository, AI gateway, secret cell—dials a global Cap'n Web exchange. A project is a
signed graph of capabilities in the exchange, not a Worker. When a request arrives, the exchange
assembles an ephemeral ITX root, passes the ingress capability to whichever compute node currently
leases it, and lets object references route peer-to-peer. Placement can change continuously and
local machines are first-class peers.

This takes the object-capability idea to its logical extreme. There is no special cross-account
case, no account-local composition root, and no reason one node must host every branch. Offline
collaboration and delegation could be extraordinarily powerful.

**Key trade-off.** The exchange becomes a distributed capability operating system: revocation,
introduction, routing, liveness, replay, durable naming, peer discovery, connection handoff,
ordering, garbage collection, and denial-of-service all become product problems. HTTP serving
depends on an ephemeral graph being reconstructible during failure. The elegant diagram hides far
more machinery than the current platform needs.

### Reshaping C: an immutable project log with stateless reducers

**Pitch.** Delete live ITX objects and Durable Object actors. A project is an immutable,
content-addressed event log and object graph in customer-owned R2. All commands are signed records.
Stateless Workers lease ranges, reduce snapshots, compile repositories, execute agents, and write
new records with conditional object operations. Capabilities are declarative effect requests in
the log; independent workers fulfill them and append results. Serving reads a published snapshot.
The same format can run on Cloudflare, S3/Lambda, or a laptop.

This maximizes portability, auditability, offline replication, and migration. Account placement is
just where the log and reducers run. There is no long-lived cross-account capability session and
almost no privileged kernel.

**Key trade-off.** It gives up the best properties of the present system: synchronous
object-capability composition, live callbacks, low-latency stream following, single-threaded
Durable Object coordination, natural WebSockets, and a direct `ITX.ai.run()` programming model.
Every effect becomes an asynchronous saga with leases and conflict rules. It is a coherent
different product, not a simplification of apps/os.
