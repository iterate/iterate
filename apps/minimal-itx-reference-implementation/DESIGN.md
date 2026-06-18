# Minimal itx reference implementation — design

itx is Iterate's capability layer over Cap'n Web. A **context** is the
object-capability RPC surface of a hosting Durable Object: named capabilities you
can invoke, provide to, and describe. This package is the smallest coherent
implementation that is still the real thing: project and agent hosts embed a real
`StreamProcessor` backed by the real platform `Stream` Durable Object, served
over real Cap'n Web to real workerd. No steps, no narrative — one design.

If you want the long-form derivation (why each decision, the debugging rounds
behind the dynamic proxy), see `apps/itx-workshop/itx-explainer.md`. This doc is
the reference: what exists and why, stated once.

## The model in one paragraph

A context is the **fold of a durable event log**. You don't mutate a registry;
you append events (`capability-provided`, `capability-revoked`) and the
capability table is their reduction. The log is the single source of truth; the
table is derived and reconstructible by replay. A capability is either **live**
(an in-memory stub that dies with its provider) or **durable dynamic** (a
plain-data `DynamicWorkerRef` that can be resolved into a callable worker
entrypoint or Durable Object facet). Project and Agent Durable
Objects host their own embedded itx processor. Each host is mounted as the
context's base built-in at `path: []`, so public methods/getters on the host DO
are the default capability surface. There is no global context and no implicit
parent traversal: an agent reaches its project explicitly through `itx.project`.
Cross-project listing and the platform streams live behind the separate,
admin-only **Root ITX** (`src/itx/root.ts`).

## Capabilities: live vs durable dynamic

One field discriminates, and it is not a `kind` enum — it is the `address`:

|                     | `address`                                                             | where the callable lives             | durable?                            |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------ | ----------------------------------- |
| **live**            | `null`                                                                | the in-memory bridge beside the fold | no — dies with its provider/session |
| **durable dynamic** | `{ type: "worker-entrypoint", … }` or `{ type: "durable-object", … }` | rebuilt on demand by the host        | yes — the address is in the log     |

`CapabilityRecord` (`src/itx/processor-contract.ts`) is `{ path, address, instructions, types }`.
A live provide records `address: null` and stashes the real stub in the bridge;
a durable dynamic provide records the address and stashes nothing.
`address === null` is the live/durable line; `durableCapabilityAddress(...)`
recognizes the public `DynamicWorkerRef` shapes.

The durable dynamic address shape is the same data structure consumed by
`itx.workers.get(ref)`:

```ts
type DynamicWorkerRef = (
  | {
      type: "worker-entrypoint";
      source: DynamicWorkerSourceRef;
      entrypoint?: string; // defaults to the Worker's default entrypoint
      props?: Record<string, unknown>;
    }
  | {
      type: "durable-object";
      source: DynamicWorkerSourceRef;
      className: string;
    }
) & {
  cacheKey?: string;
};

type DynamicWorkerSourceRef =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "from-repo";
      repoPath: string;
      sourcePath: string;
    };
```

`from-repo` is project-scoped by construction: callers name a repo path inside
the current project, never a project id or global repository binding.

Paths are **arrays of segments** (`["slack", "chat", "postMessage"]`), matched
by **longest registered prefix** so a deep shadow beats a broad mount. There is
no dotted-string key anywhere in resolution.

## Control verbs (one calling convention)

Every context implements `ItxContext`:

```ts
provideCapability({ path, capability, instructions?, types? }) → { path }
invokeCapability({ path, args? })                              → unknown
revokeCapability({ path })                                     → void
describe()                                                     → DescribeResult
runScript({ code })                                            → RunScriptResult
```

Every control verb takes a **single bag-of-props** argument. On the Cap'n Web dotted
surface, even these verbs arrive as `invokeCapability({ path, args })`:
`itx.describe()` is path `["describe"]`, and
`itx.provideCapability(args)` is path `["provideCapability"]`. The context owns
those reserved root names and dispatches them before ordinary capability
resolution. User capabilities cannot be mounted under those names, so the
control surface cannot be shadowed. `describe()` is the only read verb (there is
no `list`); it returns the raw folded `capabilities` and host-injected
`builtinCapabilities`.

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
fixed method-only class. `pathInvokerToProxy` (`src/itx/path-invoker.ts`) is a `Proxy` over a
**function**. It answers any non-reserved name and, on the terminal call,
collapses the accumulated path into one `invokeCapability({ path, args })`.
Its inverse is `objectToPathInvoker`: a tiny adapter that takes a host object and
answers `invokeCapability` by replaying the path onto the concrete host class's
public methods/getters. Host DOs mount `objectToPathInvoker(this, ...)` as the
built-in at `path: []`; the edge uses `pathInvokerToProxy(...)` to serve an
invoker as a dotted Cap'n Web surface.

The proxy does not know about `describe` or `provideCapability`; those are just
paths until the context receives them. Three requirements (each a real debugging
round) are encoded there: the target must be function-typed,
`getOwnPropertyDescriptor` must answer (Cap'n Web does `Object.hasOwn` before
reading), and `has` must answer for non-reserved names. A `RESERVED` set blocks
names that would derail it (`then`, `__proto__`, ...).

## Dynamic workers — ref → proxied capability

Dynamic worker/facet resolution is a capability object, not duplicated host
logic. Project and Agent hosts each construct one `DynamicWorkersRpcTarget` and
use that same instance in two places:

- pass it to `ItxProcessor` so mounted durable dynamic addresses and scripts can
  run;
- mount it as the ordinary, shadowable `workers` built-in, so callers can use
  `itx.workers.get(ref).someMethod(...)`.

`DynamicWorkersRpcTarget` has one public method:

```ts
get(ref: DynamicWorkerRef): unknown
```

It returns a proxied callable surface, not a raw Worker Loader stub. That keeps
entrypoint methods, Durable Object facet methods, and nested `RpcTarget` returns
usable through the same dotted path style as every other capability.

Internally, `get(ref)` resolves `ref.source`, loads the dynamic Worker with
Cloudflare's Worker Loader, and then resolves either:

- `{ type: "worker-entrypoint", source, entrypoint?, props? }` to a
  WorkerEntrypoint, where `entrypoint` may be omitted for the default entrypoint;
- `{ type: "durable-object", source, className }` to a Durable Object facet of
  the current Project/Agent host.

Facet storage stays with the current host DO. That matches the authority model:
a dynamic Durable Object capability belongs to the Project or Agent context that
mounted it, and its facet identity can include the capability mount path.

The target is constructed with concrete project-scoped authority: `projectId`,
the Worker Loader binding, the current host's facets API, and the worker env
bindings to inject into dynamic code. `projectId` is not caller-controlled; it is
used both as the first cache-key prefix and to resolve `from-repo` sources only
inside the current project.

Worker Loader cache identity ladders from broad to specific:

1. `DynamicWorkersRpcTarget` prefixes with `projectId`.
2. `ItxProcessor` adds the mounted capability path when it invokes a durable
   dynamic capability.
3. `DynamicWorkerRef.cacheKey` adds caller/source semantic identity when useful.
4. Source resolution appends a content/build hash so changed code gets a new
   Worker Loader id.

Host topology is not a public address vocabulary. A user (or codemode) can
provide live caps or `DynamicWorkerRef` addresses; any other `type`-tagged
address is rejected before it enters the log. Host surfaces such as `egress`,
`repo`, `agents`, `workers`, `whoami`, and `project` are live runtime targets
constructed by the host Durable Object from its own project scope. Dynamic code
receives only the bindings the host injects, including this context's scoped
`env.ITX`.

## Host-root capabilities — the domain objects

A context is born with one base capability defined by the host **domain object**:
`{ path: [], capability: objectToPathInvoker(this, ItxHostDurableObject.prototype) }`.
`ProjectDurableObject` offers public members such as `egress`, `repo`, `agents`,
and `workers`; `AgentDurableObject` offers `whoami`, `sendMessage`, `project`,
and `workers`.
The empty path is host-owned; user provides must name at least one path segment.
Host-root capabilities are handed to the `ItxProcessor` constructor as the same
`ProvideArgs` shape a provide uses, but they are live host-owned targets, not
stored topology refs. Own provides shadow the base host surface by longest-prefix
matching; changing the host root is a code change, not a log rewrite.

`project.agents.get("/agents/alice")` accepts only a full project-local agent
path. The Project ID and Durable Object namespace/name are derived by the
project host, and the returned value is that agent's ITX surface.

`RepoDurableObject` is deliberately fake. It only exposes `counter.js`, a
hard-coded source file that exports both `CounterEntrypoint` and
`CounterDurableObject`. This proves the repo-backed dynamic topology without
pulling in real Artifacts or bundling machinery.

## The admin Root ITX — the platform plane

`RootItx` (`src/itx/root.ts`) is **not** a context and **not** a Durable Object: a
tiny fixed RPC surface served at `/api/itx`, constructed per connection at the
edge and run through the same `pathInvokerToProxy` rule, so
`root.projects.list()` and `root.streams.get("/x").append({ event })` collapse to one
`invokeCapability` just like a context's dotted calls.

It exists because `__null__` (the platform projectId) holds streams that belong
to no project — integration webhooks, the project catalog. Those are deliberately
NOT a connectable context (`/api/itx/__null__` is refused and nothing
can connect into `__null__` from a project). The only door is here, and it is safe
with no authority logic of its own:

- **admin-only** — the edge serves it only to a principal whose `access` is
  `"all"` (`auth.ts`); a non-admin gets `403`.
- **no provide, no address resolver** — the surface is exactly `projects` and
  `streams`, so there is nothing to inject a capability into and no caller-supplied
  name to resolve.
- **streams pre-scoped** — the caller passes a `path` only; the projectId is
  hardcoded to `__null__`, so a caller cannot pivot to another project's streams
  (names are built from the scope the root already owns).

Adding a sibling surface (`users`, `orgs`) is just another branch in
`invokeCapability`.

## Codemode — a capability that is a program

`runScript({ code })` is a command submission API. It appends
`script-execution-requested`, waits for the matching
`script-execution-completed`, and then either returns the result plus the
completed event or throws using the completed event's error. `POST
/api/itx/<projectId>` is the HTTP form of that same control.

The execution side effect lives in `ItxProcessor.processEvent`, not in the host
Durable Object. When the processor observes `script-execution-requested`, it
constructs the exact wrapper source, turns it into an inline
`DynamicWorkerRef`, and runs it through the same `DynamicWorkersRpcTarget.get`
path as every other dynamic worker:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

const fn = /* inserted script */;

export class ScriptEntrypoint extends WorkerEntrypoint {
  async run() {
    return await fn(await this.env.ITX.get());
  }
}
```

The script discovers the current context through `env.ITX.get()`, exactly like
repo-backed dynamic workers do. The processor records pending script executions
as reduced state if it needs an idempotence marker, and removes that pending
entry when `script-execution-completed` is reduced. There is no separate
in-memory script history; the stream events are the durable record.

## Auth — one decision, at the connect door

The entire model is one line: you are either an **admin** (`access: "all"`, may
reach any project) **or** you hold a **list of project ids** and may reach
exactly those. `access` is the same `"all" | string[]` shape apps/os
linearizes a principal to (`accessForPrincipal`). There is no per-capability
gating anywhere downstream — once the connect door (`auth.ts`
`authorizeProjectAccess`) lets you into a project, everything inside is confined
BY CONSTRUCTION:

- built-ins are host-owned runtime targets scoped to that project;
- agents reach their project through an explicit host-owned `project` member;
- user provides cannot name host topology; public durable addresses are dynamic
  worker/facet descriptions only.

So authority lives at the door and nowhere else. The Root ITX (`/api/itx`) uses
the same `authenticate` and additionally requires `access === "all"`.

## The serving edge

The route uses Cap'n Web's Worker helper directly:
`newWorkersRpcResponse(request, target)`.

Every target is `pathInvokerToProxy({ invokeCapability })`. `/api/itx`
serves the admin Root ITX. `/api/itx/<projectId>` serves the project context by
forwarding into `ProjectDurableObject.invokeCapability`. There is no public agent connect
endpoint: a caller gets an agent through `project.agents.get("/agents/name")`
and then calls it directly. Do not pass a raw Durable Object stub straight to
`pathInvokerToProxy`: DO stubs make arbitrary properties look callable,
which is precisely the ambiguity this proxy avoids.

## Files

| File                                        | What                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/itx/processor-contract.ts`             | the itx event log: event schemas + reduced state (`defineProcessorContract`)                                                                                   |
| `src/itx/processor.ts`                      | `ItxProcessor extends StreamProcessor` (the fold + verbs + bridge), the common vocabulary (`replayPath`, `retain`, prefix matching), the `ItxContext` protocol |
| `src/itx/root.ts`                           | `RootItx` — the admin-only platform root (`/api/itx`): the project catalog + `__null__` streams, pre-scoped; no provide, no address resolver                   |
| `src/itx/path-invoker.ts`                   | `objectToPathInvoker` and `pathInvokerToProxy`, the inverse adapters between explicit object surfaces and path invocation                                      |
| `src/domains/dynamic-workers/`              | `DynamicWorkersRpcTarget`, `DynamicWorkerRef` source resolution, Worker Loader calls, and Durable Object facet resolution                                      |
| `src/domains/durable-object-names.ts`       | the one place `{projectId}:{path}` names are formatted/parsed; `PLATFORM_PROJECT_ID` (`__null__`)                                                              |
| `src/auth.ts`                               | the connect-door access model (`"all" \| string[]`) — the single authority decision                                                                            |
| `src/worker.ts`                             | the Worker route and exports for Project/Agent/Repo DOs, `ItxEntrypoint`, and the real `Stream` DO                                                             |
| `src/client.ts`                             | `withItx` + `connect` — socket opener, naked path calls, and provide-time normalization for raw local SDK objects                                              |
| `cli.ts`                                    | a tiny command-line itx runner — the matrix's process-boundary runtime                                                                                         |
| `e2e-env.ts`                                | which running worker to talk to + which demo principal to authenticate as (the suite never starts a server; mirrors apps/os)                                   |
| `src/examples/examples.ts`                  | the catalogue: pure-data script bodies (`itx` + `vars` in scope, explicit `return`) the matrix runs across every runtime                                       |
| `src/examples/example-cases.ts`             | test-only setup + `vars` + assertions per catalogue entry (so `examples.ts` stays pure data, and examples can't silently rot)                                  |
| `example-matrix.ts`                         | runs a catalogue body through every server-side runtime (node, cli, post-script, dynamic-worker)                                                               |
| `itx-scripts.ts`                            | reusable dynamic capability sources used by the tests (dynamic workers, repo-backed DO facets, …)                                                              |
| `itx.e2e.test.ts`                           | the node vitest project: every core concept, then the catalogue matrix across server runtimes                                                                  |
| `itx.cross-project-adversarial.e2e.test.ts` | the cross-project isolation attacks (host-topology address rejection, connect-door denial, `__null__` refusal)                                                 |
| `itx.root.e2e.test.ts`                      | the admin Root ITX: project catalog + `__null__` stream read/write as admin; non-admin refused                                                                 |
| `itx.browser.test.ts`                       | the browser vitest project: the catalogue in a real Chromium tab (token-in-query auth)                                                                         |
| `vitest.config.ts`                          | the two-project (node + browser) config                                                                                                                        |

## What this deliberately omits

The capability model is complete; the surface is trimmed. No incremental "steps"
(this is the end state), no Swift/native-dialog or real-SDK demos, no
durability/replay proofs baked into the implementation (that the table is the
fold of the log is StreamProcessor's contract, not ours to re-prove). The
read-your-writes wait uses the StreamProcessor delivered-offset await; no
local polling loop is needed.
