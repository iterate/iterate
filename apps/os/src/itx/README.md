# itx — the iterate context

> **Status: historical design record (pre-migration).** This document
> describes the PRE-itx-v4 itx kernel, which was deleted in the itx-v4
> replacement (`apps/os/ITX_V4_MIGRATION_REPORT.md`) — most files it names
> (`itx.ts`, `handle.ts`, `dial.ts`, `fetch.ts`, `platform-context.ts`, …)
> no longer exist. It is kept because it explains the design lineage the
> current engine inherits (describe(), instructions/types, capabilities as
> stream events). **The current engine lives at `apps/os/src/`**
> (`README.md` + `types.ts`). What actually remains in THIS folder is the
> client-side surface: `itx-react.tsx` (browser hooks), `browser-repl.ts`
> (REPL compiler), `path-proxy.ts`, `examples.ts` (the example catalogue),
> and `e2e/` (the cross-runtime example matrix).

You are handed an `itx`. In the REPL, inside an agent, in a project worker,
from `withItx()` on your laptop — it is always the same object: a handle on a
**context**, a node that holds named capabilities. Three scenes cover almost
everything you will ever do with one. The mechanics — streams, fold, dial,
chain, addresses — are an appendix, because you don't need them to act.

## Scene 1: use a capability

```ts
// What am I holding? What can I call?
await itx.describe();
// → { context: "prj_…:/", access: ["prj_…"],
//     capabilities: [{ name: "slack", kind: "rpc", instructions: "Use
//       itx.slack.<Slack Web API method path>(args), e.g.
//       itx.slack.chat.postMessage({ channel, thread_ts, text })…" }, …],
//     project: { … } }

await itx.slack.chat.postMessage({ channel: "C123", text: "hi" });
```

`itx.slack` works because someone provided `"slack"` on this context (or on a
parent — lookup climbs the chain), not because itx knows about Slack. Unknown
property names fall through to the context's capability table; dots accumulate
locally and the terminal call dispatches once. `describe()` is the runtime
truth: every capability carries the `instructions` (and optionally `types`)
its provider attached, so the answer to "what can this context do?" is always
one call away — for you, and for any agent handed the same `itx`.

## Scene 2: offer a capability from your laptop

```ts
import { withItx } from "~/itx/itx-client.ts";

using itx = withItx({ baseUrl, token, context: "my-project" });

await itx.provideCapability({
  name: "runSwiftOnMyMac",
  instructions: "Compile-and-run Swift on Jonas's Mac. Pass the source string.",
  capability: async (src) => runSwift(src),
});
```

That's the whole thing. While your process stays connected, every agent,
REPL, and script in the project can call `itx.runSwiftOnMyMac(src)` — the
call travels back over YOUR connection and runs in YOUR process. A bare
function is the simplest provider; live capabilities are session-bound (gone
when the socket drops, back when you reconnect and provide again). The
`instructions` you attach are what everyone else's `describe()` will say —
write them for the stranger who finds your capability there.

## Scene 3: override one method

```ts
const session = await itx.extend({ name: "review-run" }); // or { path: "/runs/42" }

await session.provideCapability({
  path: ["workspace", "gitPush"],
  instructions: "gitPush waits for human approval; everything else is the real workspace.",
  capability: approvalGate, // async (input) => { await approve(input); return itx.workspace.gitPush(input); }
});
```

`extend()` mints a cheap child context — itself a stream coordinate: a path
you choose, or a generated `/itx/<id>` catch-all (extending an existing path
is get-or-create). The shadow lives at a PATH:
`session.workspace.gitPush(...)` hits the gate, while
`session.workspace.readFile(...)` misses the child's table and falls through
the chain to the inherited workspace — prototype semantics, per method.
`session.super` is the handle on the unshadowed parent — the middleware
"call next()": a `fetch` shadow delegates to the real pipe via
`itx.super.fetch(request)`. Revoke the shadow and the inherited entry
resurfaces. Hand `session` to the thing you don't fully trust; keep `itx`.

The review question for any of this is always the same: **what does
`describe()` say?** A context is exactly the sum of what its chain describes.

---

Everything below is the appendix: how the above actually works, in build
order. Design history: `apps/os/docs/itx-next.md` (the arc) and `DECISIONS.md`
(what changed on contact with reality). The agent-facing surface is
`types.ts` — handwritten, import-free, the design of record the
implementation conforms to.

## The Laws

These invariants ARE the architecture. Every file here serves one of them.

1. **The stream holds the facts. The node holds live refs. Code holds
   composition.** A context IS a stream coordinate; its durable state is a
   fold of that stream; live stubs are runtime-only and rebuilt by
   reconnection; wiring capabilities together is always plain code, never
   data interpreted by the platform.
2. **Props carry identity, never composition or authority-by-content.**
   `ItxProps = { context, access?, capabilityPath? }` — the ref IS the
   coordinate; address and owning project are projections of it.
3. **Auth happens at connect, nowhere else.** Credentials become a handle
   once, at the edge (`fetch.ts`). No code holding an itx ever checks scopes;
   _which context your handle points at_ is the authority.
4. **Narrowing is construction.** `itx.projects.get()` and `itx.extend()`
   return new handles on narrower contexts — never flags on wider ones.
5. **All policy-governed egress flows through one pipe.** Loaded isolates get
   it as global `fetch` (`globalOutbound = ProjectEgress`); everyone else
   calls `itx.fetch()`. Secret placeholders are substituted in the stateless
   terminal pipe and never exist anywhere else.
6. **One calling convention.** The core dispatches every capability as
   `target.call({ path, args })`. The members/path-call choice lives at the
   EDGES, never in stored data.
7. **Cap'n Web terminates in the stateless worker, never in a DO.** The DOs
   speak plain Workers RPC — Kenton's stated hibernation architecture
   (capnweb#36 / workerd#6087), so hibernatable RPC arrives for free.

## ① Dots become data: `PathCall` and `PathProxy` (`path-proxy.ts`)

Everything starts with one wire shape:

```ts
type PathCall = { path: string[]; args: unknown[] }; // itx.slack.chat.postMessage(x)
// ⇢ { path: ["slack","chat","postMessage"], args: [x] }
```

**`PathProxy`** is the consumer-side half: a callable JS Proxy where property
access accumulates a path locally (zero round trips, `then` reads undefined
so `await` never misfires mid-chain) and the terminal call fires once with
the accumulated `PathCall`. **`RESERVED_PATH_SEGMENTS`** is the one list of
names that may never traverse a dynamic surface (prototype-pollution vectors,
stub controls like `dup`/`then`/`constructor`).

Note for the curious: there are TWO composing pipelining systems in play.
This one flattens dotted NAMES into data before anything touches the network;
the RPC transports (capnweb, Workers RPC) separately pipeline CALLS onto
returned stubs. They compose — `itx.streams.get("/x").append(e)` is one
PathCall producing a stub the transport then pipelines `append` onto.

## ② Data becomes dots again: `replayPathCall`

**`replayPathCall(target, { path, args })`** is the receiver-preserving
replay: walk the segments on a concrete object (re-filtering reserved names —
this is the authoritative gate, since `invoke` is public and paths can be
hand-built) and call the terminal method ON ITS PARENT. An empty path calls
`target` itself as a function.

There is deliberately NO callsite wrapper to pair with it: a plain object
(or bare function) IS a live capability — the core's dispatch notices a
target that doesn't implement `call` and replays the path onto its members
itself (③). The replay still runs where the object lives (your functions
cross the session as stubs), so providing `{ run(src) { … } }` means `run`
executes in YOUR process.

That is Law 6 in full: the core only ever says `target.call({ path, args })`;
whoever holds the concrete object decides what a path means there — and "I'm
just an object of methods" is the default, not a wrapper.

## ③ The core: `Itx` — one map, longest prefix, a chain (`itx.ts`)

A **context** is, behaviorally, a prototype-chain object whose properties are
capabilities. **`Itx`** is the class that implements one link of that chain.
Its state is ONE path-keyed capability table; its protocol is four verbs
(**`provideCapability`**, **`revokeCapability`**, **`describe`**,
**`invoke`** — together the **`ItxStub`** shape, "the context protocol"):

- **Entries live at PATHS.** `provideCapability({ name })` is the 1-segment
  sugar; `provideCapability({ path: ["slack","chat","postMessage"], … })`
  shadows ONE subtree of an inherited capability (Scene 3). `invoke` resolves
  the **longest provided prefix** of the call path
  (`resolveLongestProvidedPrefix`, pure and module-level) and dispatches the
  REMAINDER as the `PathCall`.
- **A miss delegates the WHOLE path to `parentItx`** — a stub of the parent
  context's core. Shadowing, revoke-resurfaces-the-inherited-entry, and
  deploy-updated defaults are all consequences of this chain, not rules.
- **Delegation carries `ItxOrigin`** (`{ id, address }` of the context the
  call STARTED at), set by delegating nodes, never by handles. It is the
  chain's trusted identity channel: attribution, and — crucially — dial-back
  (⑤).
- **What can be provided** (`Capability`): a serializable
  **`CapabilityAddress`** (durable), or anything live — a **plain object of
  methods** (dispatch replays the dotted path onto its members; nested
  objects give depth for free), a **bare function** (calling the capability
  calls the function), or a stub implementing `call` itself (own your whole
  method tree). Discrimination is structural
  (`isCapabilityAddress`): an address is a PLAIN object carrying
  `type: "rpc"`; everything else is live. Live stubs sit in an
  in-memory instance table, dup-retained, torn down with the provider's
  session.
- **Every entry is self-describing.** `instructions` (prose for whoever calls
  `describe()`) and `types` (a TypeScript declaration for machines and
  editors) ride with the provide, are recorded with it, and come back from
  `describe()` on every handle down the chain.
- **Provide is structural validation only** (`assertValidCapabilityPath`,
  address well-formedness). Reachability is the dial's authority (④) and
  surfaces at first call.

`provideCapability` returns a provision handle `{ revoke(),
[Symbol.dispose] }`; dispose auto-revokes ONLY live provides (a durable
provide must outlive the session that created it — session teardown disposes
every returned handle, so a revoking disposer would silently undo it).

## ④ Targets as data: `CapabilityAddress` and the dial (`dial.ts`)

The system has ONE serializable data structure — the address — and
everything is a use of it. "How do I obtain an RPC surface?" has exactly
these answers:

```ts
type CapabilityAddress = { type: "rpc"; worker: WorkerRef; entrypoint?; props? };

type WorkerRef =
  | { type: "binding"; binding } // anything on env: env.AI, a service binding
  | { type: "loopback" } // this worker's own exports (first-party code)
  | { type: "durable-object"; binding; name } // dialed as itx:<projectId>:<name>
  | { type: "source"; source }; // a dynamic worker from stored source
```

**`makeDial(host)`** is THE one effect injected into the core: address →
something speaking `call({ path, args })`. It owns REACH — the
`DialableTargets` allowlists (config can only widen) — and injects the
attribution props `{ capabilityPath, context, projectId }` that dialable
loopback entrypoints scope by (a provider can never point one at someone
else's project). Per worker-ref kind: bindings and loader entrypoints get
wrapped in-process with the ② replay; loopbacks self-replay via their own
`call`; `source` refs materialize an isolate via the Worker Loader — wired
by `wireIsolateEnv` (`isolate.ts`) with `env.ITERATE` (an itx scoped to the
ORIGIN context) and `globalOutbound = ProjectEgress` (Law 5) — and
`exportType: "durable-object"` sources become **facets** of the hosting DO
with their own private SQLite.

Because the isolate is wired to the ORIGIN, an inherited source capability's
bare `fetch()` climbs the INVOKING context's chain — origin dial-back: shadow
`fetch` on your extension and an inherited capability's outbound traffic
lands in your shadow, while siblings and the parent are untouched.

Context nodes are addressed the same way: the REF is the ItxDurableObject's
name, so `contextAddress(ref)` (`coordinates.ts`) is a pure projection;
`dialContext` is the kernel restore, deliberately not allowlist-gated
because only kernel code writes context refs.

## ⑤ The context's stream: events are the only writes (`contract.ts`, `coordinates.ts`)

`Itx extends StreamProcessor` (packages/streams). **A context IS a stream
coordinate** — `{ projectId, path }`, written as the REF `<projectId>:<path>`
— and that stream is the ONLY authority:

- **Identity is the coordinate.** The project context is the project's root
  stream (`prj_x:/`); deployment-wide contexts use `__null__:/...`;
  an agent's context is the agent's own stream (`prj_x:/agents/…`);
  anonymous extends default to `/itx/<generated>` — a plain convention, not
  a reserved segment (any stream path can be a context). There are NO context
  ids and no directory: ref, stream, and node address are one string.
- **Creation is two idempotent appends by the CREATOR**
  (`createContext`, `coordinates.ts`): a `subscription-configured` event
  pointing the stream at the node's `itx` processor, then
  `context-created { name, parent: { ref, address } }` — the **birth
  certificate**. The generic host derives nothing; parentage comes from the
  event. The fold takes the first certificate and ignores any later one, so
  creation is get-or-create (exactly-once as a property of the fold, not of
  delivery — the standing doctrine,
  `docs/domain-objects-and-stream-processors.md`).
- `provideCapability` APPENDS `events.iterate.com/itx/capability-provided`
  (path-keyed payload: path, kind, full address, meta — which carries
  `instructions`/`types` — and owner) and then SELF-INGESTS through the one
  consumption door — read from the checkpoint, fold forward.
  Read-your-writes with no waiting machinery; duplicate delivery is inert by
  offset bookkeeping. `capability-revoked` and `capability-disconnected`
  (session teardown) work the same way. A LIVE provide appends the EVENT —
  the record outlives the session — while the stub stays an instance field;
  replay marks the entry disconnected.
- **`reduceItxEvent`** (pure, module-level) is the fold; the
  **`ItxContract`** (`contract.ts`) is the event vocabulary and state shape.
  The processor checkpoint (in the host DO's storage) is a disposable cache
  of the fold — delete it and replay rebuilds it. itx events interleave
  freely with whatever else lives on the stream (an agent's conversation,
  a session's record): the fold ignores foreign types.
- **Scripts ride the same stream.** The synchronous door (`run.ts`,
  `POST /api/itx/run`) records `script-execution-requested` /
  `script-execution-completed` around an inline run. Appending a requested
  event with `enqueued: true` IS requesting work: the context's own
  processor runs it (`Itx.processEventBatch` → the host's runner) and
  appends the completed event — at-least-once reruns stay detectable via the
  requested/completed pair, and already-completed pairs are inert.

## ⑥ The host: ItxDurableObject, and nothing else

**One host.** `ItxDurableObject` (`itx-durable-object.ts`) hosts EVERY
context — project, agent, extension. It holds NO configuration:
its DO **name IS the ref**, so identity, stream, and self-address are
projections of the name; parentage folds from the birth certificate;
`descriptor()` derives from state. It registers its `Itx` as the `itx`
processor on a stream-processor host, so the context's stream pushes batches
to it through the subscription its creator configured; `itx()` returns the
core (a method, not a property — workerd does not pipeline calls through
property accesses, so `node.itx().invoke(…)` stays one round trip).

Creators: `projects.create` appends the project context's creation events
onto the root stream (parent: the platform defaults); the agent DO appends
its own onto the agent stream (parent: the project context); `extend()`
appends onto the chosen child path. The Project and Agent DOs keep their
DOMAIN work — processors, creation orchestration, tool provides — but host
no capability core.

Workspaces are deliberately NOT the kernel's concern: `WorkspaceCapability`
takes an explicit provider-chosen `workspaceId`. The defaults provide the
shared project workspace; the AGENT (as creator) provides its context its
own `workspace` capability bound to the context's ref. Plain extensions
share the project workspace through the chain.

## ⑦ The handle: the one thing user code touches (`handle.ts`)

**`ItxHandle`** is a cheap, ephemeral VIEW over a context node — identical in
the browser, Node, the REPL, the project worker, itx scripts, and
capabilities themselves. Anatomy: the typed trust kernel — the four verbs
plus **`extend`** (mint a child context: ④'s address + ⑤'s birth
certificate + a handle), **`super`** (a path-proxied handle on the parent
context — the "call next()" of middleware: a `fetch` shadow delegates to the
unshadowed pipe via `itx.super.fetch(request)`), `streams`, `project`,
`projects`, `fetch`, `describe`, `capability(name)` — and a
fallthrough Proxy: any unknown name becomes a `PathProxy` (①) whose terminal
call is one `invoke` on the node's core (Scene 1).

One papercut, priced and accepted: `super` is a reserved word, so
`itx.super` works but `const { super } = itx` does not — destructure
everything else, dot the parent.

Handles are minted in exactly three ways (Law 3/4):

- **connect** (`fetch.ts`): `/api/itx[/:ref]` — credentials → access →
  handle, Cap'n Web terminating in the stateless worker (Law 7). The
  **restorer** (`resolveItx`, `entrypoint.ts`) turns serializable `ItxProps`
  into the live handle; `ItxEntrypoint` is the same restorer bound as
  `env.ITERATE` inside every platform-loaded isolate.
- **narrowing**: `itx.projects.get(…)` (the access check) and `itx.extend()`.
- **platform wiring**: `wireIsolateEnv` hands isolates a handle scoped to
  their home context, with `capabilityPath` as pure attribution.

Client plumbing: `client.ts` (`withItx` for Node, Scene 2), `itx-react.tsx`
(the whole browser React surface), `browser-repl.ts` (REPL compiler), `errors.ts`
(`ItxError` codes that survive capnweb's name-dropping reconstruction, plus
existence-masking — missing and forbidden are byte-identical NOT_FOUND).

## ⑧ The defaults: a parent written in code (`platform-context.ts`)

Every chain roots in code: **everything WRITABLE is durable; the root of
every chain is code.**

```text
prj_x:/itx/a1b2 → prj_x:/ → platform:project (PlatformContext, read-only code)
```

**`PlatformContext`** is a loopback `WorkerEntrypoint` answering the same
context protocol as every node — `describe`/`invoke` from
`PLATFORM_PROJECT_CAPABILITIES` (ai, fetch, streams, repos, workspace,
worker — each with its own instructions, so even the code-rooted defaults
self-describe), `provide`/`revoke` refused — addressed
`{ type: "rpc", worker: { type: "loopback" }, entrypoint: "PlatformContext" }`
and dialed in-process, so default dispatch pays no DO hop. The `worker`
capability is the project's own code: the worker built from the project's
repo (slug `project`). Shipping a new default is a deploy, not a migration:
the chain sees it immediately; recorded rows shadow it; revoking a shadow
resurfaces it. There is no defaults mechanism — only the chain.

Egress, both doors — `fetch` is itself a shadowable default:

```text
bare fetch() in ANY loaded isolate ─► ProjectEgress.fetch (origin's node) ─┐
                                                                           ├─► "fetch" via the chain
itx.fetch(...) from ANY handle ────────────────────────────────────────────┘     │
     shadow provided on the origin's chain? ─► the shadow (placeholders UNsubstituted)
     default ─► EgressPipe.call (stateless terminal: secret substitution + the real fetch)
```

HTTP routing to capabilities: `https://{cap}--{project}.{base}/…` →
`ItxCapabilityIngress` (`http.ts`): 404 unless `meta.http.expose`; exposed
caps are public; then one core dispatch with `[...capabilityPath, "fetch"]`.

## Files

| File                    | Role                  | Owns                                                                                                                                                                                                                       |
| ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `itx.ts`                | THE CORE              | `Itx` (the four verbs, stream write/consume seam, live table, longest-prefix dispatch, chain), capability data model, validation                                                                                           |
| `contract.ts`           | the stream contract   | `ItxContract`, `ITX_EVENT_TYPES`, `ItxState` (zod schemas — deliberately loose so old streams never wedge the fold)                                                                                                        |
| `path-proxy.ts`         | Law 6, client-safe    | `PathProxy`, `replayPathCall`, `RESERVED_PATH_SEGMENTS`                                                                                                                                                                    |
| `coordinates.ts`        | the coordinate system | refs (`<namespace>:<path>`), context addresses, `dialContext`, `createContext` (subscription + birth certificate)                                                                                                          |
| `dial.ts`               | reach                 | `makeDial` (allowlists, loader/facet wiring, prop injection), `durableObjectFacetsHook`, `resolveDialableTargets`                                                                                                          |
| `platform-context.ts`   | the chain root        | `PlatformContext` (read-only code context), `PLATFORM_PROJECT_CAPABILITIES`, `getPlatformContext`                                                                                                                          |
| `itx-durable-object.ts` | THE host              | `ItxDurableObject`: name = ref, the `itx` processor + subscription, descriptor from state, `itx()`                                                                                                                         |
| `handle.ts`             | the handle            | `ItxHandle` + built-ins, `CapabilityProvision`, the bare-function probe/wrap, `ItxProjects`                                                                                                                                |
| `entrypoint.ts`         | restorer + egress     | `resolveItx`, `ItxEntrypoint` (env.ITERATE), `ProjectEgress` (globalOutbound), `EgressPipe`, `BindingCapability`                                                                                                           |
| `isolate.ts`            | isolate wiring        | `wireIsolateEnv` — the one trust posture for every platform-loaded isolate                                                                                                                                                 |
| `run.ts`                | the script runner     | `runItxScript`: loader isolate + the two-event record on the context's stream                                                                                                                                              |
| `fetch.ts`              | connect + run         | `/api/itx[/:ref]`, `/api/itx/run`, project-host `/__itx`                                                                                                                                                                   |
| `access.ts`             | connect-time access   | `accessForPrincipal`, `resolveAccessibleContextRef`                                                                                                                                                                        |
| `http.ts`               | routable capabilities | hostname rule, `ItxCapabilityIngress`                                                                                                                                                                                      |
| `refs.ts`               | wire refs             | `ItxProps`, `ProjectAccess`, `GLOBAL_CONTEXT_ID`, `isChildContextId` (import-light)                                                                                                                                        |
| `types.ts`              | design of record      | the handwritten, import-free agent-facing surface (feeds the REPL editor)                                                                                                                                                  |
| `capabilities/`         | first-party targets   | `StreamsCapability`, `McpClient`                                                                                                                                                                                           |
| `client.ts`             | tier-3 clients        | `withItx` for Node                                                                                                                                                                                                         |
| `itx-react.tsx`         | the browser surface   | the whole React surface in one file — `useItx`/`connectItx` (get the handle), `useItxQuery` (read), `useItxEffect` (subscribe), `ItxProvider`/`reconnectItx`; one socket per context in a module Map, Suspense, never SSRs |
| `browser-repl.ts`       | dev tooling           | the REPL snippet compiler (not part of the kernel)                                                                                                                                                                         |
| `admin-auth-cookie.ts`  | test bridge           | browser-WebSocket admin auth (cookies, since WS can't set headers)                                                                                                                                                         |

Everything else in apps/os (oRPC, dashboard routes, domain entrypoints) sits
_on top of_ this layer or beside it — never underneath it.

## Writing capabilities

**Live** (session-bound — your laptop, a browser tab, another service; Scene
2). The capability IS the value you pass; `provideCapability` discriminates
structurally. A bare function is the simplest provider (calling the
capability calls it); a plain object of methods is the next step up — dotted
paths replay onto its members, in YOUR process, no wrapper anywhere; and an
object that implements `call({ path, args })` itself owns its whole method
tree (the SDK shape: the public SDK docs become the tool docs):

```ts
import { withItx } from "~/itx/itx-client.ts";

using itx = withItx({ baseUrl, token, context: "my-project" });
const provision = await itx.provideCapability({
  name: "runSwiftOnMyMac",
  instructions: "Compile-and-run Swift on Jonas's Mac.",
  capability: async (src) => runSwift(src),
});
// callable as itx.runSwiftOnMyMac(...) until this connection drops
// (or provision.revoke() — `using provision = …` revokes live provides)
```

**Durable, stateless.** Source capabilities are member-shaped: the dial wraps
the loader entrypoint and replays the dotted path on its real members — just
export methods, no method list anywhere. `types` is the machine-facing
counterpart of `instructions`:

```ts
await itx.provideCapability({
  name: "slack",
  instructions: "Post to the team Slack: itx.slack.postToChannel({ channel, text }).",
  types:
    "declare function postToChannel(input: { channel: string; text: string }): Promise<unknown>;",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey,
        mainModule: "cap.js",
        modules: {
          "cap.js": `
      import { WorkerEntrypoint } from "cloudflare:workers";
      export default class extends WorkerEntrypoint {
        async postToChannel({ channel, text }) {
          // bare fetch() here IS project egress: the Slack token lives in
          // project secrets and is substituted server-side (Law 5)
          return await (await fetch("https://slack.com/api/chat.postMessage", {
            body: JSON.stringify({ channel, text }),
            headers: { authorization: 'Bearer getSecret({ path: "/secrets/slack-token" })',
                       "content-type": "application/json" },
            method: "POST",
          })).json();
        }
      }
    `,
        },
      },
    },
  },
});

await itx.slack.postToChannel({ channel: "C123", text: "hi" });
```

**Durable + stateful** — `exportType: "durable-object"`: a **named** export
extending `DurableObject` (D12), instantiated as a facet of the hosting
context node with its own private SQLite, zero provisioning:

```ts
await itx.provideCapability({
  name: "todo",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey,
        entrypoint: "Todo",
        exportType: "durable-object",
        mainModule: "cap.js",
        modules: {
          "cap.js": `
      import { DurableObject } from "cloudflare:workers";
      export class Todo extends DurableObject {
        async add({ text }) { /* this.ctx.storage is YOURS alone */ }
      }
    `,
        },
      },
    },
  },
});
```

**Typed capabilities**: there is no static name table — `itx.<name>` falls
through a runtime Proxy, so TypeScript only knows the built-ins. Cast a
stub through `Stubify` (from `types.ts`) to borrow an SDK's types:

```ts
import type { Stubify } from "~/itx/types.ts";
const slack = itx.capability("slack") as Stubify<import("@slack/web-api").WebClient>;
await slack.chat.postMessage({ channel, text });
```

## Execution modes (all proven in `e2e/`)

| Mode               | How the handle arrives                                      |
| ------------------ | ----------------------------------------------------------- |
| Node / laptop      | `withItx()` → capnweb WebSocket → `/api/itx`                |
| browser            | same endpoint; REPL routes put `itx` in scope               |
| itx script         | `POST /api/itx/run` → loader isolate, `env.ITERATE.context` |
| project worker     | Project DO loads it with a project-scoped `env.ITERATE`     |
| source / facet cap | the dial loads it with an ORIGIN-scoped `env.ITERATE`       |

The e2e suite (`src/itx/e2e/`, runnable against any deployment) covers the
five-step live→durable capability flow, the stream as the record, egress
through both doors with real secret substitution, the two locked acceptance
tests (middleware via a bare-function `fetch` shadow + `itx.super`;
indirection via origin dial-back), extend/shadow/chain, the host-provided
workspace semantics, facet state, and HTTP routing (exposed caps are public;
unexposed caps 404).

## What deliberately does not exist

- **No mounts, no scopes, no composition-as-data.** Wiring is code; only
  overrides are data (recorded rows).
- **No capability table outside the context's stream.** The old SQLite
  registry and the fire-and-forget "audit" appends are gone; an audit log is
  not a concept — events are the writes, state is their fold.
- **No context ids, no directory.** Identity is the coordinate; the
  `itx_contexts` D1 catalog died with the ids.
- **No reserved stream segments.** `/itx/` is a naming convention for
  anonymous extends, nothing more.
- **No name index for chain resolution** — misses delegate upward per call
  (D2; add a cache only when latency data demands it).
- **No durable delivery on live stubs.** Offline means offline; durability
  is an address or the context's stream.
- **No heap persistence** for REPL/session state — replay from streams.
- **No verb-level permission data.** Narrower authority = a narrower context
  or capability, by construction.
- **No global context node yet.** Global handles are connect-minted views;
  the locked direction makes `global` a named instance of the generic host
  when something needs to write on it.
