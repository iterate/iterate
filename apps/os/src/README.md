# itx (`src`)

This folder is itx behind `/api` — os' one API — and everything project-scoped in
OS: streams, repos, agents, secrets, dynamic workers, egress, and the itx
capability surface itself. It began life as `apps/minimal-itx-v4` and was
transplanted here whole during the itx-v4 replacement (PR #1585 has the
history; this README describes what is).

The public contract of record is [`types.ts`](./types.ts) — handwritten,
import-free, and what every client (browser, CLI, scripts, dynamic workers)
programs against. When this README and `types.ts` disagree, `types.ts` wins.

## Layout

| Path                       | What                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                 | The public itx contract (the design of record)                                                                                                  |
| `rpc-targets.ts`           | ALL RpcTarget classes: the session/project/agent surfaces, MCP/OpenAPI clients, capability provision, stream subscriptions, egress              |
| `auth.ts`                  | The auth adapter: credentials → `ItxAuth` (see below)                                                                                           |
| `itx-client.ts`            | `connectItx()` — the Node/CLI client over a Cap'n Web WebSocket                                                                                 |
| `ingress.ts`               | The shared routing decision (which requests belong to itx)                                                                                      |
| `project-directory.ts`     | Slug → project id resolution against the auth worker, cached in the `PROJECT_DIRECTORY` KV namespace                                            |
| `env.ts`                   | The single worker's binding contract ([worker topology](../docs/worker-topology.md))                                                            |
| `worker.ts` / `builder.ts` | The worker entry and the builder sidecar entry                                                                                                  |
| `domains/`                 | One folder per domain: `streams`, `projects`, `repos`, `agents`, `secrets`, `workers` (dynamic), `capability-host`, `itx`, `inbound-mcp-server` |

Each domain owns its Durable Object plus a stream-processor contract
(`*-processor-contract.ts`, pure: event schemas + reducer) and implementation
(`*-processor-implementation.ts`, side effects). RpcTargets deliberately do NOT
live in domain files.

## The four nouns

- A **session** is what `authenticate()` returns: a catalog that vends itxs
  (`projects`, plus admin-only deployment-wide `streams`/`repos`). It is not
  itself an itx.
- A **project** is the tenant / isolation boundary — a `prj_…` id, its Durable
  Objects, its streams. Per-project confinement is the one security invariant
  itx keeps.
- An **itx** is a capability context scoped into one project at one path.
  "itx" is a NAMING CONVENTION, not a class: an itx is normally an instance of
  `ProjectRpcTarget` whose capability host sits at `"/"` — and sometimes at
  `"/agents/…"`, which is what "an agent context" means. Same type either way;
  a nested scope sees its own mounted capabilities plus everything inherited
  from enclosing scopes (child → parent → project).
- A **capability host** is the durable dynamic-capability table (and script
  journal) at one scope path — one `CapabilityHostDurableObject` per
  `{projectId, path}`. Host operations are `provideCapability`,
  `revokeCapability`, `runScript`, and `__describe()`. Each itx fronts exactly
  one host (`itx.capabilityHost`; `itx.provideCapability`/`revokeCapability`
  are shortcuts onto it), and `itx.capabilityHosts.get(path)` addresses any
  other scope's host — `get("/")` mounts on the whole project.

## `__describe()`: discovery everywhere

Every node in the tree answers `__describe()` with the same envelope
(`Description` in `domains/itx/describe.ts`): `instructions` (prose for this node), `types`
(TypeScript source), `children` (one-line blip per member — the high-level
map), and `parent` (where the node sits). Nodes add structured extras — a
project adds `projectId`/`name`/`capabilities`, a session adds `principal`,
an agent adds `whoami` — so `__describe` is also the identity query; there is
no separate `describe()`/`whoami()`.

Deep discovery is a walk: read `children`, recurse into what you care about
(see the `discover-tree` example). Mounted capabilities answer `__describe()`
too — the capability host serves it from the mount's provide-time
`instructions`/`types` metadata, never dialing the live target, so discovery
works even when a session-bound provider is offline. `__describe` is an
invalid MOUNT name (a mount there would be unreachable behind the
interception), but it traverses dynamic paths like any other segment — the
interception is the only mechanism, no proxy special cases.

Today each node hand-writes its description (`describeNode` in
`domains/itx/utils.ts` only enforces the shape); the intended evolution is a
transitive mechanism where a parent composes its children's descriptions.

## The capability tree

What a caller can reach, top to bottom. Concrete classes in parentheses (all in
`rpc-targets.ts`); `->` marks methods that vend a new capability. Every node
also has `__describe()` (not repeated below).

```
UnauthenticatedOs (UnauthenticatedOsRpcTarget)         ws/POST /api
`-- authenticate(credentials)                          -> Session

Session (SessionRpcTarget)                             a catalog; NOT an itx
|                                                      __describe().principal = who you are
|-- streams / repos (projectId: null collections)      admin: deployment-wide
`-- projects (ProjectCollectionRpcTarget)
    |-- list()
    |-- create({ slug })                               -> Itx (project root)
    `-- get("prj_...")                                 -> Itx (project root)

Itx (ProjectRpcTarget) -- "itx" is a convention: capabilityHost.path selects
|      the scope. "/" = project root; "/agents/..." = an agent context.
|      __describe() = identity + children map + full capability inventory.
|-- capabilityHost (CapabilityHostRpcTarget)           THIS scope's durable table
|   |-- path
|   |-- __describe()                                   .capabilities = own + inherited
|   |                                                    mounts, scope-tagged
|   |-- provideCapability(input)                       -> CapabilityProvision (revoke handle)
|   |-- revokeCapability({ path, providedAtOffset? })
|   |-- invokeCapability({ path, args })               explicit dynamic dispatch
|   |-- runScript(code)                                async (itx) => {...} in THIS scope
|   `-- <anything else>                                dotted fallback -> invokeCapability
|-- capabilityHosts (CapabilityHostCollectionRpcTarget)
|   `-- get(path)                                      -> CapabilityHost of ANY scope;
|                                                         get("/") mounts project-wide
|-- provideCapability / revokeCapability               shortcuts -> capabilityHost
|-- debug()                                            dashboard/debug info (Slack-friendly)
|-- integrations (ProjectIntegrationsRpcTarget)               connections + connection-scoped proxies
|   |-- getConnection / startOAuthFlow / disconnect
|   |-- gmail (GmailRpcTarget)                         gmail.request({ path, query })
|   `-- slack (SlackRpcTarget)                         slack.chat.postMessage({ ... })
|-- streams repos repo agents sandboxes secrets        project built-ins, resolved in
|   workers worker egress ai mcp openapi               the isolate (never shadowable)
|   examples processor
|-- agent? chat?                                       DERIVED getters: present only when
|                                                        capabilityHost.path is /agents/...
`-- <anything else>                                    DYNAMIC: the proxy routes unknown
                                                         roots to capabilityHost
                                                         .invokeCapability({ path, args }),
                                                         which chains child -> parent -> "/"

Agent (AgentRpcTarget) -- via itx.agents.get("/agents/...") or itx.agent
|                                                      __describe().whoami = "agent <prj>:<path>"
|-- capabilityHost (CapabilityHostRpcTarget)           the AGENT scope's table
|-- provideCapability / revokeCapability               shortcuts -> capabilityHost
|-- chat (AgentChatRpcTarget), stream, processor
|-- sendMessage(text), ask({ message })
`-- <anything else>                                    same dynamic fallback, agent scope

CapabilityProvision (CapabilityProvisionRpcTarget)     returned by every provide
|-- path, providedAtOffset
|-- revoke()
`-- [Symbol.dispose]                                   `using` revokes on scope exit
```

The itx and agent surfaces have NO dispatch machinery of their own: the
`withInvokeCapabilityFallback` proxy routes every unknown dotted root straight
to the injected capability host, and the host itself carries the same fallback
(`host.foo.bar(x)` is `host.invokeCapability({ path: ["foo","bar"], args: [x] })`).

The load-bearing asymmetry: **reads chain up, writes stay local.**
`invokeCapability`/`__describe` fall through to the enclosing scope on a miss
(agent -> namespace -> project root), so a root mount is visible everywhere.
`provideCapability` always mounts on exactly the host you called it on — to
mount elsewhere, address that scope explicitly via `capabilityHosts.get(path)`.

Slack webhook ingress (`/api/integrations/slack/webhook`) is deliberately NOT
on this tree: it is an HTTP lane in the worker's api pipeline
(`domains/integrations/slack-webhook-api.ts`) that routes signed events
directly into the claiming project's stream. The OAuth callback routes stay
app-side (they need the browser session).

## Connecting and authenticating

`/api` exports one unauthenticated Cap'n Web target with a single method:

```ts
using unauthenticated = connectItx({ baseUrl });
using session = unauthenticated.authenticate({ type: "admin-secret", secret });
using itx = session.projects.get("prj_…");
```

`authenticate()` is the only way in — authority is never forged, only handed
back by a method that checked you. Credential lanes (`auth.ts`):

- `from-server-cookie` — the same-origin browser lane: a signed-in user's
  session cookie or a short-lived operator cookie on the WebSocket handshake.
- `bearer` — an auth-worker OAuth access token as RPC data.
- `admin-secret` — the deployment admin API secret (CLI, tooling, e2e).
- `operator-session` — a short-lived deployment- and origin-bound operator
  grant. A project grant carries one project ID and reconstructs a synthetic
  operator principal; it never adopts a customer identity. A platform grant is
  a separate, explicit authority kind.
- `impersonate` — admin-gated fake principal, so test suites can exercise
  per-project confinement without minting real users.

Project access comes from auth-worker session claims, with a directory
fallback: on a claims miss, `ensureCanAccessProject` consults the auth worker's
project directory (through the KV cache) and widens the live context — this is
how a just-created project is usable before the JWT refreshes. Scoped operator
grants disable this fallback and remain confined to their one signed project
ID, including when the operator knows another valid project slug or ID.

`connectItx` overloads are client-side convenience only:

```ts
using session = connectItx({ auth, baseUrl });
using itx = connectItx({ auth, baseUrl, projectId });
using agent = connectItx({ agentPath: "/agents/demo", auth, baseUrl, projectId });
```

## Project creation

`session.projects.create({ slug })` registers the project with the auth worker
(the project directory — OS has no database of its own), primes the KV cache,
then appends the create-request onto the project's root stream. The project
processor seeds the config repo at `/repos/config` (an ordinary repo on its
own stream — `itx.repo` is the shorthand) from the template folder at
`apps/os/config-repo-template` (ONE TypeScript `worker.ts` — the router as
its default export plus the example apps as named exports — and `package.json`
— platform types come from its `iterate` devDependency's `iterate/sdk` export
— `AGENTS.md`, `ONBOARDING.md`; codegen keeps the seeded file map in
`domains/repos/config-repo-template.generated.ts` in sync), builds and loads
the seeded project worker through the worker build pipeline, boots the
onboarding agent,
and only then emits `events.iterate.com/project/created`. The config repo's
stream carries a `cross-post:/` subscription from birth, so every config-repo
event (the saga's `repo/created` included) is copied onto the project stream
`/` with provenance. Streams are the coordination layer for all of this —
bootstrap is events and processors, not a setup RPC.

## Events

Event types are past-tense facts under `events.iterate.com/...`; the repo-wide
rules are in [`docs/events.md`](../../../docs/events.md). In itx,
contracts declare event schemas and reducers in `*-processor-contract.ts`, and
implementations put side effects in `*-processor-implementation.ts`.

Streams keep raw ingress facts where that matters for audit and replay. For
example, Slack webhook delivery appends
`events.iterate.com/slack/webhook-received` to `/integrations/slack`, and the
Slack processors route or project that fact into agent-facing behavior without
mutating the original payload.

## Capabilities

Built-ins are explicit members of the `Itx` interface (`streams`, `repos`,
`repo`, `agents`, `sandboxes`, `secrets`, `workers`, `worker`, `egress`,
`mcp`, `openapi`, `ai`, `examples`, `processor`, `debug`, plus `agent`/`chat`
on agent scopes). A call like `itx.streams.get("/x")` resolves in the isolate
without touching the capability-host Durable Object; the trade-off is that a
mounted capability can never shadow a built-in name.

Everything else is dynamic: unknown dotted paths fall through to the mounted
capability table (longest-prefix resolution in the capability-host processor, backed by
`capability-provided` events on the scope's stream). `capabilityHost.provideCapability`
accepts two recipes (`ProvideCapabilityInput`):

- `live` — any RPC-able value: a bare function, an object of methods, or an
  `invokeCapability({ path, args })` target when `flattenNestedPaths` is set.
  Live capabilities are session-bound: the mount event is durable, but calls
  travel back over the provider's connection and die with it.
- `itx-expression` — a durable expression replayed against the project's own
  itx surface (`domains/capability-host/itx-expression.ts`), so a mount survives
  disconnects without holding a live stub.

Every mount carries optional `instructions` (prose) and `types` (a TypeScript
source string exporting `type Capability`). `itx.__describe()` returns project
identity plus the full capability inventory — built-ins and mounts, from
declared metadata only, never by probing live targets. Agents are a first-class
audience and `describe()` is their only sense organ; write instructions for the
stranger who finds the capability there.

`project.mcp.connect(...)` and `project.openapi.connect(...)` return ad-hoc
client targets (no mount, no events): `connect` discovers (lists MCP tools /
fetches the OpenAPI spec through project egress), and the returned target
answers `describe()` and fallback-dispatches every other property as a tool
name / flat `operationId`. `project.mcp.exa` is the same client shape
pre-connected to Exa's public MCP server (`https://mcp.exa.ai/mcp`), so every
project has web search (`web_search_exa`) and page reading (`web_fetch_exa`)
with zero setup.

## Secrets and egress

Secret material is write-only: `itx.secrets.get(path).update({ material,
egress: { urls } })` stores it encrypted in the Secret Durable Object;
`describe()` returns audit metadata, never material. Outbound requests
reference secrets as placeholders — `getSecret({ path: "/secrets/foo" })` in a
header — and `itx.egress.fetch(request)` substitutes them only when the
request origin is in the secret's egress allowlist, recording usage audit
events. Dynamic workers' bare `fetch()` routes through the same egress path.
`itx.egress.intercept(handler)` installs a live replacement for testing;
the interceptor sees placeholders, never material
(`apps/os/docs/adr/0002-project-egress-interception-uses-fetch-capabilities.md`).

## Dynamic workers

`itx.workers.get(ref)` runs caller-supplied code in an isolate via the Worker
Loader. Runners are `DynamicWorkerRunner`
(`domains/workers/worker-runner.ts`) — its constructor is the one place a
dynamic isolate gets its scoped itx binding and egress fetcher. A `DynamicWorkerRef` is
`stateless` (a WorkerEntrypoint export, with
optional `props`) or `stateful` (a DurableObject class export hosted by
`StatefulWorkerDurableObject` under a `durableWorkerKey`). Its source is an
orthogonal file source plus Cloudflare build options: files come `inline` or
from a `repo` snapshot (branch late-bound or commit-pinned, masked by
include/exclude globs), and the builder sidecar (`src/builder.ts` — the only
script carrying the bundler toolchain) bundles them — multi-file
TypeScript and `package.json` npm dependencies included — into a KV-cached,
loader-ready artifact keyed deterministically (see
`docs/dynamic-worker-build-requirements.md`). Builds are a direct RPC
(`env.BUILDER.build`, files passed by value); they leave no events in the
journal, and build failures reach the
caller as plain errors. Inside
loaded code, `await env.ITX.get()` returns a full itx at the ref's scope path.
`itx.worker` is the seeded project worker — the same mechanism pointed at the
default repo's `worker.ts`.

Note: method-returned itx surfaces pipeline on every transport, including
script isolates over Workers RPC — `await itx.workers.get(ref).method(...)`,
`await itx.agents.get(path).create({})`, and (after birth)
`await itx.agents.get(path).message(...)` work as one expression (the
dynamic-capability fallback lives on the classes' prototype chains, so the
returned instances are genuine RpcTargets; see
`installPrototypeInvokeCapabilityFallback`). For several calls on one
surface, take the handle WITHOUT awaiting it and fan out — the capnweb
pattern:

```ts
using agent = itx.agents.get(path); // no await
await agent.create({});
const [sent, description] = await Promise.all([agent.message("hello"), agent.__describe()]);
```

Await a handle itself only when you truly need the settled stub.

## Agents

An agent is a stream (`/agents/<name>`) plus processors. `agent.message()`
appends `events.iterate.com/agents/context-added`: a user-role item for an
external caller, or a developer-role item with an agent actor for agent-to-agent
messages. The single agent processor folds all model-visible context into a
provider-neutral projection with a compaction-immune system lane and a history
lane, applies user/developer request policies, debounces, and appends
`events.iterate.com/agent/llm-request-requested` — **by reference**: no prompt
body, and the event offset is the `llmRequestId`. That same processor rebuilds
the request by reducing committed events through that offset, runs it through
the Cloudflare AI binding (`env.AI`), and journals the request lifecycle plus
the assistant context item. See [Agent context and turns](../docs/agents.md)
for projection, key publication, provider-role, and compaction semantics.

The agent contract is to respond with exactly one fenced TypeScript block
containing a single `async (itx) => { … }`, which the capability-host processor
executes. Replies reach the user via `itx.chat.sendMessage(message)`
(`events.iterate.com/agents/web-message-sent`). Scripts behave like tool calls:
a returned value (or thrown error) becomes a developer context item and
triggers another turn, while a script that returns `undefined` ends the loop —
the completion event then carries no `result` key. `agent.ask({ message })` is
the send-and-wait convenience.

## Stream processor hosting

`StreamDurableObject` owns the journal (DO SQLite); its storage methods stay
synchronous internally while the public `Stream` capability is async through
an RpcTarget. Processors are hosted by their domain DO via
`createStreamProcessorHost(...)` — `host.add((deps) => new SomeProcessor(deps))`
— and receive a full public `Stream` capability, never raw DO stubs.
Subscription handshakes are identity-only: the stream tells the host which
`subscriptionKey` to open; the host answers with the one public
`subscribe({ subscriptionKey, configured: true })` verb on its own stream
capability, handing the stream a live `processEventBatch` callback (the same
live-capability shape as itx provision). State is a fold of the journal; the
`{offset, state}` checkpoint is a disposable cache. The domain's own guide is
`domains/streams/README.md`; the doctrine is
`docs/domain-objects-and-stream-processors.md`.

The browser stream mirror is a second host of the same engine: the dashboard
keeps a local event table plus derived tables and runs real `StreamProcessor`
contracts in the browser host, with announcements preserved
(`domains/streams/client-libraries/browser/`).

## Workers RPC types patch

itx relies on `patches/@cloudflare__workers-types@4.20260621.1.patch`:
upstream types collapse to `never` when an RPC method returns a
non-serializable nested object, but itx passes typed capability objects
over Durable Object RPC (and needs `ctx.exports` loopback types). The patch
changes the fallback to keep those returns usable. `pnpm-workspace.yaml`
applies it via `patchedDependencies`; run `pnpm install` from the repo root
after touching the patch or the workers-types version.

## Testing

- `apps/os/e2e/vitest/` — itx e2e suites (streams, itx, project
  ingress, security), run through `pnpm e2e` against a live deployment.
- `apps/os/e2e/examples/` — the example matrix: the REPL example catalogue
  executed across every runtime (browser REPL, Node, `runScript`, project
  worker). Part of `pnpm e2e` (the `node` project runs the matrix headless; the
  `browser` project runs it in a real browser).
- Known caveat: repo-sourced project-worker scenarios fail against LOCAL vite
  dev with a masked `internal error; reference =` (capnweb/vite-dev RpcTarget
  identity class). They pass against deployed previews — verify there before
  treating one as a regression.
