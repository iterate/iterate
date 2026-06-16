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
miss, resolution falls through to a parent context, bottoming out at a stateless
**global root**.

## Capabilities: live vs sturdy

One field discriminates, and it is not a `kind` enum — it is the `address`:

|            | `address`            | where the callable lives             | durable?                            |
| ---------- | -------------------- | ------------------------------------ | ----------------------------------- |
| **live**   | `null`               | the in-memory bridge beside the fold | no — dies with its provider/session |
| **sturdy** | `{ type: "rpc", … }` | rebuilt on demand by `dial`          | yes — the address is in the log     |

`CapabilityRecord` (`contract.ts`) is `{ path, address, instructions, types }`.
A live provide records `address: null` and stashes the real stub in the bridge;
a sturdy provide records the address and stashes nothing. `address === null` is
the entire test (`itx.ts`'s `isCapabilityAddress` / `addressOf`).

Paths are **arrays of segments** (`["slack", "chat", "postMessage"]`), matched
by **longest registered prefix** so a deep shadow beats a broad mount. There is
no dotted-string key anywhere in resolution.

## The four verbs (one calling convention)

Every context — `Itx` and `GlobalContext` alike — implements `ItxContext`:

```ts
provideCapability({ path, capability, instructions?, types? }) → { path }
invokeCapability({ path, args? })                              → unknown
revokeCapability({ path })                                     → void
describe()                                                     → DescribeResult
```

Every verb takes a **single bag-of-props** argument — the same shape on the
wire, in the bridge, up the chain, and inside codemode. Because there is one
convention, the serving edge never translates between shapes; it is a near-pure
pass-through. `describe()` is the only read verb (there is no `list`); it returns
the raw folded `capabilities`, the injected `builtins`, and the parent nested
under `parentCapabilities`.

## The naked stub — no client-side path proxy

The client holds a **bare Cap'n Web session stub**. Cap'n Web already turns
`stub.a.b.c(args)` into one pipelined message (the stub accumulates the path
locally, zero round trips). So `client.ts` is just a socket opener; there is no
consumer-side library.

The load-bearing piece is **server-side**: capabilities are registered at
runtime, so the served target can't be a fixed class. `dynamicHandle`
(`server.ts`) is a `Proxy` over a **function** that answers any name and, on the
terminal call, collapses the accumulated path into one
`invokeCapability({ path, args })`. Three requirements (each a real debugging
round) are encoded there: the target must be function-typed (Cap'n Web forbids
fabricated instance properties on rpc-targets), `getOwnPropertyDescriptor` must
answer (Cap'n Web does `Object.hasOwn` before reading), and `has` must answer for
non-reserved names. A `RESERVED` set blocks names that would derail it (`then`,
`__proto__`, …).

## dial — address → stub

`ItxDO.#dial` is the **one** function that turns a sturdy address back into a
callable, dispatched on `address.type`:

- `{ type: "context", ref }` → another context DO (`env.ITX.getByName(ref).itx()`)
- `{ type: "code", context: "global" }` → the global root, constructed inline
- `{ type: "rpc", worker: { type: "source", source }, entrypoint, props }` →
  build + run a worker via the **Worker Loader**, cached by content hash

The same `dial` serves both capability addresses and parent addresses — they are
the same operation. (Production splits this into a gated capability dial and an
ungated context dial for the auth boundary; here the boundary is the connect
door, so one dial. See _Auth_.)

## The chain — inheritance by late binding

A context is born with a **parent address** (host-injected). `invokeCapability`
resolves own fold → built-ins → parent, re-dispatching the whole path into the
parent's `invokeCapability` on a miss. So a child **shadows** a parent by late
binding (re-resolved per call), never by copy.

Topology (`ItxDO.#parentAddress`): an **agent** (`prj:<id>/agents/<name>`)
parents to its **project** (`prj:<id>`); a project parents to the **global
root**. Parentage is derived from the context **coordinate** by the host, not
folded from the log — nothing reads a folded copy, so it isn't stored.

## Built-in capabilities — the domain objects

A context is born with capabilities defined by the **domain object** at its
coordinate. `Project` (a DO) offers `fetch` (its egress); `Agent` (a DO) offers
`whoami`. Built-ins are handed to the `Itx` constructor as an array of the same
`ProvideArgs` shape a provide uses — a built-in is just a capability
pre-provided in code, not via an event. Own provides shadow a built-in at the
same path; changing built-ins is a code change, not a log rewrite.

## The global root — stateless, read-only

`GlobalContext` (`global-context.ts`) is the chain's root: every project's
parent, itself parentless. It is the one context that is **not** a DO and **not**
a StreamProcessor — there is nothing to persist, so it is constructed in code per
connection and answers the same `ItxContext` protocol. Two structural properties:

- **read-only** — `provideCapability` / `revokeCapability` throw; there is no log
  to append to, so "you cannot provide into the root" is structural.
- **no parent** — a miss has nowhere to climb and throws.

Its capabilities are a fixed `projects` catalog (`{ list, get }`), riding the
capability protocol so adding a sibling (`users`, `orgs`) is just another entry.

## Codemode — a capability that is a program

`ItxDO.runScript({ code })` loads an `async (itx) => …` program as a worker
(same Worker Loader as `dial`) and hands it an **itx handle** so it can invoke
and provide against the very context that launched it. The run is bracketed by
durable `script-execution-requested` / `-completed` records — events the fold
does **not** consume, demonstrating that a log holds both state changes and
plain audit records. `runScript` needs the Worker Loader (only a DO context has
it), so it is an optional callback on the serving edge, not part of `ItxContext`.

## Auth — at the connect door

itx is unauthed **within** a connection (one `dial`, no per-capability gating).
The trust boundary is the WebSocket handshake (`auth.ts`): a bearer token names a
principal, the principal may reach a set of projects, and the server only
upgrades the socket if the requested context is in reach. The global root is not
project-scoped, so it only authenticates the principal and scopes the catalog to
that principal's reach.

## The serving edge — one adapter

`ItxRpcEdge` (`server.ts`) is the local Cap'n Web `RpcTarget` the Worker serves.
It keeps the client↔Worker boundary pure Cap'n Web and the Worker↔context
boundary its own, and it `dup()`s a provided live stub at the edge (Cap'n Web
disposes argument stubs when a call returns). Because every verb is bag-of-props
on both sides, **one** edge serves both the DO-backed `Itx` and the
`GlobalContext` — there is no per-context-kind adapter.

## Files

| File                | What                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`       | the itx event log: event schemas + reduced state (`defineProcessorContract`)                                                                                  |
| `itx.ts`            | `Itx extends StreamProcessor` (the fold + verbs + bridge + chain), the shared vocabulary (`replayPath`, `retain`, prefix matching), the `ItxContext` protocol |
| `global-context.ts` | `GlobalContext` — the stateless, read-only root (a second `implements ItxContext`)                                                                            |
| `auth.ts`           | the connect-door access map and checks                                                                                                                        |
| `server.ts`         | the Worker: `dynamicHandle`, `ItxRpcEdge`, `ItxDO`, `Project`/`Agent` domain objects, `dial`, the `/itx` route; re-exports the real `Stream` DO               |
| `client.ts`         | `withItx` + `connect` — the naked-stub socket opener                                                                                                          |
| `harness.ts`        | the e2e test (run against `npm run dev`)                                                                                                                      |

## What this deliberately omits

The capability model is complete; the surface is trimmed. No incremental "steps"
(this is the end state), no Swift/native-dialog or real-SDK demos, no
durability/replay proofs baked into the implementation (that the table is the
fold of the log is StreamProcessor's contract, not ours to re-prove). The
read-your-writes wait in `Itx.#awaitDelivered` is a known spin-poll wart, flagged
in-code to be replaced once the streams engine exposes a delivered-to-offset
await.
