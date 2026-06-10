# itx — contexts, capabilities, and the one true handle

This directory is the **capability layer** of apps/os: the smallest possible
trust kernel through which every piece of user-adjacent code — browser, Node,
agents, the iterate-config worker, one-off scripts, capabilities themselves —
talks to the platform. Design rationale and history: `apps/os/docs/itx-spec.md`
(the spec) and `DECISIONS.md` (what changed on contact with reality).

## The Laws

These invariants ARE the architecture. Every file here serves one of them.

1. **The stream holds sturdy facts. The context node holds live refs. Code
   holds composition.** Durable state is events + the node's SQLite; live
   stubs are runtime-only and rebuilt by reconnection; wiring capabilities
   together is always plain code, never data interpreted by the platform.
2. **Props carry identity, never composition or authority-by-content.**
   `ItxProps = { context, access?, cap? }` — a sturdy ref plus attribution.
3. **Auth happens at connect, nowhere else.** Credentials become a handle
   once, at the edge (`fetch.ts`). No code holding an itx ever checks scopes;
   _which context your handle points at_ is the authority.
4. **Narrowing is construction.** `itx.projects.get()` and `itx.fork()`
   return new handles on narrower contexts — never flags on wider ones.
5. **All policy-governed egress flows through one pipe.** Loaded isolates get
   it as global `fetch` (`globalOutbound = ProjectEgress`); everyone else
   calls `itx.fetch()`. Secrets are substituted inside the Project DO and
   never exist anywhere else.
6. **One wire protocol for dynamic surfaces.** A capability is invoked either
   by replaying property path segments (`invoke: "members"`) or by ONE
   `call({ path, args })` (`invoke: "path-call"`). One consumer-side adapter
   (`path-proxy.ts`). Nothing else is ever standardized.
7. **Cap'n Web terminates in the stateless worker, never in a DO.** The DOs
   speak plain Workers RPC — Kenton's stated hibernation architecture
   (capnweb#36 / workerd#6087), so hibernatable RPC arrives for free.

## Taxonomy

| Term                 | Meaning                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **context**          | A durable node: capability registry + parent pointer + audit stream + live connections. Three flavors, one anatomy.                                                     |
| **global context**   | The root. Holds `projects`. No registry (deliberately — ambient authority creep starts here).                                                                           |
| **project context**  | One per project, hosted **by** the Project Durable Object. Its built-in surface (streams, repos, workspace, worker, fetch) is "capability #0".                          |
| **child context**    | `ctx_…`, hosted by `ContextDO`, created by `itx.fork()`. An agent session, a REPL scratchpad. Same anatomy, disposable.                                                 |
| **cap**              | A named registry entry: `live` (connected provider's stub), `worker` (stored source, stateless), `facet` (stored source extending `DurableObject`, own private SQLite). |
| **itx**              | A live handle on a context — the only thing user code touches.                                                                                                          |
| **itx script**       | A function `(itx) => result`, runnable identically from every execution mode (vars are baked in client-side).                                                           |
| **connect**          | credential → handle (`/api/itx`). The only auth point.                                                                                                                  |
| **provide / define** | Register a live / durable capability.                                                                                                                                   |
| **fork**             | Create a child context.                                                                                                                                                 |
| **restorer**         | `resolveItx`: serializable props → live handle.                                                                                                                         |

## The context tree

```text
global                                   (no node yet; "projects" is built-in)
└── project proj_…                       (hosted BY the Project DO)
    │   registry ──► itx_caps (SQLite)   audit ──► stream  {proj}:/itx
    │   live table (in-memory)           cap #0 = the DO's own surface
    ├── child ctx_…                      (ContextDO; itx.fork())
    │     registry + live table of its own; misses delegate ↑ per call
    └── child ctx_… …                    (any depth; parents may be ctx_… too)
```

## One request, end to end

`itx.todo.add({ text })` from a browser REPL:

```text
browser ──capnweb/WebSocket──► OS worker /api/itx        (auth happened at connect)
   itx (handle.ts) — fallthrough Proxy misses "todo"
        └─► PathProxyRpcTarget accumulates ["add"], one terminal call
              └─► Workers RPC: ProjectDO.itxInvoke({name:"todo", path:["add"], args})
                    └─► ContextRegistry.invoke   ◄── THE one dispatch (supervisor)
                          ├─ live   → replay path on provider's stub
                          ├─ worker → LOADER.get(codeId) → entrypoint, replay path
                          │            env.ITERATE = ItxEntrypoint({context})  ┐
                          │            globalOutbound = ProjectEgress         ┤ Law 5
                          └─ facet  → ctx.facets.get("cap:todo") → RPC call   ┘
```

Egress, both doors:

```text
   bare fetch() in ANY loaded isolate ─┐
                                       ├─► ProjectEgress ─► ProjectDO.egressFetch
   itx.fetch(...) from ANY handle ─────┘        (secret substitution, intercept
                                                 tunnel, future approval policy)
```

HTTP routing to capabilities (spec §8):

```text
https://{cap}--{project}.{base}/…
   └─► worker.ts lookupRule → getItxCapHostIngressRule
         └─► ItxCapIngress.fetch: 404 unless meta.http.expose
               gate: admin bearer │ signed share URL │ meta.http.public
               └─► ProjectDO.itxInvoke({name, path:["fetch"], args:[request]})
```

## Files (the whole kernel)

| File                   | Role                     | Owns                                                                                                                              |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `protocol.ts`          | the serializable surface | `ItxProps`, cap types, name validation, event types                                                                               |
| `path-proxy.ts`        | Law 6, both halves       | `PathProxyRpcTarget` (consumer), `replayPathCall` (supervisor)                                                                    |
| `registry.ts`          | the supervisor           | `ContextRegistry`: provide/define/revoke/describe/invoke, live table, loader/facet wiring                                         |
| `handle.ts`            | the handle               | `Itx` + built-ins (`caps`, `streams`, `repos`, `workspace`, `worker`, `project`, `projects`, `fetch`, `fork`), `ItxFn`, `Stubify` |
| `entrypoint.ts`        | the restorer + egress    | `resolveItx`, `ItxEntrypoint` (env.ITERATE), `ProjectEgress` (globalOutbound)                                                     |
| `context-do.ts`        | child contexts           | `ContextDO`: descriptor, registry host, chain delegation                                                                          |
| `fetch.ts`             | connect + run            | `/api/itx[/:context]`, `/api/itx/run`, project-host `/__itx`                                                                      |
| `http.ts`              | routable caps            | hostname rule, `ItxCapIngress`, share tokens                                                                                      |
| `client.ts`            | tier-3 clients           | `connectItx` for Node (browser uses `browser-repl.ts`/the REPL routes)                                                            |
| `use-itx.ts`           | the browser hook         | `useItx`/`getBrowserItx`: per-context singleton sockets, Suspense until connected, never SSRs (DECISIONS D21)                     |
| `browser-repl.ts`      | dev tooling              | the REPL snippet compiler (not part of the kernel)                                                                                |
| `admin-auth-cookie.ts` | test bridge              | browser-WebSocket admin auth (cookies, since WS can't set headers)                                                                |

Everything else in apps/os (oRPC, dashboard routes, domain entrypoints) sits
_on top of_ this layer or beside it — never underneath it.

## Writing capabilities

**Live** (session-bound — your laptop, a browser tab, another service):

```ts
import { connectItx } from "~/itx/client.ts";

const itx = connectItx({ baseUrl, token, context: "my-project" });
await itx.caps.provide({ name: "runSwiftOnMyMac", target: async (src) => runSwift(src) });
// stays callable as itx.runSwiftOnMyMac(...) until this connection drops
```

**Worker** (durable, stateless — e.g. an SDK adapter). The `path-call` mode
means public SDK docs become your tool docs: tell an agent "`itx.slack` works
exactly like @slack/web-api" and that's the whole tool description.

```ts
await itx.caps.define({
  invoke: "path-call",
  name: "slack",
  source: { codeId, mainModule: "cap.js", modules: { "cap.js": `
    import { WorkerEntrypoint } from "cloudflare:workers";
    export default class extends WorkerEntrypoint {
      async call({ path, args }) {
        // bare fetch() here IS project egress: the Slack token lives in
        // project secrets and is substituted server-side (Law 5)
        return await (await fetch("https://slack.com/api/" + path.join("."), {
          body: JSON.stringify(args[0]),
          headers: { authorization: 'Bearer getSecret({ key: "SLACK_TOKEN" })',
                     "content-type": "application/json" },
          method: "POST",
        })).json();
      }
    }
  ` },
});

await itx.slack.chat.postMessage({ channel: "C123", text: "hi" });
```

**Facet** (durable + stateful — its own private SQLite, zero provisioning).
The class must be a **named** export (D12):

```ts
await itx.caps.define({
  kind: "facet",
  name: "todo",
  source: { codeId, entrypoint: "Todo", mainModule: "cap.js", modules: { "cap.js": `
    import { DurableObject } from "cloudflare:workers";
    export class Todo extends DurableObject {
      async add({ text }) { /* this.ctx.storage is YOURS alone */ }
    }
  ` },
});
```

**Typed caps**: there is no static registry of cap names — `itx.<name>` falls
through a runtime Proxy (`handle.ts`), so TypeScript only knows the built-ins.
To get an SDK's types on a cap, cast its stub through `Stubify` (exported from
`handle.ts`), which maps every function in the type to its async stub form:

```ts
import type { Stubify } from "~/itx/handle.ts";
const slack = itx.cap("slack") as Stubify<import("@slack/web-api").WebClient>;
await slack.chat.postMessage({ channel, text });
```

## Execution modes (all proven in `e2e/`)

| Mode                  | How the handle arrives                                      |
| --------------------- | ----------------------------------------------------------- |
| Node / laptop         | `connectItx()` → capnweb WebSocket → `/api/itx`             |
| browser               | same endpoint; REPL routes put `itx` in scope               |
| itx script            | `POST /api/itx/run` → loader isolate, `env.ITERATE.context` |
| iterate-config worker | Project DO loads it with a project-scoped `env.ITERATE`     |
| worker / facet cap    | the registry loads it with a context-scoped `env.ITERATE`   |

The e2e suite (`pnpm e2e:itx` against any deployment) runs the same scripts
through the modes and covers: the five-step live→durable capability flow,
egress through both doors with real secret substitution, fork/shadow/chain,
facet state, and the HTTP gate matrix.

## What deliberately does not exist

- **No mounts, no TargetCall, no scopes.** Composition-as-data died in the
  spec process; see itx-spec §9 for the body count.
- **No name index for chain resolution** — misses delegate upward per call
  (D2; add a cache only when latency data demands it).
- **No durable delivery on live stubs.** Offline means offline; durability is
  a stream or a durable cap.
- **No heap persistence** for REPL/session state — replay from streams.
- **No verb-level permission data.** Narrower authority = a narrower context
  or cap, by construction.
