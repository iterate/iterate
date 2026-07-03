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

| Path                   | What                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`             | The public ITX contract (the design of record)                                                                                                  |
| `rpc-targets.ts`       | ALL RpcTarget classes: the session/project/agent surfaces, MCP/OpenAPI clients, capability provision, stream subscriptions, egress              |
| `auth.ts`              | The auth adapter: credentials → `ItxAuth` (see below)                                                                                           |
| `itx-client.ts`        | `connectItx()` — the Node/CLI client over a Cap'n Web WebSocket                                                                                 |
| `ingress.ts`           | The shared routing decision (which requests belong to itx)                                                                                      |
| `project-directory.ts` | Slug → project id resolution against the auth worker, cached in the `PROJECT_DIRECTORY` KV namespace                                            |
| `env.ts`               | The binding contract every itx worker deploys with (`nextEnv`)                                                                                  |
| `workers/`             | One entrypoint per deployed itx worker ([worker topology](../../docs/worker-topology.md))                                                       |
| `domains/`             | One folder per domain: `streams`, `projects`, `repos`, `agents`, `secrets`, `workers` (dynamic), `capability-host`, `itx`, `inbound-mcp-server` |
| `e2e-fixtures.ts`      | Worker-hosted fixtures for itx e2e suites (`/__itx_e2e/*`)                                                                                      |

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
  `revokeCapability`, `runScript`, and `describe()`. Each itx fronts exactly
  one host (`itx.capabilityHost`; `itx.provideCapability`/`revokeCapability`
  are shortcuts onto it), and `itx.capabilityHosts.get(path)` addresses any
  other scope's host — `get("/")` mounts on the whole project.

## The capability tree

What a caller can reach, top to bottom. Concrete classes in parentheses (all in
`rpc-targets.ts`); `→` marks methods that vend a new capability.

```
UnauthenticatedOs (UnauthenticatedOsRpcTarget)        ws/POST /api
└─ authenticate(credentials)                          → Session

Session (SessionRpcTarget)                            a catalog; NOT an itx
├─ whoami()
├─ integrations (SessionIntegrationsRpcTarget)        admin: webhook ingress
├─ streams / repos (…CollectionRpcTarget, projectId: null)   admin: deployment-wide
└─ projects (ProjectCollectionRpcTarget)
   ├─ list()
   ├─ create({ slug })                                → Itx (project root)
   └─ get("prj_…")                                    → Itx (project root)

Itx (ProjectRpcTarget) — "itx" by convention; capabilityHost.path selects the scope:
│    "/" = project root; "/agents/…" = an agent context. Same class both ways.
├─ capabilityHost (CapabilityHostRpcTarget)           THIS scope's durable table
│  ├─ path
│  ├─ describe()                                      own + inherited mounts, scope-tagged
│  ├─ provideCapability(input)                        → CapabilityProvision (revoke handle)
│  ├─ revokeCapability({ path, providedAtOffset? })
│  ├─ invokeCapability({ path, args })                explicit dynamic dispatch
│  └─ runScript(code)                                 async (itx) => {…} in THIS scope
├─ capabilityHosts (CapabilityHostCollectionRpcTarget)
│  └─ get(path)                                       → CapabilityHost of ANY scope;
│                                                       get("/") mounts project-wide
├─ provideCapability / revokeCapability               shortcuts → capabilityHost
├─ describe()                                         project identity + full inventory
├─ streams repos repo agents sandboxes secrets       project built-ins, resolved in the
│  workers worker egress ai gmail slack integrations  isolate (never shadowable)
│  mcp openapi examples processor debug
├─ agent? chat?                                       DERIVED getters: present only when
│                                                       capabilityHost.path is /agents/…
└─ <anything else>                                    DYNAMIC: proxy fallback compiles
                                                        itx.foo.bar(x) into capabilityHost
                                                        .invokeCapability({ path, args }),
                                                        which chains child → parent → "/"

Agent (AgentRpcTarget) — via itx.agents.get("/agents/…") or itx.agent
├─ capabilityHost (CapabilityHostRpcTarget)           the AGENT scope's table
├─ provideCapability / revokeCapability               shortcuts → capabilityHost
├─ chat (AgentChatRpcTarget) · stream · processor
├─ sendMessage(text) · ask({ message }) · whoami()
└─ <anything else>                                    same dynamic fallback, agent scope

CapabilityProvision (CapabilityProvisionRpcTarget)    returned by every provide
├─ path · providedAtOffset
├─ revoke()
└─ [Symbol.dispose]                                   `using` revokes on scope exit
```

The load-bearing asymmetry: **reads chain up, writes stay local.**
`invokeCapability`/`describe` fall through to the enclosing scope on a miss
(agent → namespace → project root), so a root mount is visible everywhere.
`provideCapability` always mounts on exactly the host you called it on — to
mount elsewhere, address that scope explicitly via `capabilityHosts.get(path)`.

## Connecting and authenticating

`/api` exports one unauthenticated Cap'n Web target with a single method:

```ts
using unauthenticated = connectItx({ baseUrl });
using session = unauthenticated.authenticate({ type: "admin-secret", secret });
using itx = session.projects.get("prj_…");
```

`authenticate()` is the only way in — authority is never forged, only handed
back by a method that checked you. Credential lanes (`auth.ts`):

- `from-server-cookie` — the browser lane: the signed-in user's session cookie
  (or the admin cookie) riding the WebSocket handshake.
- `bearer` — an auth-worker OAuth access token as RPC data.
- `admin-secret` — the deployment admin API secret (CLI, tooling, e2e).
- `impersonate` — admin-gated fake principal, so test suites can exercise
  per-project confinement without minting real users.

Project access comes from auth-worker session claims, with a directory
fallback: on a claims miss, `ensureCanAccessProject` consults the auth worker's
project directory (through the KV cache) and widens the live context — this is
how a just-created project is usable before the JWT refreshes.

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
processor seeds the default repo at `/` from static template files
(`domains/repos/project-repo-template.ts`: `worker.js`, `README.md`,
`AGENTS.md`, `ONBOARDING.md`), loads the seeded project worker, boots the
onboarding agent,
and only then emits `events.iterate.com/project/created`. Streams are the
coordination layer for all of this — bootstrap is events and processors, not a
setup RPC.

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
source string exporting `type Capability`). `itx.describe()` returns project
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
Loader. A `DynamicWorkerRef` is `stateless` (a WorkerEntrypoint export, with
optional `props`) or `stateful` (a DurableObject class export hosted by
`StatefulWorkerDurableObject` under a `durableWorkerKey`); source is `inline`
(module text) or `repo` (resolved from a project repo, so commits affect the
next use). Inside loaded code, `await env.ITX.get()` returns a full itx at the
ref's scope path. `itx.worker` is the seeded project worker — the same
mechanism pointed at the default repo's `worker.js`.

Note: in script isolates, Workers RPC does not pipeline through unresolved
returns — `await itx.workers.get(...)` / `await itx.agents.get(...)` before
calling methods on them.

## Agents

An agent is a stream (`/agents/<name>`) plus processors. `agent.sendMessage()`
appends `events.iterate.com/agents/user-message-received`; the agent core
processor renders inputs into history, applies the input policy, debounces,
and appends `events.iterate.com/agent/llm-request-requested` — **by
reference**: no prompt body, the offset is the `llmRequestId`. A subscribed
provider processor (`cloudflare-ai` or `openai-ws`; default computed in the
project DO — openai-ws when the OpenAI key is present) rebuilds the request by
reducing committed history up to that offset, executes the call, and appends
started/chunk/output/completed events. The agent contract: respond with
exactly one fenced JavaScript block containing a single
`async (itx) => { … }`, which the ITX processor executes; replies reach the
user via `itx.chat.sendMessage({ message })`
(`events.iterate.com/agents/web-message-sent`). Scripts behave like tool
calls: a returned value (or thrown error) renders back into history as the
next input and triggers another turn, while a script that returns `undefined`
ends the loop — the completion event then carries no `result` key.
`agent.ask({ message })` is the send-and-wait convenience.

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
