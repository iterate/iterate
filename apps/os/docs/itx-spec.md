# itx: Contexts, Capabilities, and the One True Handle

Status: IMPLEMENTED — merged to `main` in PR #1407. This spec is the design of
record; the living code is in `apps/os/src/itx/` — see
`apps/os/src/itx/README.md` (architecture + diagrams) and
`apps/os/src/itx/DECISIONS.md` (where reality diverged from this spec). The
implementation is proven by `pnpm e2e:itx` against a deployed worker (node +
browser execution modes). Known divergence from the phase plan: the client
reconnect loop (§6.3) was never built — `connectItx` in `src/itx/client.ts` is
one-shot, so a dropped connection drops the live caps it provided.

## 0. Summary

We replace the current Cap'n Web mount/scope machinery with three primitives:

- **Context** — a durable, addressable node in a tree (global → project →
  child). Every context has the same anatomy: a capability registry, a parent
  pointer, a stream, and a table of live connections.
- **Capability (cap)** — a named entry in a context's registry. Three kinds:
  `live` (a connected provider's stub), `worker` (stored source, stateless),
  `facet` (stored source exporting `extends DurableObject`, with its own
  SQLite database).
- **itx** — a live handle on a context. The only thing user code ever touches.
  `itx.slack.chat.postMessage(...)`, `itx.streams`, `itx.fetch`. Identical in
  the browser, Node, the REPL, the iterate-config worker, codemode scripts,
  stream processors, and caps themselves.

Everything else in the current design — mounts, `TargetCall`, `scopes`,
"sessions" as a distinct concept, `getIterateContextProps()`, the
`globalThis.fetch` monkeypatch — is deleted, not replaced.

## 1. The Laws

These invariants are the spec. Every design question below resolves to one of
them. PRs that violate one need to amend this document first.

1. **The stream holds sturdy facts. The context node holds live refs. Code
   holds composition.** Durable state is events (cap defined, cap revoked,
   provider disconnected). Live stubs exist only in memory and are rebuilt by
   reconnection. Composition (wiring caps together, shortcuts, adapters) is
   always plain code on the side that authored it — never data interpreted by
   the platform.
2. **Props carry identity, never composition or authority-by-content.** The
   only serializable parameterization in the system is a sturdy ref:
   `{ context: "<id>" }` plus optional attribution labels. Resolving props to
   live objects (the "restorer") is the single place authority is checked.
3. **Auth happens at connect, nowhere else.** Credentials are translated to a
   context handle exactly once, at the edge. Code holding an itx never checks
   scopes, because scopes don't exist: _which context your handle points at_
   is the authority.
4. **Narrowing is construction.** A more limited itx is a handle on a narrower
   context (or a child context), not a flag on a wider one.
5. **All policy-governed egress flows through one path.** Isolates we load get
   it as global `fetch` (enforced); everyone else gets it as `itx.fetch`
   (explicit). Secrets are substituted inside the egress hop and never exist
   anywhere else.
6. **One wire protocol for dynamic surfaces:** a cap is invoked either by
   replaying property path segments on its stub (`invoke: "members"`) or by a
   single `call({ path, args })` (`invoke: "path-call"`). Nothing else is ever
   standardized. There is exactly one consumer-side adapter
   (`PathProxyRpcTarget`).
7. **Cap'n Web terminates in a stateless worker, never in a DO.** The DO sees
   plain Workers RPC. This is Kenton's stated long-term hibernation
   architecture (capnweb#36, workerd#6087); keeping the seam means hibernatable
   RPC targets arrive for free when the runtime ships them.

## 2. Glossary

| Term            | Meaning                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| context         | Durable node: registry + parent + stream + live connections                                                                       |
| global context  | The root node. Holds `projects`. Registry kept deliberately tiny.                                                                 |
| project context | One per project. Hosted by the Project DO. Its built-in surface (streams, repos, workspace, worker, fetch) is "cap #0".           |
| child context   | Cheap, forkable node under a project (agent session, REPL, codemode run, notebook later). Hosted by `ContextDO`.                  |
| cap             | Named registry entry: `live` \| `worker` \| `facet`                                                                               |
| itx             | A live handle on a context; an `RpcTarget` + fallthrough proxy                                                                    |
| itx script      | A function `({ itx, vars }) => result` runnable against any context from any execution mode (replaces the name "codemode script") |
| connect         | credential → itx. The only auth point.                                                                                            |
| provide         | Register a `live` cap (session-bound to the provider's connection)                                                                |
| define          | Register a `worker`/`facet` cap (durable, source stored)                                                                          |
| fork            | Create a child context: `const child = await itx.fork(...)`                                                                       |
| restorer        | The entrypoint code that turns `{ context }` props into a live itx                                                                |

Identifier: **`itx`** is the canonical variable name and module namespace.
Files live in `apps/os/src/itx/`. Public URL prefix is `/api/itx` (this also
retires the `captnweb` misspelling).

## 3. The Context Tree

```text
global                      (singleton ContextDO "global"; registry ~empty)
└── project proj_123        (hosted BY the Project DO — not a separate DO)
    ├── child ctx_agent_…   (ContextDO; agent session)
    ├── child ctx_repl_…    (ContextDO; REPL/notebook session)
    └── child ctx_run_…     (ContextDO; optional, for long codemode runs)
```

### 3.1 Hosting

- **Project context**: the existing `ProjectDurableObject` _embeds_ the
  registry (a shared `ContextRegistry` module, §4). We do not split project
  state into a second DO. The project context's id is the project id.
- **Child contexts**: a new `ContextDO` class hosts one child context per
  instance. Storage: its own SQLite. Parent pointer stored as a sturdy ref
  (`{ parent: "proj_123" }`).
- **Global context**: `ContextDO` instance named `"global"`. Its registry is
  human-curated and near-empty (Law: the global layer is where ambient
  authority creeps back in; keep it boring). `projects` is a built-in here,
  not a cap.

### 3.2 Context identity

Context ids are TypeIDs: `proj_…` (existing) and `ctx_…` (new prefix for child
contexts). `"global"` is a reserved literal. A context id is sufficient to
restore a handle — it is the sturdy ref.

### 3.3 Resolution chain

Cap lookup walks child → project → global. Implementation: the restorer
fetches a **merged name index** (name → owning context id + kind + invoke)
once at itx construction and dispatches each call directly to the owning
node — no per-miss DO hops. The index is small (names + metadata only) and is
invalidated by registry events on the context streams. Shadowing is allowed
(child `slack` overrides project `slack`) and must be _visible_:
`itx.caps.describe()` returns name → `{ owner, kind, invoke, definedBy,
version }` for the whole chain.

## 4. The Registry (`ContextRegistry`)

One module, embedded by both `ProjectDurableObject` and `ContextDO`.

### 4.1 Entry kinds

```ts
type CapEntry =
  | { kind: "live"; invoke: Invoke; meta: CapMeta } // stub in memory only
  | { kind: "worker"; invoke: Invoke; source: StoredSource; meta: CapMeta }
  | { kind: "facet"; invoke: Invoke; source: StoredSource; meta: CapMeta };

type Invoke = "members" | "path-call";

type StoredSource = {
  codeId: string; // NEW id for every source change (loader caches by id)
  mainModule: string;
  modules: Record<string, string>;
  entrypoint?: string; // default: default export
  compatibilityDate: string;
};

type CapMeta = {
  definedBy: { type: "user" | "agent" | "system"; id: string };
  http?: { expose: boolean; public?: boolean }; // §8
  createdAtOffset: number; // stream offset = version
};
```

### 4.2 Durable state = a fold of the context stream

Registry mutations append events to the context's stream and the registry
table is the fold. Event types (in the project/child context streams):

- `itx.cap.defined` — { name, kind, invoke, source?, meta } (source for
  worker/facet; payload may store large module maps by reference later — out
  of scope for now)
- `itx.cap.provided` — { name, invoke, providerIdentity, meta } (NO stub —
  live stubs are never in the stream)
- `itx.cap.revoked` — { name }
- `itx.cap.disconnected` — { name, reason } (normal event, not an error)
- `itx.context.forked` — { childId, by }

This gives audit, versioning, and a dashboard panel for free, in the
platform's native idiom.

### 4.3 Live connection table

In-memory map `name → { stub: RpcStub; epoch: number }`, behind an interface:

```ts
interface LiveConnections {
  set(name: string, stub: RpcStub): void; // stores stub.dup(); disposes prior
  get(name: string): RpcStub | undefined; // returns .dup()
  delete(name: string): void;
}
```

The interface exists so that when workerd ships hibernation-surviving outbound
stub storage (workerd#6087), we swap the Map for the runtime facility and
delete the reconnect caveat without touching callers. Until then: eviction
drops live caps; providers must reconnect and re-provide (the automatic
reconnect loop was never built — see §6.3); `itx.<liveCap>` throws
`CapOfflineError { name, provider }` while disconnected. Do NOT add queuing or
durable delivery on live stubs — durable delivery is a stream.

Both directions of the existing `dup()` discipline from
`apps/os/src/capnweb/LEARNINGS.md` are preserved (dup on register, dup on
borrow).

### 4.4 Invocation (the supervisor dispatch)

The hosting DO is the supervisor. The ONLY dispatch in the system:

```ts
async invokeCap(name: string, call: { path: string[]; args: unknown[] }) {
  const entry = this.registry.get(name);          // local only; chain resolved by caller
  const target = await this.targetFor(entry, name);
  if (entry.invoke === "path-call") {
    return await target.call(call);               // one RPC, path delivered as data
  }
  return await replayPath(target, call.path, call.args);  // member replay; receiver-preserving
}

private async targetFor(entry: CapEntry, name: string) {
  switch (entry.kind) {
    case "live":   return this.connections.get(name) ?? raise(new CapOfflineError(name));
    case "worker": return this.loadWorkerCap(entry, name).getEntrypoint(entry.source.entrypoint);
    case "facet":  return this.ctx.facets.get(`cap:${name}`, () => ({
                     class: this.loadWorkerCap(entry, name)
                       .getDurableObjectClass(entry.source.entrypoint ?? "default"),
                   }));
  }
}

private loadWorkerCap(entry: { source: StoredSource }, name: string) {
  return this.env.LOADER.get(entry.source.codeId, () => ({
    compatibilityDate: entry.source.compatibilityDate,
    mainModule: entry.source.mainModule,
    modules: entry.source.modules,
    env: { ITERATE: this.ctx.exports.ItxEntrypoint({
      props: { context: this.contextId, cap: name } }) },
    globalOutbound: this.ctx.exports.ProjectEgress({
      props: { project: this.projectId, context: this.contextId, cap: name } }),
  }));
}
```

`replayPath` is the receiver-preserving walk we already have working
(LEARNINGS: "Preserve Receivers"); it is ~20 lines and lives here and nowhere
else. The `wrapForwardedResult` heuristics from the current code are deleted —
worker/facet caps speak native Workers RPC and their return values follow
normal RPC serialization; anything that needs a dynamic surface uses
`invoke: "path-call"` explicitly.

Cap code receives an itx on **the context where the cap is defined** (see
props above) — a cap can never reach wider than its home context. (Open
question §12.2 covers per-cap attenuation.)

### 4.5 Name validation

At `provide`/`define` time, reject: names colliding with built-ins
(`caps`, `streams`, `repos`, `workspace`, `worker`, `fetch`, `project`,
`projects`, `fork`, `describe`), reserved JS/RPC names (`then`, `catch`,
`finally`, `dup`, `constructor`, `toString`, `valueOf`, `onRpcBroken`,
`hasOwnProperty`, `map`, `__proto__`, `prototype`), and non-identifier
strings. Registry names are **flat** — no dots, no nesting. Grouping is done
by registering an object (`provide("tools", { slack, github })`); nested
_names_ would reintroduce path resolution into the platform.

This single registration-time check replaces the three scattered
reserved-name blocklists in the current code (path proxy, worker proxy,
sdkPathProxy).

## 5. The itx Handle

### 5.1 Shape

```ts
// apps/os/src/itx/handle.ts
export class Itx extends RpcTarget {
  constructor(private readonly node: ContextHandle) {
    super();
    return withCapFallthrough(this, node); // one Proxy; own members win, then chain lookup
  }

  // ---- built-ins (typed, boring, the trust kernel) ----
  get caps(): CapsApi; // provide / define / revoke / describe / promote
  get streams(): StreamsApi; // project-scoped (resolved via node.projectId)
  get repos(): ReposApi;
  get workspace(): WorkspaceApi;
  get worker(): ConfigWorkerApi; // the project iterate-config worker (a path-call facade)
  get project(): ProjectApi; // cap #0 surface of the owning project
  get projects(): ProjectsApi; // ONLY present on a global-context handle
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>; // egress, §7
  fork(opts?: { name?: string }): Promise<{ context: string }>;
  describe(): Promise<ItxDescription>;
}
```

`withCapFallthrough`: unknown string property → `new PathProxyRpcTarget(call =>
node.invoke(name, call))` where `node.invoke` dispatches to the owning context
in the resolved name index. Built-ins always win; the registration-time
validation (§4.5) guarantees no cap can shadow them.

`PathProxyRpcTarget` (current `apps/os/src/capnweb/path-proxy-rpc-target.ts`)
is kept nearly as-is and becomes the **only** path-proxy implementation in the
codebase. The constructor-Proxy in `ProjectWorkerCapability` and the README's
`sdkPathProxy` are replaced by it.

### 5.2 The restorer

```ts
// apps/os/src/itx/entrypoint.ts
export type ItxProps = {
  context: string; // "global" | proj_… | ctx_…   ← identity, the sturdy ref
  cap?: string; // attribution only: which cap's isolate this is
};

export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxProps> {
  get context(): Itx {
    // restore(): names → live object graph. The ONLY authority gate
    // besides connect-time auth (§6).
    const node = resolveContextChain(this.env, this.ctx.props.context);
    return new Itx(node);
  }
}
```

`resolveContextChain` loads the merged name index (cached per isolate with
stream-offset versioning) and returns a `ContextHandle` that knows how to
reach each owning node (Project DO stub / ContextDO stub / global).

### 5.3 Local extension (in-process only)

For REPL/harness ergonomics, `createItx(node, extend?)` accepts a record of
live values installed as own members at construction. This never serializes
and never crosses a boundary as data (Law 2). Anything that must be visible to
_other_ participants of a context is a cap, not an extend.

### 5.4 Types

```ts
export type ItxFn<V = Record<string, unknown>, R = unknown> = (input: {
  itx: Itx & ProjectCaps;
  vars: V;
}) => Promise<R>;

export type Stubify<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object
    ? { [K in keyof T]: Stubify<T[K]> }
    : never;

// project workspace code augments:
declare module "@iterate-com/os/itx" {
  interface ProjectCaps {
    slack: Stubify<import("@slack/web-api").WebClient>;
    runSwiftOnMyMac: (src: string) => Promise<{ stdout: string }>;
  }
}
```

Statically-declared caps get full types ("the Slack SDK docs ARE the tool
docs"); agent-self-defined caps are `any` until someone writes a declaration.
Generating `caps.d.ts` from the registry into the workspace is a later,
derived-artifact feature — not core.

## 6. Connect (auth) and Transports

### 6.1 Endpoints

| Endpoint                      | Returns                                        | Auth                                                                                                                                         |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST/WS /api/itx`            | itx on global or project context per principal | admin secret → global; user session → project (their active project)                                                                         |
| `POST/WS /api/itx/:contextId` | itx on that context                            | principal must be able to reach contextId (admin: any; user: contexts under their projects)                                                  |
| `WS {project-host}/__itx`     | itx on that project's context                  | project ingress auth (replaces `/__iterate/capnweb`, which returned the raw project capability — now it returns an itx like everywhere else) |
| `POST /api/itx/run`           | run an itx script in a loader isolate          | same as `/api/itx`                                                                                                                           |
| `/api/itx/admin-cookie`       | test-only browser auth bridge                  | unchanged mechanism                                                                                                                          |

The worker fetch handler is where capnweb terminates (Law 7):
`newWorkersRpcResponse(request, restoreItx(principal → contextId))`. The DOs
behind it speak Workers RPC only.

### 6.2 `/api/itx/run`

Stays a dumb harness, now with no monkeypatch:

```ts
const worker = env.LOADER.load({
  compatibilityDate,
  mainModule: "script.js",
  modules: { "script.js": runHarnessSource(functionSource) }, // resolves env.ITERATE.context, calls fn, JSON result
  env: { ITERATE: ctx.exports.ItxEntrypoint({ props: { context } }) },
  globalOutbound: ctx.exports.ProjectEgress({ props: { project, context } }),
});
```

The esbuild `using`-lowering repair stays in the e2e helper, not in `/run`
(existing LEARNINGS rule).

### 6.3 Remote providers (Node, browser, laptop daemon)

```ts
import { connectItx } from "@iterate-com/os/itx/client";

const itx = await connectItx({ context: "proj_jonas_home", token });

await itx.caps.provide("runSwiftOnMyMac", async (src) => runSwift(src));
await itx.caps.provide("mac", { invoke: "path-call", target: new MacSdk() });

// explicit egress from the provider side — fetches through the project's
// egress path with secret substitution, NOT the laptop's network:
const r = await itx.fetch("https://api.stripe.com/v1/charges", { ... });
```

The client was specced to ship a reconnect loop (provide-on-open), with
disconnection as a normal `itx.cap.disconnected` event — **not implemented**:
`connectItx` (`src/itx/client.ts`) is one-shot, and there is no
`itx.cap.disconnected` event; a dropped connection simply drops the caps it
provided. The same client is the browser client; React
hooks (`useItx()`, `useCap(name)`) are a thin layer over it and are the
eventual replacement for oRPC — out of scope for this spec beyond ensuring
nothing blocks it (capnweb in the browser already works; promise pipelining
makes hook chains one round trip).

## 7. Egress

One pipe, two doors:

- **Implicit (enforced):** every isolate the platform loads — itx-script
  runners, the iterate-config worker, `worker` caps, `facet` caps,
  dynamically-loaded stream processors — gets
  `globalOutbound: ctx.exports.ProjectEgress({ props })`. Bare `fetch()`
  (including inside npm dependencies) IS project egress. No code changes, no
  conventions, no escape.
- **Explicit (universal):** `itx.fetch(...)` on every handle, from every
  execution mode including remote providers (tier 3 hardware we don't load).
  Platform code (the OS worker, static multi-tenant DOs) also uses this door.

`ProjectEgress` is a `WorkerEntrypoint` whose fetch forwards into the Project
DO's existing egress path (secret placeholder substitution happens there;
secrets never enter loaded isolates). Props `{ project, context, cap? }` are
attribution labels — they grant nothing, they identify the requester for
audit and, later, per-cap policy. Future approval flow needs no new
machinery: egress parks the request, appends `itx.egress.approval-requested`
to a stream, a human/agent approves, the fetch proceeds.

Delete: the `globalThis.fetch` swap in `rootRunWorkerSrc`
(`apps/os/src/capnweb/root-context-fetch.ts:122-128`).

## 8. HTTP Routing to Caps

Any cap whose surface includes `fetch(Request): Response` is routable. The
hosting DO's supervisor fetch is the router.

- **URL scheme:** `https://{cap}--{project}.{projectHostnameBase}/…` routed to
  `invokeCap(name, fetch)` on the project context; child-context caps get
  `{cap}--{ctxId}--{project}.…`. Subdomain-per-cap, never path-under-main-
  origin: agent-authored HTML on the dashboard origin is XSS into dashboard
  cookies. This reuses the existing project hostname-base machinery one level
  down.
- **Dispatch:** `live` → forward Request over the capnweb stub (Request /
  Response are pass-by-value in capnweb — this is captun, internalized);
  `worker` → entrypoint fetch; `facet` → `facet.fetch(request)`.
- **Auth default:** routable ≠ public. Default requires project-member auth at
  the router. `meta.http.public: true` is explicit opt-in. Signed short-lived
  share URLs (`itx.caps.shareUrl("demo", { ttl })`) cover "let me show you
  something real quick".
- The project's own ingress is the same rule applied to cap #0: the config
  worker is the default routable cap at the bare project hostname.

## 9. What Gets Deleted (the point of all this)

From `apps/os/src/capnweb/`:

| Deleted                                                                                      | Replaced by                                                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Mount`, `MountTarget`, `TargetCall`, `invoke: "target" \| "method"`                         | registry entries + the two `Invoke` modes                                              |
| `resolveMount`, `installMountedRootMembers`, per-instance prototypes                         | `withCapFallthrough` (one Proxy)                                                       |
| `resolveTargetCall`, `invokeDynamicWorkerTarget`, `resolveDynamicTargetCall`                 | `invokeCap` + `replayPath` (§4.4)                                                      |
| `wrapForwardedResult` + `isPassByValueObject` / `isPlainDataContainer` / disposer heuristics | native RPC semantics; `path-call` for dynamic surfaces                                 |
| `getIterateContextProps()` + two-step config-worker load                                     | parent constructs itx, passes as `env.ITERATE`; durable shortcuts are registry entries |
| `scopes: { projects: "all" \| string[] }`                                                    | `props.context` (Law 2/3)                                                              |
| `ProjectCapability`'s 16 `(...args: any[])` forwarders                                       | DO capability returned directly + thin typed additions                                 |
| Root*/Project* capability triples' duplicated `assertNamespaceAccess` / address parsing      | gone — leaf capabilities carry no auth (Law 3); one shared address parser              |
| `ProjectWorkerCapability` constructor-Proxy + README `sdkPathProxy`                          | the single `PathProxyRpcTarget`                                                        |
| `globalThis.fetch` monkeypatch in `/run` harness                                             | `globalOutbound` (§7)                                                                  |
| `apps/os/src/domains/capability-prototype/` (entire dir)                                     | lessons extracted into itx tests, then deleted                                         |
| `/api/captnweb` naming                                                                       | `/api/itx`                                                                             |

Kept: `PathProxyRpcTarget` (promoted), the receiver-preservation and `dup()`
disciplines from LEARNINGS.md (codified in §4.3/§4.4), the same-script-
everywhere e2e harness (§11), `projects-capability.ts` narrowing +
`requireProject` (now memoized — it currently does the DB lookup twice), the
browser REPL (rewired to `connectItx`; its statement parser is untouched in
this migration).

## 10. Migration Plan

Each phase lands independently behind the existing e2e suite. The old
`/api/captnweb` surface keeps working until Phase 6 removes it.

### Phase 1 — Registry in the Project DO

- Add `ContextRegistry` module + `LiveConnections` interface; embed in
  `ProjectDurableObject`. Back it with the registry events (§4.2) on the
  project stream.
- Migrate `provideCapability`/`getConnection` (`project-durable-object.ts:410-446`)
  onto it: `provide` = live entry; `getConnection` = `invokeCap` borrow.
  Existing dup() semantics preserved.
- Add `define` (worker kind only), `revoke`, `describe`, name validation
  (§4.5).
- Tests: registry fold from stream; live disconnect; reserved names; the
  step-1-through-5 "SlackSdk" scenario from the design conversation as an e2e.

### Phase 2 — itx handle + entrypoint

- New `apps/os/src/itx/`: `handle.ts`, `entrypoint.ts` (`ItxProps =
{ context, cap? }`), `path-proxy.ts` (moved), `client.ts` (Node/browser
  connect + reconnect loop).
- `ItxEntrypoint` replaces `IterateContextEntrypoint`; `resolveContextChain`
  replaces scope plumbing. Built-ins delegate to existing domain entrypoints
  (streams/workspace/repos) exactly as today, minus the per-leaf auth asserts.
- `/api/itx`, `/api/itx/run`, project-host `/__itx` endpoints (old endpoints
  alias to them).
- Rewrite config-worker invocation: Project DO passes
  `ctx.exports.ItxEntrypoint({ props: { context: projectId } })` as
  `env.ITERATE`; delete `getIterateContextProps` and the two-step load.
- Delete the mounts machinery in `iterate-context-capability.ts`; port the
  e2e scenarios that used mounts to caps (`define`/`provide`).

### Phase 3 — Egress unification

- `ProjectEgress` entrypoint forwarding to the existing Project DO egress
  path; wire `globalOutbound` in every `LOADER.load/get` call site
  (`/run` harness, config worker, worker caps).
- Add `itx.fetch` built-in. Delete the monkeypatch. E2e: secret substitution
  works from a script's bare `fetch`, from a worker cap's dependency code, and
  from a Node provider via `itx.fetch`.

### Phase 4 — Child contexts

- `ContextDO` (hosts one child context; embeds the same `ContextRegistry`);
  `itx.fork()`; chain resolution + merged name index with stream-offset
  invalidation; `caps.describe()` provenance across the chain.
- Agent harness creates a fork per session and provides `respond` (and
  friends) as live caps on it — harness verbs stop being special-cased.
- `connectItx({ context: ctx_… })` for multi-participant sessions.

### Phase 5 — Facet caps + HTTP routing

- `facet` kind in `define` (requires DO-side `LOADER` binding + facets API,
  both available per the Facets beta); `cap:` facet naming; codeId rotation on
  source change.
- Hostname router in project ingress (`{cap}--{project}.…`), auth default,
  `http.public` opt-in, share URLs.
- E2e: agent defines a stateful facet cap with a fetch UI and a share URL hits
  it ("let me show you something real quick").

### Phase 6 — Cleanup

- Delete `apps/os/src/domains/capability-prototype/` after porting its three
  e2e assertions into the itx suite.
- Remove `/api/captnweb` aliases, old files, and the `captnweb` spelling
  everywhere. Update README/LEARNINGS into `apps/os/src/itx/README.md` with
  the Laws (§1) at the top.
- Browser REPL switched to `connectItx`; default snippet becomes
  `await itx.projects.list({ limit: 5 })`.

## 11. Testing Strategy

The same-itx-script-everywhere harness is the executable proof and survives
unchanged in spirit: every scenario is an `ItxFn` executed via (a) browser
capnweb, (b) Node capnweb, (c) `/api/itx/run`, (d) the CLI; Workers-for-
Platforms joins later as mode (e). New scenario classes per phase:

1. Registry: define/provide/revoke/shadow/describe; offline live cap error.
2. The five-step provider test: REPL-provided `path-call` SlackSdk → other
   participant calls `itx.slack.chat.postMessage` → promote via `define` →
   config worker calls it with zero ceremony.
3. Egress: substitution via bare fetch in all tier-1 isolates; `itx.fetch`
   from tier 3; attribution props visible in egress logs.
4. Fork: child shadows parent; fork-scoped cap invisible to sibling forks.
5. Routing: facet cap serves HTML on its own hostname; auth default blocks
   anon; share URL admits.

## 12. Non-Goals and Open Questions

### 12.1 Explicit non-goals

- No JS heap snapshotting for any kernel/REPL state — replay from streams.
- No nested registry names; no `TargetCall`-style data composition, ever.
- No durable delivery on live stubs — offline means offline; durability is a
  stream.
- No building on the community capnweb-hibernation fork; we keep the Law-7
  seam and wait for workerd.
- No verb-level permission data in props. Narrower authority = narrower
  context/cap, by construction.
- Notebook/cells UI: out of scope (the stream/registry design doesn't block
  it).

### 12.2 Open questions (decide during Phase 1/2 review)

1. **Per-cap attenuation:** should `define` accept `grants: string[]` limiting
   which sibling caps a cap's own itx can see? Capability-pure answer is a
   filtered child context per cap; decide whether that's Phase-4 cheap or
   premature.
2. **Worker-cap placement:** hot project-wide caps run inside the Project DO's
   isolate today (supervisor dispatch). If a cap becomes a throughput problem,
   it needs its own DO namespace or stateless-worker-with-own-egress shape.
   Define the escape hatch when it hurts, not before.
3. **`live` + `path-call` provider API:** `provide(name, fnOrObject)` infers
   `members`; `provide(name, { invoke: "path-call", target })` is explicit. Is
   inference too magic? (Leaning: keep it; one explicit override.)
4. **Org-level contexts:** is there a layer between global and project
   (org context) at launch, or later? Registry chain supports arbitrary depth;
   endpoints currently assume 3 levels.
5. **Result-by-reference for large stream events** (registry sources, script
   results): deferred per discussion; revisit when payloads hurt.
