# itx — how the capability layer works, built up from zero

This directory is the **capability layer** of apps/os: the smallest possible
trust kernel through which every piece of user-adjacent code — browser, Node,
agents, the project worker, one-off scripts, capabilities themselves — talks
to the platform. This README tells the story in BUILD ORDER: each piece
exists because the previous one wasn't enough. Design history:
`apps/os/docs/itx-next.md` (the arc) and `DECISIONS.md` (what changed on
contact with reality). The agent-facing surface is `types.ts` — handwritten,
import-free, the design of record the implementation conforms to.

## The Laws

These invariants ARE the architecture. Every file here serves one of them.

1. **The journal holds the facts. The node holds live refs. Code holds
   composition.** A context's durable state is a fold of its event stream;
   live stubs are runtime-only and rebuilt by reconnection; wiring
   capabilities together is always plain code, never data interpreted by the
   platform.
2. **Props carry identity, never composition or authority-by-content.**
   `ItxProps = { context, contextAddress?, projectId?, access?,
capabilityPath? }` — sturdy refs plus attribution.
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

## ② Data becomes dots again: `replayPathCall` and `asPathCallable`

**`replayPathCall(target, { path, args })`** is the receiver-preserving
replay: walk the segments on a concrete object (re-filtering reserved names —
this is the authoritative gate, since `invoke` is public and paths can be
hand-built) and call the terminal method ON ITS PARENT. An empty path calls
`target` itself as a function. **`asPathCallable(obj)`** wraps a plain
object-of-methods (or bare function) so it speaks the one calling convention
from ① — as a capnweb `RpcTarget`, so a live provider's replay runs back in
the provider's own process.

That is Law 6 in full: the core only ever says `target.call({ path, args })`;
whoever holds the concrete object decides what a path means there.

## ③ The core: `Itx` — one map, longest prefix, a chain (`itx.ts`)

A **context** is, behaviorally, a prototype-chain object whose properties are
capabilities. **`Itx`** is the class that implements one link of that chain.
Its state is ONE path-keyed capability table; its protocol is four verbs
(**`provideCapability`**, **`revokeCapability`**, **`describe`**,
**`invoke`** — together the **`ItxStub`** shape, "the context protocol"):

- **Entries live at PATHS.** `provideCapability({ name })` is the 1-segment
  sugar; `provideCapability({ path: ["slack","chat","postMessage"], … })`
  shadows ONE subtree of an inherited capability. `invoke` resolves the
  **longest provided prefix** of the call path
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
  **`CapabilityAddress`** (durable), or anything live — a stub implementing
  `call` itself, an `asPathCallable` wrap, or a **bare function** (live by
  nature; auto-wrapped so calling the capability calls the function and any
  deeper path errors). Discrimination is structural
  (`isCapabilityAddress`): an address is a PLAIN object carrying
  `type: "rpc" | "url"`; everything else is live. Live stubs sit in an
  in-memory instance table, dup-retained, torn down with the provider's
  session.
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
type CapabilityAddress =
  | { type: "rpc"; worker: WorkerRef; entrypoint?; props? }
  | { type: "url"; url; headers? }; // a Cap'n Web server across the internet

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
with their own private SQLite; `url` refs cross to the stateless `UrlDial`
entrypoint (Law 7), which opens one WebSocket Cap'n Web session per call.

Because the isolate is wired to the ORIGIN, an inherited source capability's
bare `fetch()` climbs the INVOKING context's chain — origin dial-back: shadow
`fetch` on your extension and an inherited capability's outbound traffic
lands in your shadow, while siblings and the parent are untouched.

Context nodes are addressed the same way: an address whose worker ref is a
durable object IS "how to dial the node that owns this identity"
(`projectContextAddress`, `childContextAddress` in `journal.ts`;
`dialContext` is the kernel restore for them, deliberately not
allowlist-gated because only kernel code writes context addresses).

## ⑤ The journal: events are the only writes (`contract.ts`, `journal.ts`)

`Itx extends StreamProcessor` (packages/streams). Every context owns a
**journal** — an ordinary event stream — and the journal is the ONLY
authority:

- `provideCapability` APPENDS `events.iterate.com/itx/capability-provided`
  (path-keyed payload: path, kind, full address, meta, owner) and then
  SELF-INGESTS through the one consumption door — read from the checkpoint,
  fold forward. Read-your-writes with no waiting machinery; duplicate
  delivery is inert by offset bookkeeping. `capability-revoked` and
  `capability-disconnected` (session teardown) work the same way. A LIVE
  provide journals the EVENT — the record outlives the session — while the
  stub stays an instance field; replay marks the entry disconnected.
- **`reduceItxJournalEvent`** (pure, module-level) is the fold; the
  **`ItxContract`** (`contract.ts`) is the event vocabulary and state shape.
  The processor checkpoint (`{offset, state}` in the host DO's storage) is a
  disposable cache of the fold — delete it and replay rebuilds it. The
  record and the state cannot disagree, because events are the only writes.
- **Creation is an event.** `extendContext` (`journal.ts`) mints a `itx_…`
  id, appends `context-created { id, name, parent: { id, address } }` — the
  **birth certificate**, the journal's first event — and returns. Nothing
  touches the new node; it materializes lazily by consuming its journal, and
  the fold takes the first birth certificate and ignores any later one
  (exactly-once as a property of the fold, not of delivery — the standing
  doctrine, `docs/domain-objects-and-stream-processors.md`).
- **Identity is a stream coordinate.** Journals live at
  `<host base>/itx[/<child-id>]` in the project's namespace: the project
  context's own journal is `/itx`; extending the project gives
  `/itx/<itx_…>`; an agent's context lives at `<agentPath>/itx/<itx_…>`.
  `itx` is a RESERVED stream path segment — the user-facing append doors
  (`StreamsBackend`) refuse it with one clear error
  (`assertStreamPathDoesNotClaimItxSegment`); journals stay readable
  everywhere (they are ordinary streams; every stream viewer shows them).
- **Scripts ride the same journal.** The synchronous door (`run.ts`,
  `POST /api/itx/run`) records `script-execution-requested` /
  `script-execution-completed` around an inline run. Appending a requested
  event with `enqueued: true` IS requesting work: the context's own
  processor runs it (`Itx.processEventBatch` → the host's runner) and
  appends the completed event — at-least-once reruns stay detectable via the
  requested/completed pair, and already-completed pairs are inert.
- Bare `itx_…` refs (reconnects, `/api/itx/run`, isolate props) resolve to
  their coordinate through the **`itx_contexts` D1 catalog** — a directory
  in D1's sanctioned role (project directory / secrets / DO catalog), never
  the authority.

## ⑥ Hosts: where an Itx lives

A context is a Durable Object with a stream. Two hosts, one anatomy:

- **`ProjectDurableObject`** (domains/projects) hosts the PROJECT context:
  `itx()` returns its core (a method, not a property — workerd does not
  pipeline calls through property accesses, so `node.itx().invoke(…)` stays
  one round trip). Journal: `(projectId, "/itx")`. Its `parentItx` is the
  platform context (⑧).
- **`ItxDurableObject`** (`itx-durable-object.ts`) is the GENERIC host — one
  instance per extension. It holds NO configuration: its DO **name IS the
  journal coordinate** (`<namespace>:<journalPath>`), so identity, journal
  ref, and self-address are projections of the name (`journal.ts` parses
  them); parentage folds from the birth certificate; `descriptor()` derives
  from state. Agent and MCP-session contexts are ItxDurableObject instances
  whose journals nest under their host's base path. (Embedding the
  processor as a FACET of rich hosts is the recorded direction; agents keep
  their own context instances today.)

Workspaces are deliberately NOT the kernel's concern: `WorkspaceCapability`
takes an explicit provider-chosen `workspaceId`. The platform context
provides the shared project workspace; the AGENT host provides its own
`workspace` capability bound to its context's identity, on its context's
journal. Plain extensions share the project workspace through the chain.

## ⑦ The handle: the one thing user code touches (`handle.ts`)

**`ItxHandle`** is a cheap, ephemeral VIEW over a context node — identical in
the browser, Node, the REPL, the project worker, itx scripts, and
capabilities themselves. Anatomy: the typed trust kernel — the four verbs
plus **`extend`** (mint a child context: ④'s address + ⑤'s birth
certificate + a handle), **`parent`** (a path-proxied handle on the parent
context — the "call next()" of middleware: a `fetch` shadow delegates to the
unshadowed pipe via `itx.parent.fetch(request)`), `streams`, `project`,
`projects`, `fetch`, `describe`, `capability(name)`, `shareUrl` — and a
fallthrough Proxy: any unknown name becomes a `PathProxy` (①) whose terminal
call is one `invoke` on the node's core. `itx.slack` works because someone
provided `"slack"`, not because anything here knows about Slack.

Handles are minted in exactly three ways (Law 3/4):

- **connect** (`fetch.ts`): `/api/itx[/:ref]` — credentials → access →
  handle, Cap'n Web terminating in the stateless worker (Law 7). The
  **restorer** (`resolveItx`, `entrypoint.ts`) turns serializable `ItxProps`
  into the live handle; `ItxEntrypoint` is the same restorer bound as
  `env.ITERATE` inside every platform-loaded isolate.
- **narrowing**: `itx.projects.get(…)` (the access check) and `itx.extend()`.
- **platform wiring**: `wireIsolateEnv` hands isolates a handle scoped to
  their home context, with `capabilityPath` as pure attribution.

Client plumbing: `client.ts` (`withItx` for Node), `use-itx.ts` (the
browser hook), `browser-repl.ts` (REPL compiler), `errors.ts` (`ItxError`
codes that survive capnweb's name-dropping reconstruction, plus
existence-masking — missing and forbidden are byte-identical NOT_FOUND).

## ⑧ The platform chain: defaults are a parent written in code (`platform-context.ts`)

Every chain roots in code: **everything WRITABLE is durable; the root of
every chain is code.**

```text
itx_session → project → platform:project (PlatformContext, read-only code)
```

**`PlatformContext`** is a loopback `WorkerEntrypoint` answering the same
context protocol as every node — `describe`/`invoke` from
`PLATFORM_PROJECT_CAPABILITIES` (ai, fetch, streams, repos, workspace,
worker), `provide`/`revoke` refused — addressed
`{ type: "rpc", worker: { type: "loopback" }, entrypoint: "PlatformContext" }`
and dialed in-process, so default dispatch pays no DO hop. Shipping a new
default is a deploy, not a migration: the chain sees it immediately;
journaled rows shadow it; revoking a shadow resurfaces it. There is no
defaults mechanism — only the chain.

Egress, both doors — `fetch` is itself a shadowable platform default:

```text
bare fetch() in ANY loaded isolate ─► ProjectEgress.fetch (origin's node) ─┐
                                                                           ├─► "fetch" via the chain
itx.fetch(...) from ANY handle ────────────────────────────────────────────┘     │
     shadow provided on the origin's chain? ─► the shadow (placeholders UNsubstituted)
     default ─► EgressPipe.call (stateless terminal: secret substitution + the real fetch)
```

HTTP routing to capabilities: `https://{cap}--{project}.{base}/…` →
`ItxCapabilityIngress` (`http.ts`): 404 unless `meta.http.expose`; gate is
admin bearer | signed share URL (`shareUrl` — the realm's one deliberate
bearer-token edge) | `meta.http.public`; then one core dispatch with
`[...capabilityPath, "fetch"]`.

## Files

| File                    | Role                  | Owns                                                                                                                              |
| ----------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `itx.ts`                | THE CORE              | `Itx` (the four verbs, journal write/consume seam, live table, longest-prefix dispatch, chain), capability data model, validation |
| `contract.ts`           | the journal contract  | `ItxContract`, `ITX_EVENT_TYPES`, `ItxState` (zod schemas — deliberately loose so old journals never wedge the fold)              |
| `path-proxy.ts`         | Law 6, client-safe    | `PathProxy`, `replayPathCall`, `asPathCallable`, `RESERVED_PATH_SEGMENTS`                                                         |
| `journal.ts`            | the coordinate system | journal paths, context addresses, `dialContext`, `extendContext`, the D1 catalog, the reserved-segment guard                      |
| `dial.ts`               | reach                 | `makeDial` (allowlists, loader/facet wiring, prop injection), `durableObjectFacetsHook`, `resolveDialableTargets`                 |
| `platform-context.ts`   | the chain root        | `PlatformContext` (read-only code context), `PLATFORM_PROJECT_CAPABILITIES`, `getPlatformContext`                                 |
| `itx-durable-object.ts` | the generic host      | `ItxDurableObject`: name = coordinate, descriptor from state, `itx()`                                                             |
| `handle.ts`             | the handle            | `ItxHandle` + built-ins, `CapabilityProvision`, the bare-function probe/wrap, `ItxProjects`, `Stubify`                            |
| `entrypoint.ts`         | restorer + egress     | `resolveItx`, `ItxEntrypoint` (env.ITERATE), `ProjectEgress` (globalOutbound), `EgressPipe`, `BindingCapability`                  |
| `isolate.ts`            | isolate wiring        | `wireIsolateEnv` — the one trust posture for every platform-loaded isolate                                                        |
| `run.ts`                | the script runner     | `runItxScript`: loader isolate + the two-event journal record                                                                     |
| `fetch.ts`              | connect + run         | `/api/itx[/:ref]`, `/api/itx/run`, project-host `/__itx`                                                                          |
| `access.ts`             | connect-time access   | `accessForPrincipal`, `resolveAccessibleContextId` (catalog-backed)                                                               |
| `http.ts`               | routable capabilities | hostname rule, `ItxCapabilityIngress`, share tokens                                                                               |
| `refs.ts`               | wire refs             | `ItxProps`, `ProjectAccess`, `GLOBAL_CONTEXT_ID`, `isChildContextId` (import-light)                                               |
| `types.ts`              | design of record      | the handwritten, import-free agent-facing surface (feeds the REPL editor)                                                         |
| `capabilities/`         | first-party targets   | `StreamsCapability`, `McpClient`, `ProjectWorker` (the user-space forwarder), `UrlDial`                                           |
| `client.ts`             | tier-3 clients        | `withItx` for Node                                                                                                                |
| `use-itx.ts`            | the browser hook      | `useItx`/`getBrowserItx`: singleton sockets, Suspense, never SSRs                                                                 |
| `browser-repl.ts`       | dev tooling           | the REPL snippet compiler (not part of the kernel)                                                                                |
| `admin-auth-cookie.ts`  | test bridge           | browser-WebSocket admin auth (cookies, since WS can't set headers)                                                                |

Everything else in apps/os (oRPC, dashboard routes, domain entrypoints) sits
_on top of_ this layer or beside it — never underneath it.

## Writing capabilities

**Live** (session-bound — your laptop, a browser tab, another service). The
capability IS the stub; `provideCapability` discriminates structurally. A
bare function is the simplest provider (calling the capability calls it); an
object either implements `call({ path, args })` itself — the SDK shape: own
your whole method tree, the public SDK docs become the tool docs — or is
wrapped with `asPathCallable` (the replay runs back in YOUR process):

```ts
import { withItx } from "~/itx/client.ts";

using itx = withItx({ baseUrl, token, context: "my-project" });
const provision = await itx.provideCapability({
  name: "runSwiftOnMyMac",
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
            headers: { authorization: 'Bearer getSecret({ key: "SLACK_TOKEN" })',
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

(Want a durable SDK-shaped surface — the whole `chat.postMessage` tree in
one method? Export a class implementing `call({ path, args })` from your
project worker and point a `ProjectWorker` loopback capability at it with
`props.invoke: "path-call"` — the forwarder's inner mode is its own prop.)

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
stub through `Stubify` (from `handle.ts`) to borrow an SDK's types:

```ts
import type { Stubify } from "~/itx/handle.ts";
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
five-step live→durable capability flow, the journal as the record, egress
through both doors with real secret substitution, the two locked acceptance
tests (middleware via a bare-function `fetch` shadow + `itx.parent`;
indirection via origin dial-back), extend/shadow/chain, the host-provided
workspace semantics, facet state, and the HTTP gate matrix.

## What deliberately does not exist

- **No mounts, no scopes, no composition-as-data.** Wiring is code; only
  overrides are data (journal rows).
- **No capability table outside the journal.** The old SQLite registry and
  the fire-and-forget "audit" appends are gone; an audit log is not a
  concept — events are the writes, state is their fold.
- **No name index for chain resolution** — misses delegate upward per call
  (D2; add a cache only when latency data demands it).
- **No durable delivery on live stubs.** Offline means offline; durability
  is an address or a journal.
- **No heap persistence** for REPL/session state — replay from streams.
- **No verb-level permission data.** Narrower authority = a narrower context
  or capability, by construction.
- **No global context node yet.** Global handles are connect-minted views;
  the locked direction makes `global` a named instance of the generic host
  when something needs to write on it.
