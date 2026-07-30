# Codex topology proposal: the sealed project root

The whole system should have one architectural sentence:

> The control plane finds and authenticates a project; the project runner owns and executes that project's capability root; project code receives only that root and one egress door.

Everything below exists to keep that sentence true as a project moves between Iterate's account, a customer's Cloudflare account, and a local machine.

## 1. The proposal

### Four nouns

The durable model needs only four nouns:

1. A **deployment** is one control plane and its public names.
2. A **placement** is somewhere the runner bundle is installed: an Iterate account, a customer account, or a local process.
3. A **project** is one sealed ITX capability root and the data behind it.
4. A **link** carries that root between a control plane and a placement. It is either a same-account Service Binding or an authenticated Cap'n Web session.

A project has one placement at a time. Each capability beneath the project may be fulfilled locally or by an explicitly selected remote provider. Changing either choice does not change project code or the public ITX type.

### Two authoritative workers

There are exactly two product authorities, although there may be compiler sidecars and dynamically loaded user Workers:

| Component                        | Knows                                                                             | Owns                                                                                                                                           | Must not own                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Control plane Worker**         | deployments, people, memberships, hostnames, placement health, billing references | ingress, wall, directory, strong route registry, route KV projection, dashboard, MCP adapter, custom-hostname lifecycle                        | project streams, project files, project secrets, user-code execution, durable webhook bodies |
| **Project runner Worker**        | the project named by its sealed invocation                                        | project ITX tree, durable log and processors, secret vault, R2 objects, project egress, Dynamic Worker Loader, project-local capability policy | global membership policy, hostname ownership, another project's authority                    |
| **Config Worker**                | only the project-scoped bindings injected at load time                            | application routing and project-specific processors                                                                                            | ambient network, raw Cloudflare bindings, credentials, directory access                      |
| **Bundler/typechecker sidecars** | source presented for a build                                                      | no durable authority                                                                                                                           | ingress, identity, project data beyond the active build                                      |

The control plane and runner are separate deployable bundles. The exact runner bundle is built once and deployed byte-for-byte to every Cloudflare placement for that release. The control-plane bundle is likewise identical across hosted and self-hosted deployments. `APP_CONFIG`, binding IDs, hostnames, capability sources, and secrets are deployment configuration, never source forks.

The current OS choice to keep mutually chatty Durable Object classes in one Worker remains sound: splitting an authority does not require turning every class into a network service. The runner bundle contains the project stateful classes now co-located in `apps/os`; compiler and typechecker Workers remain stateless implementation sidecars only where bundle size or isolation warrants them. This preserves the cold-start and failure-domain lessons in the [current worker topology](../../worker-topology.md) while creating the missing control-plane/runner boundary.

```text
 browser / webhook / MCP / agent
                 |
                 v
        CONTROL PLANE WORKER
   wall -> directory -> route registry
      dashboard | /api | hostname router
                 |
        Project transport adapter
          /                 \
 same-account               cross-account or local
 Service Binding            Cap'n Web / WebSocket
          \                 /
                 v
       RUNNER GATEWAY (no public authority)
                 |
      sealed ProjectRunner(projectId, actor)
                 |
       +---------+----------+-------------+
       |         |          |             |
   log/DOs     secrets     egress       capability
       |                                 resolver
       +----------------+----------------+
                        |
             Dynamic Worker Loader
             env.ITX + globalOutbound
```

### “The runner knows one project” is an invocation boundary

Deploying one ordinary Worker script per project would hit account script limits and make hosted operation needlessly expensive. Conversely, giving a multi-project runner a god object merely recreates today's coupling.

The middle is concrete and enforceable:

- A **runner placement** may physically serve many projects.
- Its default `RunnerGateway` can only open a project already present in that placement's small local catalog. It cannot list project data or return an unscoped ITX root.
- `RunnerGateway.openProject(projectId, actorGrant)` creates a loopback `ProjectRunner` binding with `ctx.exports.ProjectRunner({ props })`. The props contain the project ID, actor, project generation, and capability-plan version. Cloudflare makes `ctx.props` authentic to the receiving entrypoint; loaded code cannot alter them.
- Every returned `ProjectRunner` object is therefore one-project. Every Durable Object name, R2 prefix, secret reference, trace field, and egress decision derives from its sealed props, never from caller-controlled headers.
- An account-per-project placement uses the same bundle with a one-row catalog. It is the strongest cell in the same model, not a different product.

The gateway is routing machinery, not an authority exposed to project code. It must not have “list all streams”, “get arbitrary secret”, or “run as project” methods.

### One ITX tree, two transports

Keep the existing public shape:

```text
Os.authenticate(credentials)
  -> Session
     -> projects.get(idOrSlug)
        -> Project
           -> worker
           -> agents
           -> streams
           -> repos
           -> secrets
           -> ai
           -> browser
           -> ...
```

The control plane's `/api` is the front door. Its `Os` authenticates, its `Session` applies directory membership, and `projects.get()` returns the `Project` capability opened on the selected runner. The implementation behind `Project` has moved; callers and config Workers do not.

The runner also serves `/api`, but its `Os` accepts only a project-scoped credential or runner-link handshake and its `projects.get()` can resolve only the project pinned to that session. This is the clean-room `/api` door, not a second API. It preserves the two existing actor lanes:

- `project-secret` is the machine lane. It is born in that project's secret vault and can act only as that project.
- `project-app-session` is the on-behalf-of lane. The control plane mints it only after wall authentication and membership authorization; it contains actor, project, audience, expiry, and a unique ID.
- `runner-link` is a new infrastructure credential. It authenticates deployments to one another but grants no project capability by itself.

For a same-account placement, the control plane calls the private `RUNNER` Service Binding. Possession of that binding authenticates the control plane, and the short-lived actor grant supplies the caller identity. The runner uses `ctx.exports` to turn the request into an unforgeable one-project entrypoint.

For another account, the two sides mutually authenticate a Cap'n Web WebSocket and pin that session to one project and project generation before returning a `Project` stub. Cloudflare-hosted remote runners expose a private-looking but publicly reachable link endpoint; the control-plane side dials it on demand and reuses it while healthy. A local runner behind NAT dials outward and gives the control plane the reverse capability. Both directions yield the same `Project` type.

“Persistent” must mean reconnectable and session-oriented, not immortal. A Cloudflare Durable Object can hibernate an accepted WebSocket, but an outbound WebSocket cannot hibernate and only postpones eviction for a bounded interval. Each side therefore persists the link identity, peer key, project generation, and last acknowledged operation—not the in-memory stub. A broken transport is redialled, reauthenticated, and rebound. Every mutation crossing a link has an idempotency key; reads may retry once against a freshly bound project. This is the production version of `ProjectDial`, not an assumption that a socket lives forever.

The Iterate Cap'n Web fork is load-bearing here: it transports `Request`, `Response`, streams, callbacks, and Workers-style WebSocket upgrades. Native Workers RPC is used within an account; Cap'n Web is the cross-account and non-Cloudflare wire. Promise pipelining remains available on both sides, so a caller can authenticate, get a project, and invoke it without paying a round trip for every traversal.

### Confinement and the one egress door

The clean-room kernel's strongest idea becomes the runner's execution rule:

1. Resolve an immutable config bundle by content hash.
2. Call `LOADER.get("project:<id>:<config-hash>", callback)`.
3. Inject exactly two bindings into the loaded Worker:
   - `ITX`, a project-scoped capability object;
   - `globalOutbound`, the same project's egress entrypoint.
4. Inject actor information through trusted props or headers, strip all raw wall/link credentials, and invoke the config Worker.

There is no ambient `fetch`. Every network request from project code reaches `globalOutbound`. The door applies destination policy, approval policy, rate/budget policy, secret substitution, and audit metadata before making the request. The config Worker cannot acquire a binding merely by knowing its name; it must receive the stub.

Dynamic Worker Loader isolates code, not state. A loaded isolate may be reused or replaced at any time, so durable behavior remains in runner capabilities. The reserved dashboard and `/api` are served before loading config code and remain available when that code fails.

### Capability sourcing without a universal remote mount

`Project` is assembled by a small resolver:

```text
resolve(projectId, "ai")      -> local runner AI adapter | remote AI provider stub
resolve(projectId, "repos")   -> local repo capability     | hosted connector stub
resolve(projectId, "secrets") -> local vault               | selected remote vault
resolve(projectId, "egress")  -> local door                | chained provider door
```

The project stores a versioned `CapabilityPlan` whose entries are `{ capability, source, policyRef }`. The resolver returns a typed, least-authority interface. It never accepts an arbitrary URL or generic capability name from config code.

This is intentionally not a resurrection of the removed `remoteCapability` mount. A source is selected by deployment/project policy, and each provider implements a reviewed interface. The capability remains explicit in types, telemetry, billing, and failure classification. Moving AI to the customer's account changes one plan entry; it does not replace the project root or teach userspace about links.

Storage capabilities default to the runner placement because that is what “the project lives there” means. Remote storage is possible but should be visibly exceptional. Compute may call a hosted AI or integration capability, so request data transits that provider, but project state does not silently become control-plane state.

### State ownership and routing

The control plane needs strong truth and fast reads:

- A sharded **Registry Durable Object** is authoritative for `(hostname -> project -> placement, generation, state)`.
- Workers KV is a read-optimized projection of ready routes. It is never the proof that creation or cutover committed.
- On a KV miss or generation mismatch, the control plane asks the authoritative registry. This avoids a cached negative lookup making a newly created project appear absent for a minute.
- The directory owns project membership and creation policy. Its implementation is either the hosted auth service or a local/KV-backed implementation. “Open creation” is a policy flag, not a fourth directory kind.

The runner owns:

- a tiny placement-local project catalog and birth receipts;
- the durable project log and all stream processors;
- the secret vault, files/artifacts, schedules, and project-scoped indexes;
- idempotency records for cross-boundary mutations;
- an immutable record of the capability-plan version used for each effect.

Queues may wake or distribute work, but they are not project truth. A queue delivery is at least once; processors deduplicate against the durable log. The current obligation/reconciler model remains inside the runner.

At level 2, the Iterate control plane durably stores only control metadata: actor/directory records, hostnames, placement IDs, generations, health, usage counters, and opaque operation IDs. It does not store stream contents, files, secrets, prompts, webhook bodies, or config bundles. Public requests and webhook payloads may transit it synchronously. If a remote runner is unavailable, the control plane returns an explicit retryable failure; it does not quietly enqueue the body in Iterate's account.

### Deployment specification and compatibility

`envs.ts` remains the typed source of truth for Iterate-owned deployments. Self-host and provisioned-account flows generate the same non-secret `DeploymentSpec` shape in their checkout:

```text
deployment:
  control account, worker name, hostname bases, wall, directory
placements[]:
  id, kind, account, runner name/endpoint, region or jurisdiction
resources:
  stable KV/R2/DO/Queue/Loader identifiers
capabilityDefaults:
  source and policy per capability
release:
  control digest, runner digest, protocol min/max
```

Secrets stay in Doppler, Wrangler secrets, or the selected vault. The Cloudflare API token used to provision a customer account is not part of the spec and is discarded after provisioning.

The link handshake exchanges deployment ID, runner bundle digest, protocol range, project generation, and a challenge signed by each side's link key. Incompatible ranges fail closed with a durable, operator-visible explanation. Protocol changes are additive: deploy sidecars and runners first, then control planes, then remove obsolete methods in a later release.

## 2. Scripts

Expose one implementation as `pnpm topology <command>` and keep familiar package aliases such as `pnpm run deploy --env <name>`. Every mutating command emits an operation ID, records its phases, is safe to retry, and ends with a state/telemetry proof rather than “the API returned 200”.

| Command                                                     | What it does                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topology render --env <env>`                               | Loads `envs.ts`/`DeploymentSpec` plus secret names, validates the independence lattice and protocol versions, and renders role-specific Wrangler configuration. Read-only; prints a diff.                                                                                                                      |
| `ensure-resources --env <env> [--role control               | runner                                                                                                                                                                                                                                                                                                         | all]`                                                                                                                                                                                                             | Idempotently creates missing KVs, R2 buckets, Queues, Loader bindings, DO namespaces/migrations, AI Gateways, hostname infrastructure, and sidecar bindings. Records stable IDs in the non-secret spec. It never deletes or deploys code. |
| `deploy --env <env> [--role ...]`                           | Builds each role once, verifies bundle digests, uploads secrets with the version, deploys dependencies in order, runs protocol and state migrations, promotes versions, and executes end-to-end smoke tests. It fails if resources are absent; it does not provision by surprise.                              |
| `provision-account --env <env> --account <id>`              | Checks the supplied customer's API-token permissions, ensures a runner placement in that account, deploys the pinned runner bundle and local sidecars, establishes mutually authenticated link keys, enrolls the placement in the control plane, and runs `doctor`. It does not retain the provisioning token. |
| `create-project --env <env> --placement <id> --slug <slug>` | Runs the durable project-birth saga described below. The same command/API backs dashboard and MCP creation.                                                                                                                                                                                                    |
| `domain add --project <id> --hostname <host>`               | Proves hostname control, provisions Cloudflare for SaaS or a self-hosted route, waits for both hostname and certificate readiness, then publishes the route. Removal is a separate explicit command.                                                                                                           |
| `self-host bootstrap --account <id> --hostname-base <base>` | Creates a `DeploymentSpec`, chooses `wall=access                                                                                                                                                                                                                                                               | off` and directory implementation, ensures both roles in the account, deploys runner then control plane, configures wildcard DNS/routes, creates the first project, and prints recovery/upgrade instructions.     |
| `runner enroll --control <url> --project <id>`              | Enrolls a local/Home Assistant runner, exchanges link keys via a one-time code, pins its project and generation, and starts the outbound reconnecting link.                                                                                                                                                    |
| `migrate project <id> --to <placement>`                     | Executes snapshot/copy/catch-up/fence/cutover/verify for project data and capability state. Initially experimental, but its state-machine contract exists from the first release.                                                                                                                              |
| `doctor --env <env> [--project <id>]`                       | Checks resource existence and account ownership, bundle/protocol digests, route-registry/KV agreement, link health, credential lanes, reserved dashboard, config confinement, egress denial, and a write/read/processor smoke event. Read-only except for namespaced disposable probes.                        |
| `dev [--runner local                                        | remote]`                                                                                                                                                                                                                                                                                                       | Starts control plane, runner, and needed sidecars under the existing worktree-scoped dev lifecycle. Defaults to simulated local bindings and persistent local volumes; prints all platform and project hostnames. |
| `erase-data --env <env> --project <id>`                     | A deliberately separate destructive workflow: previews exact resources and retention effects, requires an explicit confirmation token, fences the project, erases runner data, then removes control metadata and domains.                                                                                      |

### Deployment is a dependency-ordered release

`deploy` performs:

1. Build and hash control, runner, and optional sidecars. Assert that the runner artifact is identical for every selected placement.
2. Validate resource IDs, required secrets, compatibility date, DO migrations, and protocol overlap without changing traffic.
3. Upload/deploy stateless sidecars.
4. Upload the runner version with additive APIs and its secrets; apply runner storage migrations; smoke it through a version-specific endpoint.
5. Promote the runner and verify existing control planes can still use it.
6. Upload/promote the control plane, then smoke `wall -> directory -> route -> Project -> config Worker -> effect`.
7. Audit traces, durable birth/operation records, error classifications, and route projections. Only then declare success.

This order follows Cloudflare's requirement that a Service Binding target exist before its caller. Storage resources are not part of a Worker version, so rollback means “old code against forward-compatible migrated state”, not time travel. Destructive schema cleanup belongs in a later release after every control plane has moved.

### Project creation is a durable saga

`create-project` is idempotent on `(deployment, requested project ID, operation ID)`:

1. The directory reserves the project ID/slug and owner membership in `creating` state.
2. The Registry DO reserves hostnames and the chosen placement with generation `1`. Nothing is publicly routable.
3. The control plane opens the placement and calls `createProject`. The runner atomically creates its catalog row, appends the root birth batch, creates processors/schedules, and creates the born `project-secret` inside the project's vault. Repeating the operation returns the same birth receipt.
4. The runner proves that its root can read the birth event, fold state, invoke a confined no-op config Worker, and reject cross-project/ambient egress.
5. The directory and registry mark the project `ready` using the runner receipt and bundle/protocol digests.
6. Route KV is updated as a projection. Custom domains are published only after certificate readiness.
7. An end-to-end read through the public control plane must reach generation `1`. The operation then becomes `complete`.

A failed phase remains visible and retryable. Compensation releases an unused hostname reservation, but it never erases a successfully born runner project automatically. That state requires reconciliation or explicit deletion; there are no ghosts hidden behind a fallback.

### Provisioning a customer account

`provision-account` is closer to the existing preview-environment provisioning than to Terraform:

1. Discover the current permission groups and check a least-privilege account token for Workers scripts, required storage products, Loader, and optional AI/hostname products.
2. Render a plan showing every resource and recurring-cost surface.
3. Run runner-only `ensure-resources`.
4. Deploy sidecars then the exact release runner bundle.
5. Generate two link key pairs: the control plane stores its private key; the customer runner stores its private key; each stores the other's public key and deployment identity.
6. Register a placement in `pending`, complete a mutual challenge through the link endpoint, run data-path probes, then mark it `ready`.
7. Forget the Cloudflare API token. Upgrades either use a newly presented token or customer-run `deploy --role runner`; runtime operation needs only the link credential.

The customer's ability to revoke the provisioning token is a feature. Losing the runtime link stops new relayed traffic but does not grant Iterate any alternative path to project storage.

### Migration is a controlled change of project generation

Cross-account Durable Objects cannot be “rebound” to a new account. `migrate project` therefore performs a logical migration:

1. Create target generation `g+1` in `catching-up`; keep `g` authoritative.
2. Export a consistent stream watermark and logical snapshots from source DOs. Copy R2 objects with manifests and hashes. Re-encrypt exportable secrets to the target placement key; flag non-exportable secrets for re-entry.
3. Replay the durable log and rebuild derived state at the target. Mirror subsequent source events with idempotency keys.
4. Verify stream sequence/hash, object manifests, processors, schedules, capability plan, and a read-only config invocation.
5. Briefly fence new mutations at `g`, drain the final delta, and acquire the registry's compare-and-swap cutover from `g` to `g+1`.
6. Publish the KV projection, route new sessions to the target, and leave the source fenced but readable for a retention window.
7. Verify production-shaped traffic and telemetry before an explicit later erase.

Every mutating request carries the project generation. A stale source runner rejects writes after the fence, preventing split brain. Before the first target write, migration may roll back by unfreezing `g`; after cutover, recovery moves forward or performs another generation change.

## 3. Main stories

### a. Create a project

An authenticated user, admin CLI, or MCP session calls `Session.projects.create({ slug, placement? })`. Directory policy chooses whether the caller may create and supplies a default placement if none was requested. The control plane runs the birth saga above.

The returned object is the actual runner-backed `Project` capability, not a database record followed by a second lookup. The caller can pipeline `create(...).worker.getStatus()` while the operation completes. A concurrent request with the same operation ID joins it; a colliding slug with another operation gets a typed conflict. The project does not appear in lists or route publicly until the runner receipt and public-path probe both pass.

### b. Hosted serving

For `app--acme.iterate.app` or a hosted custom domain:

1. The control plane resolves the hostname from route KV; a miss or stale generation consults the Registry DO.
2. It runs the configured wall, resolves actor identity, checks directory membership where the route requires it, and mints a short-lived `project-app-session`. Public routes use an explicit anonymous actor, not absence of identity.
3. It opens generation `g` through the same-account runner Service Binding and receives a sealed `Project`.
4. `Project.worker.fetch(request)` loads the content-addressed config Worker. The runner strips wall/link credentials and injects only trusted actor context, `ITX`, and `globalOutbound`.
5. Any project state change goes to runner DOs; any file goes to runner R2; any network call goes through runner egress. The response streams back through the control plane.

The control plane serves its reserved dashboard and `/api` without invoking config code. First-party webhook routes authenticate and synchronously relay the body to the runner before acknowledging the provider. If the runner is down, the provider receives an explicit retryable error; Iterate does not durably buffer customer payloads.

For a hosted custom hostname, `domain add` creates the Cloudflare for SaaS object, returns ownership/DCV instructions, and does not publish it as ready until both hostname and SSL status are active.

### c. Self-host on an owner's domain

The owner runs `self-host bootstrap` against one Cloudflare account. It creates both roles with a private Service Binding from control to runner and a wildcard route such as `*.example.com/*`. The generated config may use:

- Cloudflare Access as the wall, validating `Cf-Access-Jwt-Assertion` against the account's rotating JWKS;
- the hosted Iterate auth service if deliberately selected; or
- `wall=off` for a trusted LAN/local deployment.

The directory is a small KV-backed implementation with a strong Registry DO; `openCreation` replaces special “open” or “local” directory modes. The same runner artifact, ITX tree, Loader confinement, credential lanes, and dashboard run here. The owner upgrades with `git pull && pnpm install && pnpm run deploy --env selfhost`; no product code is forked.

Because both roles share an account, project calls use the private Service Binding and no cross-account link is required. An owner can later attach Cloudflare for SaaS, direct zone routes, or multiple hostname aliases without changing project placement.

### d. Bring a Cloudflare account

The user presents a least-privilege account token to `provision-account` once. The command creates and verifies a runner placement in that account. Iterate's control plane remains at `iterate.app`, but all project streams, DO storage, R2 objects, config bundles, schedules, and default secrets are bound in the customer account.

At request time, the control plane authenticates the person and resolves the route, then establishes/reuses a mutually authenticated Cap'n Web session to the customer runner. The WebSocket is pinned to the project and generation; actor authority is a short-lived project-app-session, not the provisioning token. The `Project` stub looks identical to a local Service Binding stub.

Hosted AI, browser, or connector capabilities can still be selected individually. Their request data transits the chosen provider and usage is metered there, but the durable log and result are written by the customer runner. Selecting customer-account AI instead changes only `CapabilityPlan.ai`.

The customer can revoke the provisioning token immediately. They can also revoke the link, which deliberately makes Iterate ingress fail closed while leaving their runner and data intact. Moving the control plane into their account later changes route/directory configuration and transport, not project code.

### e. Local `pnpm dev` and a Home Assistant runner

`pnpm dev` starts the same two roles under the existing worktree-scoped lifecycle:

- a local control plane on a random `localhost` port;
- project hosts such as `<slug>.localhost:<port>`;
- a local runner with Miniflare/workerd storage in a named persistent volume;
- local Loader, DO, KV, R2, and Queue adapters by default;
- optional remote capability bindings only when explicitly requested.

The default wall is off and the directory permits creation, but the project boundary, actor shape, egress door, and credential checks still execute. Restart-on-crash is a supported runner behavior, not an untested fallback.

For Home Assistant, a local runner owns the project and volume while Iterate's hosted control plane provides `iterate.app`, login, and integrations. `runner enroll` pairs one project, then the long-running local process dials outward through NAT. The control plane's accepted side can hibernate; the local daemon reconnects with backoff and resumes from acknowledged operation IDs. When the house is offline, reads and writes return a clear unavailable response and webhook senders are asked to retry. The control plane never creates a shadow project store.

Fully local level 3 simply runs both processes. A public callback can use the repository's supported tunnel mechanism without changing topology.

### f. Connect MCP and emerge with a project

MCP is an adapter over the same capability tree, not a second business API:

1. The client completes OAuth/login at the control plane and receives a `Session`.
2. The MCP `connect` request may name a project and `create=if-missing`. If omitted, the sole accessible project is selected; multiple projects produce a choice; zero projects require explicit creation consent.
3. If creation was requested, MCP calls the same `projects.create` saga and waits for the runner-backed capability.
4. The server pins the MCP session to that `Project`. Its tools/resources are projections of the capabilities actually present beneath that root.

The client therefore emerges holding one project, not a bag of project IDs and admin-shaped tools. Changing placement is invisible. A project-secret can connect a headless agent directly to the runner `/api`; an interactive client uses the project-app-session lane. Neither can traverse sideways to another project.

### g. An agent calls an LLM through ITX

An agent processor appends an `llm-requested` event to the runner-owned log. The processor folds context and calls `Project.ai.run(...)`; config code never reads `env.AI`.

The capability resolver examines `CapabilityPlan.ai`:

- For `runner`, it calls the AI binding or the runner account's AI Gateway.
- For `iterate`, it invokes a typed AI provider stub across the link. The provider applies plan limits and metering, calls its binding, and streams the answer back.
- For another provider, its adapter performs the same contract using that provider's secret and egress policy.

The runner appends chunks/result/failure with the request's idempotency key. Provider retries are bounded and represented as attempts beneath one logical operation. If level 2 forbids durable data in Iterate's account, the hosted provider disables AI Gateway logging and caching for that request; enabling either is an explicit capability-policy choice because prompts would otherwise become provider-side stored data.

### h. Egress with a substituted secret

Suppose project code needs `Authorization: Bearer <secret:github-token>`:

1. The caller has previously written the token to its selected secret capability and received an opaque `SecretRef`. Reads return metadata, never value.
2. Config code constructs a request containing a structured substitution reference, not a string template that can be smuggled into another field.
3. `globalOutbound.fetch` checks the destination against the secret's allowed origins/methods, project egress policy, actor approval, and budget. It rejects redirects that would escape the approved origin.
4. If the secret lives in the runner vault, that door substitutes immediately before `fetch`. If the secret is hosted remotely, the runner sends the request plus opaque reference to the typed remote egress capability; the owning provider substitutes there. Secret material never crosses back to the runner.
5. The owning door records project, actor, destination, secret ID/version, response class, bytes, and operation ID—but neither secret value nor body—and returns the streaming response.

There is exactly one final substitution point for a secret. Chained egress doors can narrow policy but cannot resolve and then forward plaintext credentials. WebSocket setup goes through the same door and policy.

## 4. Difficulties and trade-offs

| Difficulty                                                 | Proposed treatment and remaining cost                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One-project runner versus platform scale**               | Make one-project scope an entrypoint/stub invariant, not a script-count invariant. The tiny placement gateway still has a multi-project catalog, so its API and tests deserve kernel-level scrutiny. Account-per-project remains available when physical isolation is worth the account sprawl.                                                      |
| **A WebSocket is not permanent compute**                   | Treat links as leased, reconnectable sessions. A local daemon can maintain outbound connectivity; a Cloudflare-to-Cloudflare caller redials an inbound runner endpoint as needed. Persist identity, generation, and acknowledgements, never a belief that a stub survives eviction. This adds link state and reconnect tests.                        |
| **Fetch/WebSocket parity across transports**               | Iterate's Cap'n Web fork supports Fetch values, streams, and WebSocket upgrades, but this is a critical fork delta. M0/M5 must test backpressure, cancellation, half-close, large bodies, and nested upgrades on both Service Binding and Cap'n Web paths before claiming transparency.                                                              |
| **No distributed transaction across accounts**             | Project birth and migration are durable sagas with receipts, generations, idempotency, and visible pending states. They are not atomic. The operational burden is a reconciler and honest intermediate UI.                                                                                                                                           |
| **KV is fast but stale**                                   | KV is only a route projection; a strong Registry DO handles creation/cutover truth and miss repair. That adds one slow-path hop and requires sharding rather than a global singleton.                                                                                                                                                                |
| **No Iterate-at-rest data versus webhook reliability**     | The control plane relays synchronously and returns a retryable failure before acknowledging. Providers that neither wait nor retry cannot be made lossless at level 2 without customer-side ingress or relaxing the no-storage rule. This is a product limitation to document, not error spam to normalize.                                          |
| **Remote capabilities invite latency and partial failure** | Keep interfaces coarse and stream-oriented, use promise pipelining, classify provider/link errors, and write effects through the runner log with idempotency. Do not decompose the local runner into chatty network microservices.                                                                                                                   |
| **Version skew**                                           | Links negotiate protocol ranges and report both bundle digests. Releases are additive and runner-first. A rolled-back Worker still sees migrated storage, so schema changes must be forward/backward compatible across the rollback window.                                                                                                          |
| **Credential issuer trust**                                | Existing HS256 project-app-sessions are simple in one deployment but give every verifier minting power. Before cross-account production, use asymmetric per-deployment signing: control plane holds the private key; runners cache public keys and enforce audience/project/generation/expiry. Keep the existing claim shape and 15-minute lifetime. |
| **Data migration is logical, not a namespace move**        | DOs do not relocate after creation and account changes cannot retarget bindings. Export/replay plus a short write fence is unavoidable. Large R2 copies, secret non-exportability, and external integration state will dominate migration time.                                                                                                      |
| **Data locality is more than account ownership**           | A customer account does not itself guarantee geography. Runner bootstrap must let the owner select DO jurisdiction and R2 location policy before birth; changing later requires migration. Remote AI/integrations remain explicit data processors.                                                                                                   |
| **Provisioning requires broad temporary trust**            | Show a resource/permission plan, discover current permission IDs, accept a scoped token, retain no token, and support customer-run upgrades. Some Cloudflare products may still require account-wide permissions; the script must surface that before mutation.                                                                                      |
| **AI convenience can violate storage claims**              | AI Gateway can log and cache prompts. Capability policy must set logging/cache behavior deliberately and expose the actual account/provider in the UI and audit event. “AI is remote” is not a sufficient privacy description.                                                                                                                       |
| **Current RPC surface is enormous**                        | Split `ProjectRpcTarget` into typed capability modules while keeping them inside the runner authority. This is code organization and source selection, not a fleet of new Workers. Migration should preserve ITX paths and delete duplicated façade logic only after consumers move.                                                                 |

The most important rejected shortcut is a generic “remote Project mount”. It would make authority provenance, failure ownership, billing, and data placement implicit again. Transporting a reviewed project or capability stub is useful; making arbitrary remote capability lookup a user-facing primitive is not.

## 5. Fragments of knowledge

### External, load-bearing platform facts

- Cap'n Web is schema-free object-capability RPC over HTTP, WebSocket, or `postMessage`; it supports bidirectional references and promise pipelining. An HTTP batch ends once awaited, whereas a WebSocket session can retain references. TypeScript describes the API but is not runtime input validation, so link/auth boundary inputs still need explicit validation. [Cloudflare's Cap'n Web announcement](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)
- The installed package is Iterate's `@iterate-com/capnweb` 0.10.0 fork. Its documented deltas are Workers WebSocket-over-RPC and an `onCall` hook; it passes `Request`, `Response`, readable/writable streams, and WebSocket upgrades by value. Those deltas are part of this architecture's compatibility surface, not incidental library details. [Iterate's Cap'n Web fork](https://github.com/iterate/capnweb)
- A Service Binding target must be a Worker in the **same Cloudflare account**. The target must be deployed before the caller; calls are normally co-located without a public URL, and a request is limited to 32 Worker invocations. This directly determines the same-account link and deployment order. [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- Workers RPC can forward a received stub to another Worker and supports streams beyond the 32 MiB serialized-value limit. Returned `RpcTarget` stubs keep server objects/execution contexts alive and should be explicitly disposed; client disconnect cancels the context. Long-lived project stubs therefore need scoped ownership and disposal. [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/), [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
- `ctx.props` is authentic because only a deployer with permission to edit the receiving Worker can configure it. `ctx.exports` can dynamically create a loopback binding with props, including other Service Bindings, which is the concrete primitive for a sealed `ProjectRunner`. [Workers Context API](https://developers.cloudflare.com/workers/runtime-apis/context/)
- Dynamic Worker Loader decides the code, bindings, network access, and limits of untrusted code. `get(id, callback)` may cache an isolate but gives no same-isolate guarantee; the callback must return identical code for an ID. Custom bindings are unforgeable capabilities and `globalOutbound: null` can remove ambient network. This supports content-addressed config code with all durability outside the isolate. [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/), [Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/), [Dynamic Worker bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)
- Durable Object WebSocket hibernation works when the DO is the **server**, not for its outbound WebSocket. An outbound connection prevents eviction only for a bounded period and incurs duration charges. A cross-account cloud link must reconnect; a local daemon may maintain the client side. [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- Workers KV is eventually consistent; changes can take 60 seconds or more to appear elsewhere, and negative lookups are cached too. KV cannot be the readiness or cutover authority for a project. [How Workers KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- SQLite Durable Objects provide private, strongly consistent transactional storage per object and 30-day point-in-time recovery. Cloudflare recommends SQLite for new namespaces. This fits project logs/registries, but storage is attached to the namespace rather than a Worker version. [SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- Durable Objects do not currently relocate after creation. Jurisdiction is a hard placement constraint, while location hints are best effort and affect only initial placement. Migration and bootstrap must treat data location as a birth choice. [Durable Object data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- R2's binding/S3 operations are globally strongly consistent for write, update, delete, and list; serving through a cached custom domain can still expose stale cached objects. Migration verification should use bindings/S3 plus manifests, not public cached reads. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- Cloudflare Queues is at-least-once and can deliver duplicates. Queue consumers need operation IDs and durable deduplication; a queue cannot itself prove exactly-once stream effects. [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- A Cloudflare for SaaS hostname is not production-ready merely because TLS happens to work: both hostname status and SSL status must be `active`, with DNS pointing at the SaaS target. Host ownership validation and certificate validation are separate concerns. [Cloudflare for SaaS API lifecycle](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/common-api-calls/), [zero-downtime hostname migration](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/zero-downtime-migration/)
- Cloudflare Access sends the application JWT in `Cf-Access-Jwt-Assertion`; Cloudflare recommends validating that header rather than relying on the cookie. Signing keys are account-specific and rotate, so a self-host wall needs JWKS refresh, issuer, audience, and expiry checks. [Validating Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- Cloudflare bindings are permission and API together; underlying credentials are not exposed to Worker code, and local development simulates bindings by default. This is why capabilities should wrap bindings rather than distribute API tokens. [Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- Workers AI requires an account binding. AI Gateway selected through that binding must be in the same account; third-party BYOK is not supported through the current AI binding and uses provider endpoints instead. Gateway logging, caching, rate limits, and spend limits are real storage/policy choices, not transparent transport details. [Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/), [AI Gateway binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/), [AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/), [AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)

### Repository facts this proposal preserves

- The [clean-room kernel](../../../../kernel/src/kernel.ts) already proves the essential shape in about 850 lines: wall and directory separation; `Os.authenticate -> Session -> projects.get -> Project`; Loader confinement; the same project entrypoint as `ITX` and `globalOutbound`; and a dashboard served outside user config. The missing production pieces are durable capabilities, policy, and the two-worker transport—not a new conceptual API.
- The [clean-room project-app-session](../../../../kernel/src/project-app-session.ts) deliberately mirrors current OS's 15-minute HS256 token. The [current auth implementation](../../../src/auth.ts) already distinguishes `project-secret` and `project-app-session`; the split should preserve those meanings while changing cross-account signing to asymmetric verification.
- The [current RPC tree](../../../src/rpc-targets.ts) already makes `ProjectRpcTarget` the capability root and performs real birth work: directory registration, root birth events, processors, and the born API key. It is too large and hard-codes capability sources, but its external paths are the migration asset.
- The [current OS entrypoint](../../../src/worker.ts) already centralizes public ingress, `/api`, MCP rewriting, webhooks, and Dynamic Worker routing. Those are the exact seams that move into the control plane or runner rather than being reinvented.
- The [config-repo template](../../../config-repo-template/worker.ts) already expresses project behavior as an `IterateWorkerEntrypoint` that handles fetches/events through ITX. That userspace contract survives; the runner changes how its bindings are constructed and where its state lives.
- [`ProjectDial`](../../../../tasks/src/checkout-do.ts) already demonstrates a Cap'n Web `/api` dial, both project credential lanes, project lookup, and reconnect. The new link generalizes and hardens that mechanism with mutual peer identity, generation pinning, leases, and durable idempotency.
- The [tasks config bridge](../../../../tasks/src/config-bridge.ts) performs a member-gated HTTP relay without mounting a remote capability tree. It is evidence that ingress relay and capability acquisition can remain separate concerns.
- The removed `remoteCapability` was a general capability mount. This proposal does not restore it: cross-account transport carries the existing `Project`, while per-capability source selection is explicit and typed inside the runner.
- [`envs.ts`](../../../../../envs.ts) already treats deployed names, accounts, hostnames, and resource IDs as typed non-secret topology and keeps local dev out. `DeploymentSpec` extends that model to runner placements and protocol/digest data; it does not introduce a second configuration religion.
- The current domain-object/processor design makes the durable log authoritative and derived processors restartable. That remains the runner's correctness model; a Service Binding, WebSocket, KV route, or Queue delivery is never the source of truth.

## 6. Three radical reshapings

These are intentionally incompatible alternatives, not variations hidden inside the proposal.

### Radical 1: Workers for Platforms is the whole product

**Pitch:** Put every project's config in one Iterate-owned Workers for Platforms dispatch namespace. A single dispatch Worker handles auth, hostname routing, and outbound interception; one user Worker per project supplies native isolation at enormous tenant counts. Keep all DO/R2/capability services in Iterate's account. Eliminate runner placements, cross-account links, and migration generations.

Cloudflare explicitly gives dispatch namespaces unlimited user Workers, untrusted-mode isolation, dynamic routing, and outbound interception, so this is probably the smallest excellent **hosted** architecture. [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/), [dynamic dispatch Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/)

**Key trade-off:** It makes sovereignty an export feature instead of a topology property. BYO account, local Home Assistant, customer-owned durable data, and independently sourced capabilities become parallel products or stop being true. Choose this if hosted simplicity is more valuable than the independence lattice.

### Radical 2: one sovereign Cloudflare cell per project

**Pitch:** Give every project a dedicated Cloudflare account (or dedicated customer account) containing one monolithic kernel Worker, its DO namespaces, R2, AI Gateway, hostname, wall, and dashboard. Iterate's central service only provisions, bills, and publishes signed releases; it never sits in the runtime path. Projects communicate with integrations over ordinary outbound HTTPS.

This gives the crispest security and ownership story: the Cloudflare account is the project, there is no multi-project runner gateway, and moving ownership means transferring/exporting one cell.

**Key trade-off:** Account creation, API tokens, DNS/certificates, quotas, billing, observability, upgrades, first-party webhook apps, and cross-project organization features become fleet-management problems. A project cannot instantly “emerge” from MCP unless account provisioning is extremely automated. Choose this if hard physical tenancy dominates product velocity and shared ingress.

### Radical 3: no control plane—signed-capability peer mesh

**Pitch:** Make every runner sovereign and locally addressable. A signed directory document in Git/DNS maps project names to runner public keys and rendezvous endpoints. Dashboard, MCP client, agents, and integration relays are peers that present narrowly delegated capability tickets. Local runners always dial a commodity rendezvous service; browsers connect end-to-end where possible. Iterate sells clients, capability providers, and release feeds, not a central application.

The authority graph becomes literal: possession of a signed ticket is the only way to reach a project or provider, and no organization-wide runtime service can accidentally accumulate project data.

**Key trade-off:** Human membership revocation, OAuth callbacks, browsers behind NAT, stable webhooks, custom-domain TLS, abuse prevention, discovery, billing, and support all become distributed-systems/user-experience work. A rendezvous service tends to regrow into a control plane without its explicit policy model. Choose this if local-first operation and censorship/offline resistance matter more than a coherent SaaS front door.
