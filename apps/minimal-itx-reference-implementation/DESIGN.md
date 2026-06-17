# Minimal itx reference implementation — design

itx is Iterate's capability layer over Cap'n Web. A **context** is a bag of
named **capabilities** you can invoke, provide to, and describe. This package is
the smallest coherent implementation that is still the real thing: the contexts
are real `StreamProcessor`s backed by the real platform `Stream` Durable Object,
served over real Cap'n Web to real workerd. No steps, no narrative — one design.

If you want the long-form derivation (why each decision, the debugging rounds
behind the dynamic proxy), see `apps/itx-workshop/itx-explainer.md`. This doc is
the reference: what exists and why, stated once.

## The model in one paragraph

A context is the **fold of a durable event log**. You don't mutate a registry;
you append events (`capability-provided`, `capability-revoked`) and the
capability table is their reduction. The log is the single source of truth; the
table is derived and reconstructible by replay. A capability is either **live**
(an in-memory stub that dies with its provider) or **sturdy** (a plain-data
address that can be re-dialed into a callable). Contexts form a **chain**: on a
miss, an agent's embedded itx processor falls through to its project through a
host-injected parent link. A **project is the top of its chain** (a miss there
just throws). There is no global context: cross-project listing and the platform
streams live behind the separate, admin-only **Root ITX** (`root-itx.ts`).

## Capabilities: live vs sturdy

One field discriminates, and it is not a `kind` enum — it is the `address`:

|            | `address`            | where the callable lives             | durable?                            |
| ---------- | -------------------- | ------------------------------------ | ----------------------------------- |
| **live**   | `null`               | the in-memory bridge beside the fold | no — dies with its provider/session |
| **sturdy** | `{ type: "rpc", … }` | rebuilt on demand by `dial`          | yes — the address is in the log     |

`CapabilityRecord` (`contract.ts`) is `{ path, address, instructions, types }`.
A live provide records `address: null` and stashes the real stub in the bridge;
a sturdy provide records the address and stashes nothing. `address === null` is
the entire test (`itx.ts`'s `isCapabilityAddress`).

Paths are **arrays of segments** (`["slack", "chat", "postMessage"]`), matched
by **longest registered prefix** so a deep shadow beats a broad mount. There is
no dotted-string key anywhere in resolution.

## The four verbs (one calling convention)

Every context implements `ItxContext`:

```ts
provideCapability({ path, capability, instructions?, types? }) → { path }
invokeCapability({ path, args? })                              → unknown
revokeCapability({ path })                                     → void
describe()                                                     → DescribeResult
```

Every verb takes a **single bag-of-props** argument. On the Cap'n Web dotted
surface, even these verbs arrive as `invokeCapability({ path, args })`:
`itx.describe()` is path `["describe"]`, and
`itx.provideCapability(args)` is path `["provideCapability"]`. The context owns
those reserved root names and dispatches them before ordinary capability
resolution. User capabilities cannot be mounted under those names, so the
control surface cannot be shadowed. `describe()` is the only read verb (there is
no `list`); it returns the raw folded `capabilities` and the host-injected
`builtins`.

## The client — naked path calls, normalized live provides

For reads and calls, the client holds a **bare Cap'n Web session stub**. Cap'n
Web already turns `stub.a.b.c(args)` into one pipelined message (the stub
accumulates the path locally, zero round trips). There is no client-side path
proxy for `itx.slack.chat.postMessage(...)`; the server collapses that path.

There is one client-side write convenience: `withItx` intercepts
`provideCapability`. Raw local SDK instances such as `new Slack.WebClient()` are
not serializable Cap'n Web values, so the client keeps the SDK object in the
provider process and sends a tiny live path-call provider instead:
`{ invokeCapability({ path, args }) { ... } }`. The kernel still sees the same
simple live shape as every other provider. When the socket closes, that function
stub dies and the folded live row becomes offline.

For DO-backed itx contexts, the load-bearing piece is **server-side**:
capabilities are registered at runtime, so the served main object can't be a
fixed method-only class. `pathProxyToInvokeCapability` (`server.ts`) is a
`Proxy` over a **function**. It answers any non-reserved name and, on the
terminal call,
collapses the accumulated path into one `invokeCapability({ path, args })`.
It does not know about `describe` or `provideCapability`; those are just paths
until the context receives them. Three requirements (each a real debugging
round) are encoded there: the target must be function-typed,
`getOwnPropertyDescriptor` must answer (Cap'n Web does `Object.hasOwn` before
reading), and `has` must answer for non-reserved names. A `RESERVED` set blocks
names that would derail it (`then`, `__proto__`, ...).

## dial — address → stub

The host Durable Object's dial turns a durable capability address back into a
callable, dispatched on `address.type`:

- `{ type: "dynamic-worker", source, entrypoint, props }` → build + run a
  WorkerEntrypoint via the **Worker Loader**, cached by content hash, with
  `env.ITX` scoped back to the same host context
- `{ type: "dynamic-durable-object", source, className }` → load a Durable
  Object class and run it as a facet of the current Project/Agent Durable Object

Trusted topology is not a public address vocabulary. A user (or codemode)
`provideCapability` naming `durable-object` or `worker-entrypoint` is rejected
(`itx.ts`). Built-ins such as `fetch`, `repo`, and `agents` are live runtime
targets constructed by the host Durable Object from its own Project ID. What a
user CAN provide — live caps and `dynamic-worker`/`dynamic-durable-object` —
carries no cross-project reach: dynamic code receives only this context's scoped
`env.ITX`, and repo-backed sources are resolved through the host project's repo.

## The chain — inheritance by late binding

An agent context's host injects a parent link to the project context.
`invokeCapability` resolves own fold → built-ins → parent. A child **shadows**
its parent by late binding (re-resolved per call), never by copy.

Topology: an **agent** (`<projectId>:/agents/<name>`) is hosted by its
`AgentDurableObject`, whose parent is the **project** (`<projectId>:/`) hosted by
`ProjectDurableObject`. A project is the top of its chain. Parentage is derived
from the host object, not folded from the log — nothing reads a folded copy, so
it isn't stored. Because the chain never leaves the project, a context can only
ever reach its own project's objects.

## Built-in capabilities — the domain objects

A context is born with capabilities defined by the host **domain object**.
`ProjectDurableObject` offers live runtime targets for `fetch`, `repo`, and
`agents`; `AgentDurableObject` offers `whoami`. Built-ins are handed to the
`ItxProcessor` constructor as an array of the same `ProvideArgs` shape a provide
uses, but they are live host-owned targets, not stored topology refs. Own
provides shadow a built-in at the same path; changing built-ins is a code change,
not a log rewrite.

`project.agents.get("/agents/alice")` accepts only a full project-local agent
path. The Project ID and Durable Object namespace/name are derived by the
project host, and the returned RPC target forwards all public methods on the
Agent Durable Object, including `agent.itx()`.

`RepoDurableObject` is deliberately fake. It only exposes `counter.js`, a
hard-coded source file that exports both `CounterEntrypoint` and
`CounterDurableObject`. This proves the repo-backed dynamic topology without
pulling in real Artifacts or bundling machinery.

## The admin Root ITX — the platform plane

`RootItx` (`root-itx.ts`) is **not** a context and **not** a Durable Object: a
tiny fixed RPC surface served at `/api/itx`, constructed per connection at the
edge and run through the same `pathProxyToInvokeCapability` rule, so
`root.projects.list()` and `root.streams.get("/x").append(event)` collapse to one
`invokeCapability` just like a context's dotted calls.

It exists because `__null__` (the platform projectId) holds streams that belong
to no project — integration webhooks, the project catalog. Those are deliberately
NOT a connectable context (`/api/itx/__null__` is refused and nothing
can dial into `__null__` from a project). The only door is here, and it is safe
with no authority logic of its own:

- **admin-only** — the edge serves it only to a principal whose `access` is
  `"all"` (`auth.ts`); a non-admin gets `403`.
- **no provide, no dialer** — the surface is exactly `projects` and `streams`, so
  there is nothing to inject a capability into and no caller-supplied name to dial.
- **streams pre-scoped** — the caller passes a `path` only; the projectId is
  hardcoded to `__null__`, so a caller cannot pivot to another project's streams
  (names are built from the scope the root already owns).

Adding a sibling surface (`users`, `orgs`) is just another branch in
`invokeCapability`.

## Codemode — a capability that is a program

`POST /api/itx/<projectId>` loads an `async (itx) => ...` program as a worker via
the selected Project/Agent host's `runScript({ code })` (same Worker Loader as
`dial`) and hands it an **itx handle** so it can invoke and provide against the
very context that launched it. The run is bracketed by durable
`script-execution-requested` /
`-completed` records — events the fold does **not** consume, demonstrating that
a log holds both state changes and plain audit records. `runScript` needs the
Worker Loader and is intentionally not part of the Cap'n Web ITX model.

## Auth — one decision, at the connect door

The entire model is one line: you are either an **admin** (`access: "all"`, may
reach anything, nobody cares) **or** you hold a **list of project ids** and may
reach exactly those. `access` is the same `"all" | string[]` shape apps/os
linearizes a principal to (`accessForPrincipal`). There is no per-capability
gating anywhere downstream — once the connect door (`auth.ts`
`authorizeProjectAccess`) lets you into a project, everything inside is confined
BY CONSTRUCTION:

- built-ins are host-owned runtime targets scoped to that project;
- the chain tops out at that project (no global catalog to climb to);
- user provides cannot name another project's Durable Object (the dialer-address
  types are host-built-ins only).

So authority lives at the door and nowhere else. The Root ITX (`/api/itx`) uses
the same `authenticate` and additionally requires `access === "all"`.

## The serving edge

The route uses Cap'n Web's Worker helper directly:
`newWorkersRpcResponse(request, target)`.

Every target is `pathProxyToInvokeCapability({ invokeCapability })`. `/api/itx`
serves the admin Root ITX. `/api/itx/<projectId>` serves the project context by
forwarding into `ProjectDurableObject.itx()`. There is no public agent connect
endpoint: a caller gets an agent through `project.agents.get("/agents/name")`
and then calls `agent.itx()`. Do not pass a raw Durable Object stub straight to
`pathProxyToInvokeCapability`: DO stubs make arbitrary properties look callable,
which is precisely the ambiguity this proxy avoids.

## Files

| File                                        | What                                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`                               | the itx event log: event schemas + reduced state (`defineProcessorContract`)                                                                                           |
| `itx.ts`                                    | `ItxProcessor extends StreamProcessor` (the fold + verbs + bridge + chain), the common vocabulary (`replayPath`, `retain`, prefix matching), the `ItxContext` protocol |
| `root-itx.ts`                               | `RootItx` — the admin-only platform root (`/api/itx`): the project catalog + `__null__` streams, pre-scoped; no provide, no dialer                                     |
| `durable-object-names.ts`                   | the one place `{projectId}:{path}` names are formatted/parsed; `PLATFORM_PROJECT_ID` (`__null__`)                                                                      |
| `auth.ts`                                   | the connect-door access model (`"all" \| string[]`) — the single authority decision                                                                                    |
| `server.ts`                                 | the Worker: `pathProxyToInvokeCapability`, embedded Project/Agent itx hosts, dynamic worker/facet loading, the `/api/itx` route; re-exports the real `Stream` DO       |
| `client.ts`                                 | `withItx` + `connect` — socket opener, naked path calls, and provide-time normalization for raw local SDK objects                                                      |
| `cli.ts`                                    | a tiny command-line itx runner — the matrix's process-boundary runtime                                                                                                 |
| `e2e-env.ts`                                | which running worker to talk to + which demo principal to authenticate as (the suite never starts a server; mirrors apps/os)                                           |
| `examples.ts`                               | the catalogue: pure-data script bodies (`itx` + `vars` in scope, explicit `return`) the matrix runs across every runtime                                               |
| `example-cases.ts`                          | test-only setup + `vars` + assertions per catalogue entry (so `examples.ts` stays pure data, and examples can't silently rot)                                          |
| `example-matrix.ts`                         | runs a catalogue body through every server-side runtime (node, cli, post-script, dynamic-worker)                                                                       |
| `itx-scripts.ts`                            | reusable sturdy capability sources used by the tests (dynamic workers, repo-backed DO facets, …)                                                                       |
| `itx.e2e.test.ts`                           | the node vitest project: every core concept, then the catalogue matrix across server runtimes                                                                          |
| `itx.cross-project-adversarial.e2e.test.ts` | the cross-project isolation attacks (dial-by-name rejection, connect-door denial, `__null__` refusal)                                                                  |
| `itx.parent-adversarial.e2e.test.ts`        | forged `worker-entrypoint` rejection + reserved `itxParent` segment guard                                                                                              |
| `itx.root.e2e.test.ts`                      | the admin Root ITX: project catalog + `__null__` stream read/write as admin; non-admin refused                                                                         |
| `itx.browser.test.ts`                       | the browser vitest project: the catalogue in a real Chromium tab (token-in-query auth)                                                                                 |
| `vitest.config.ts`                          | the two-project (node + browser) config                                                                                                                                |

## What this deliberately omits

The capability model is complete; the surface is trimmed. No incremental "steps"
(this is the end state), no Swift/native-dialog or real-SDK demos, no
durability/replay proofs baked into the implementation (that the table is the
fold of the log is StreamProcessor's contract, not ours to re-prove). The
read-your-writes wait uses the StreamProcessor delivered-offset await; no
local polling loop is needed.
