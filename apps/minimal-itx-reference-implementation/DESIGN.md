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
miss, resolution falls through via the reserved `itxParent` built-in, bottoming
out at the stateless **`__global__` root**.

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

Every context — `Itx` and `GlobalItx` alike — implements `ItxContext`:

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
no `list`); it returns the raw folded `capabilities`, the injected `builtins`,
including the reserved `itxParent` built-in when this context has one.

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

`ItxDurableObject.#dial` turns a durable capability address back into a callable,
dispatched on `address.type`:

- `{ type: "dynamic-worker", source, entrypoint, props }` → build + run a
  WorkerEntrypoint via the **Worker Loader**, cached by content hash
- `{ type: "dynamic-durable-object", source, className }` → load a Durable
  Object class and run it as a facet of the current `ItxDurableObject`
- `{ type: "durable-object", namespace, name, path? }` → a trusted
  namespace/name/path Durable Object ref, used for domain built-ins
- `{ type: "worker-entrypoint", entrypoint, props }` → a trusted loopback
  WorkerEntrypoint with props, used here for the reserved `itxParent` built-in

Provider code cannot provide `worker-entrypoint` addresses. They are trusted
host-created built-ins only.

## The chain — inheritance by late binding

A context with a parent is born with a reserved built-in mounted at path
`["itxParent"]`, backed by a sturdy `{ type: "worker-entrypoint", entrypoint:
"ItxEntrypoint", props: { projectId, path } }` address. `invokeCapability`
resolves own fold → built-ins, then on a miss retries through
`["itxParent", ...path]`. So implicit inheritance and explicit
`itx.itxParent.fetch(...)` use the same dial/replay machinery. A child **shadows**
its parent by late binding (re-resolved per call), never by copy.

Topology: an **agent** (`prj:<id>/agents/<name>`) gets an `itxParent` built-in
pointing to its **project** (`prj:<id>`); a project gets an `itxParent` built-in
pointing to the **`__global__` root**. Parentage is derived from the context
**coordinate** by the host, not folded from the log — nothing reads a folded
copy, so it isn't stored.

## Built-in capabilities — the domain objects

A context is born with capabilities defined by the **domain object** at its
coordinate. `ProjectDurableObject` offers `fetch` (its egress) and `repo`;
`AgentDurableObject` offers `whoami`. Contexts with a parent also get the
reserved `itxParent` built-in. Built-ins are handed to the
`ItxProcessor` constructor as an array of the same `ProvideArgs` shape a provide
uses, and the built-ins here are literal trusted Durable Object addresses such
as `{ type: "durable-object", namespace: "agent", name, path: ["whoami"] }`.
Own provides shadow a built-in at the same path; changing built-ins is a code
change, not a log rewrite.

`RepoDurableObject` is deliberately fake. It only exposes `counter.js`, a
hard-coded source file that exports both `CounterEntrypoint` and
`CounterDurableObject`. This proves the repo-backed dynamic topology without
pulling in real Artifacts or bundling machinery.

## The `__global__` root — stateless, read-only

`GlobalItx` (`global-itx.ts`) is the chain's `__global__` root: every project's
parent, itself parentless. It is the one context that is **not** a DO and **not**
a StreamProcessor — there is nothing to persist, so it is constructed in code per
connection and answers the same `ItxContext` protocol. The WebSocket route
serves it through the same `pathProxyToInvokeCapability` as DO-backed contexts,
so `projects`, `describe`, and every other terminal call use the same
`invokeCapability({ path, args })` rule. Two structural properties:

- **read-only** — `provideCapability` / `revokeCapability` throw; there is no log
  to append to, so "you cannot provide into the root" is structural.
- **no parent** — a miss has nowhere to climb and throws.

Its capabilities are a fixed `projects` catalog (`{ list, get }`), riding the
capability protocol so adding a sibling (`users`, `orgs`) is just another entry.

## Codemode — a capability that is a program

`POST /api/itx?...` loads an `async (itx) => ...` program as a worker via
`ItxDurableObject.runScript({ code })` (same Worker Loader as `dial`) and hands
it an **itx handle** so it can invoke and provide against the very context that
launched it. The run is bracketed by durable `script-execution-requested` /
`-completed` records — events the fold does **not** consume, demonstrating that
a log holds both state changes and plain audit records. `runScript` needs the
Worker Loader and is intentionally not part of the Cap'n Web ITX model.

## Auth — at the connect door

itx is unauthed **within** a connection (the reference dialer is not a policy
surface, and there is no per-capability gating).
The trust boundary is the WebSocket handshake (`auth.ts`): a bearer token names a
principal, the principal may reach a set of projects, and the server only
upgrades the socket if the requested context is in reach. The `__global__` root is not
project-scoped, so it only authenticates the principal and scopes the catalog to
that principal's reach.

## The serving edge

The route uses Cap'n Web's Worker helper directly:
`newWorkersRpcResponse(request, target)`.

Every WebSocket target is `pathProxyToInvokeCapability({ invokeCapability })`.
For project and agent contexts, that object forwards into the selected
`ItxDurableObject`; for `__global__`, it forwards into a `GlobalItx`. Do not
pass a raw Durable Object stub straight to `pathProxyToInvokeCapability`: DO
stubs make arbitrary properties look callable, which is precisely the ambiguity
this proxy avoids. The DO still exposes the itx verbs directly for Workers RPC
and POST. The durable processor is exposed as the `itx` getter for internal
Workers RPC use.

## Files

| File                  | What                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`         | the itx event log: event schemas + reduced state (`defineProcessorContract`)                                                                                                                  |
| `itx.ts`              | `ItxProcessor extends StreamProcessor` (the fold + verbs + bridge + chain), the shared vocabulary (`replayPath`, `retain`, prefix matching), the `ItxContext` protocol                        |
| `global-itx.ts`       | `GlobalItx` — the stateless, read-only root (`implements ItxContext`)                                                                                                                         |
| `auth.ts`             | the connect-door access map and checks                                                                                                                                                        |
| `server.ts`           | the Worker: `pathProxyToInvokeCapability`, `ItxDurableObject`, `ProjectDurableObject`/`AgentDurableObject`/`RepoDurableObject`, `dial`, the `/api/itx` route; re-exports the real `Stream` DO |
| `client.ts`           | `withItx` + `connect` — socket opener, naked path calls, and provide-time normalization for raw local SDK objects                                                                             |
| `cli.ts`              | a tiny command-line itx runner — the matrix's process-boundary runtime                                                                                                                        |
| `e2e-env.ts`          | which running worker to talk to + which demo principal to authenticate as (the suite never starts a server; mirrors apps/os)                                                                  |
| `examples.ts`         | the catalogue: pure-data script bodies (`itx` + `vars` in scope, explicit `return`) the matrix runs across every runtime                                                                      |
| `example-cases.ts`    | test-only setup + `vars` + assertions per catalogue entry (so `examples.ts` stays pure data, and examples can't silently rot)                                                                 |
| `example-matrix.ts`   | runs a catalogue body through every server-side runtime (node, cli, post-script, dynamic-worker)                                                                                              |
| `itx-scripts.ts`      | reusable sturdy capability sources shared by the tests (dynamic workers, repo-backed DO facets, …)                                                                                            |
| `itx.e2e.test.ts`     | the node vitest project: every core concept, then the catalogue matrix across server runtimes                                                                                                 |
| `itx.browser.test.ts` | the browser vitest project: the catalogue in a real Chromium tab (token-in-query auth)                                                                                                        |
| `vitest.config.ts`    | the two-project (node + browser) config                                                                                                                                                       |

## What this deliberately omits

The capability model is complete; the surface is trimmed. No incremental "steps"
(this is the end state), no Swift/native-dialog or real-SDK demos, no
durability/replay proofs baked into the implementation (that the table is the
fold of the log is StreamProcessor's contract, not ours to re-prove). The
read-your-writes wait uses the shared StreamProcessor delivered-offset await; no
local polling loop is needed.
