# The clean-room Iterate Context: API and code-structure walkthrough

> Current as of the onion steps 0–5 (2026-09-02) on `wip/kernel-wayfinder-2026-07-30`.
> Package: `packages/v3/project-worker`. Every interface below is transcribed from
> source; file paths are given so you can check. The design these steps
> implemented is `docs/design-onion-subscriptions-processors.md`; the tutorial
> that builds the same system from nothing is
> `docs/tutorial-build-the-iterate-context.md`.
>
> Older documents in this package (`ARCHITECTURE.md`, `docs/iterate-context.md`,
> `ITX-KERNEL-SHAPE.md`, `docs/state-of-play.md`) describe earlier shapes and
> carry a banner pointing here. Read them as history.

---

## 1. The picture in one screen

Three primitives, one worker, one Durable Object class, and an onion of layers
on top of the stream.

- **The context.** A capability surface you call with dotted paths, in both
  directions: a client calls the project (`itx.kv.get('x')`), and the project
  calls back into the client (a callback you handed over with `provide`).
- **Fetch.** In both directions: any capability can be a web server (reached via
  a terminal `.fetch(request)`), and every outbound fetch from project code is
  egress with `{{secret:project:NAME}}` substitution.
- **The stream.** One append-only log per context. Three inline reduces fold it
  at the commit point (`core`, `capability-table`, `subscriptions`); one
  delivery loop hands every commit to the subscriptions; a processor is a
  Durable Object class hosted as a facet and subscribed to the log.

Every context is one `IterateContextDurableObject`, named by the codec
`{projectId}.iterate{path}` (`prj_demo.iterate/` is the project root,
`prj_demo.iterate/agents/support` a child). The stateless worker at `/api` is
the only place capnweb terminates. It reaches the DO over Workers RPC. Loaded
userspace code runs in Worker Loader isolates or as facets of the DO, and its
entire world is one binding, `env.ITX`.

```mermaid
flowchart LR
  subgraph client["Client: browser / CLI / device (dependency: capnweb only)"]
    c["capnweb session<br/>api.authenticate().projects.get(id)"]
  end
  subgraph edge["project-worker, stateless edge (src/worker.ts)"]
    api["/api → UnauthenticatedSession → Session → ProjectCollection → IterateContext<br/>src/session.ts, src/iterate-context.ts"]
    relay["Parking + stub relay<br/>retained client callbacks"]
    capdoor["/cap?context=…&cap=… fetch lane"]
  end
  subgraph do["IterateContextDurableObject, one per {projectId, path}"]
    stream["Stream: log, offsets, idempotency, waitForEvent"]
    inline["Inline reduces: core, capability-table, subscriptions"]
    delivery["SubscriptionDelivery: push or stream-kept cursor"]
    transport["RpcStubDirectory: pager sockets"]
    facets["Facets: loaded DurableObject classes,<br/>StreamProcessorDurableObject subclasses"]
  end
  subgraph loader["Worker Loader isolates"]
    ep["WorkerEntrypoint: any exported method<br/>env.ITX = ItxEntrypoint"]
  end
  cp["iterate-control-plane<br/>ControlPlaneShell = FALLBACK"]
  c -- "capnweb WS or HTTP batch" --> api
  api -- "Workers RPC" --> do
  capdoor -- "x-itx-cap header" --> do
  transport -. "page over WS" .-> relay
  relay -- "activate: fresh RPC stub" --> transport
  stream -- "onCommit" --> delivery
  delivery -- "processEventBatch(events, range)" --> facets
  delivery -- "(events, range)" --> relay
  do -- "ctx.facets" --> facets
  do -- "LOADER.get" --> loader
  ep -- "env.ITX / globalOutbound" --> do
  do -- "egress: FALLBACK.fetch" --> cp
```

---

## 2. File map

The tree is laid out by primitive, one folder per chapter of the tutorial.

```text
packages/v3/project-worker/
  wrangler.jsonc                 bindings: CONTEXT (DO), LOADER, ITX_KV, SECRETS_KV,
                                 CF_VERSION_METADATA, FALLBACK (service → ControlPlaneShell)
  build-sdk.mjs                  bundles src/sdk/index.ts → generated/processor-sdk.ts (processor.js),
                                 client/demo.tsx → generated/demo-page.ts
  src/
    worker.ts                    THE EDGE. default fetch routes /api /cap /demo /version.
                                 Exports DummyControlPlane, ItxEntrypoint, IterateContextDurableObject.
    session.ts                   UnauthenticatedSession → Session → ProjectCollection (the gate + catalog)
    iterate-context.ts           IterateContext, the client-facing RpcTarget: axioms + sugar; itxFor()
    iterate-context-durable-object.ts  THE CONTEXT DO: stream + inline reduces + delivery + facets +
                                 transport + the fetch doors. One class, ~700 lines.
    itx-entrypoint.ts            ItxEntrypoint: what a loaded worker's env.ITX is
    context/                     chapter 1 — capabilities, called in both directions
      built-ins.ts               the kernel roots: whoami, kv, append, read, cd, fetch, rpcStubs,
                                 facets, subscriptions, load, runScript
      capability-table.ts        the mount table as a reduce-only processor: resolve / route /
                                 provide / revoke / resolveFetch
      expression.ts              the codec: "itx.a.b(1)" ⇄ ["itx","a",["b",1]]
      dispatch.ts                match(path, call), evaluate / apply / invokePath
      dotted-path-proxy.ts       the prototype hop: unknown dotted members fold into ONE
                                 invokeCapability(expression)
      invoke-handle.ts           InvokeHandle + the two brands FacetHandle / RpcStubHandle
      rpc-stub-directory.ts      the live transport table: key → pager socket; presence events
      rpc-stub-relay.ts          edge side: Parking, startRpcStubRelay
      hibernatable-rpc-stub.ts   the stub pager WebSocket + HibernatableRpcStubManager
      worker-loader.ts           confinedWorker, loadConfinedWorker, versionedFacet, WorkerSource
      durable-object-names.ts    DurableObjectNameCodec, resolveContextPath, canonicalName
    fetch/                       chapter 2 — fetch, in both directions
      fetch-capabilities.ts      fetch-shaped capabilities, the x-itx-cap lane, the 101 tunnel
                                 (fenced WORKAROUND, delete-day checklist inside)
    stream/                      chapter 3 — the log and what folds it
      stream.ts                  Stream (the commit pipeline), Context interface, localContext
      events.ts                  StreamEventInput / StreamEvent (zod), defineProcessorContract
      processor.ts               StreamProcessor (the engine), ReduceOnlyProcessor, consumesEvent
      reduce-checkpoint.ts       the one persisted reduce-checkpoint shape
      inline-core.ts             InlineCore: hosts reduce-only processors AT the commit point
      core-processor.ts          the core inline reduce: pause, breaker, incarnation
      subscriptions.ts           the subscriptions table: four events, one reduce, configure/remove
      subscription-delivery.ts   THE ONE DELIVERY LOOP: push to a facet or live stub, else a
                                 stream-kept cursor with a bounded retry ladder
      live-state.ts              LiveState<S>: revision chain + diff → ephemeral delta event
    sdk/                         what userspace imports from "./processor.js"
      index.ts                   the export list
      stream-processor-durable-object.ts  StreamProcessorDurableObject: the processor base class
    lib/                         errors.ts  logs.ts  hash.ts  patch.ts (diff / applyPatch)
    client/
      live-state-store.ts        pure store: seed + deltas → current state
      live-state-client.ts       connectLiveState(itx, { key, door, ... })
      react.tsx                  useLiveState hook
      demo.tsx                   the hosted /demo page
    generated/                   build outputs (committed; rebuilt by build-sdk.mjs)
  __tests__/                     node lane over wrangler createTestHarness (harness.ts boots
                                 the real worker; tests speak capnweb at /api)
  __workers-tests__/             @cloudflare/vitest-plugin lane (runs inside workerd)
  e2e/                           vitest e2e against one shared dev worker
                                 (e2e/support/client.ts IS the client)
  specs/                         Playwright specs
../control-plane-shell/src/index.ts   ControlPlaneShell: fetch (platform secrets → internet),
                                 invokeCapability (stub), default fetch /emit writes into a
                                 project's context
../shared/src/egress.ts          substituteHeaderSecrets({{secret:<scope>:NAME}})
```

Unit-lane tests sit next to their subject (`context/dispatch.test.ts`); the
`*.failing.test.ts` files are pinned defect hunts and live in the folder of the
primitive they attack.

---

## 3. Reaching a context

The client's only dependency is the capnweb fork (`npm:@iterate-com/capnweb`,
imported as `capnweb`). There is no client SDK. The session shape is apps/os's.

```ts
import { newWebSocketRpcSession, newHttpBatchRpcSession } from "capnweb";

using api = newWebSocketRpcSession("wss://<worker>/api");
const itx = api.authenticate().projects.get("prj_demo"); // the project ROOT, path "/"
const agent = itx.cd("/agents/x"); // a context within the project
const inbox = agent.cd("../inbox"); // relative resolves; absolute by convention

// One-shot and socketless (CLI, cron): every call chained off the session flushes as ONE POST.
// A batch session cannot hold live callbacks (nothing outlives the response).
const cli = newHttpBatchRpcSession("https://<worker>/api").authenticate().projects.get("prj_demo");
```

`projects.get` takes a project id only; passing a context name is refused. One
session may hold contexts of many projects; the session's `Parking` is keyed by
canonical context name plus capability path, so they never touch each other's
relays.

Every call has two spellings, and both land on the same door:

```ts
await itx.kv.get("greeting"); // dotted sugar
await itx.invokeCapability("itx.kv.get('greeting')"); // string expression
await itx.invokeCapability(["itx", "kv", ["get", "greeting"]]); // structured expression
```

The dotted sugar works because `IterateContext.prototype` carries a prototype
hop (`src/context/dotted-path-proxy.ts`): a member the class does not declare
becomes an accumulating path, and the final call folds everything into one
`invokeCapability([...])`. The structured form is the only one that can carry
non-JSON args (a callback function, a Date, bytes, a `Request`).

---

## 4. The client-facing interfaces

### 4.1 The gate and the catalog (what `/api` hands you)

`src/session.ts`

```ts
class UnauthenticatedSession extends RpcTarget {
  /** THE introduction door. A no-op today; the one place a real credential check lands
   *  without changing any caller (clients already spell `api.authenticate(creds)`). */
  authenticate(credentials?: unknown): Session;
  /** capnweb calls this when the session ends: every relay parked by this session is torn
   *  down, and every unnamed subscription it made is removed. */
  [Symbol.dispose](): void;
}

class Session extends RpcTarget {
  /** The project catalog. A getter, not a field: capnweb exposes prototype members only. */
  get projects(): ProjectCollection;
}

class ProjectCollection extends RpcTarget {
  /** Pure addressing → that project's ROOT context ("/"). Nothing is minted until the context
   *  is first written to. A project id only; a context name belongs to `cd`. */
  get(projectId: string): IterateContext;
}
```

### 4.2 `IterateContext` (the `itx` you hold)

`src/iterate-context.ts`. The class body is two banded sections. The AXIOMS are
the doors that need the edge (a session-held stub, a live Request, the fold);
everything else is SUGAR: one-line compositions of the axioms that append no
event shape of their own. Every method forwards to the context DO over Workers
RPC; the DO owns every contract.

```ts
class IterateContext extends RpcTarget {
  // ── AXIOMS ──
  /** Another context of the SAME project. Absolute by convention ("/agents/x"); relative
   *  ("agents/x", "../inbox") resolves against this context's path. Pure addressing. */
  cd(path: string): IterateContext;

  /** THE ONE dispatch door. A dotted string or the parsed array. ONE routing rule: a call whose
   *  terminal step is `fetch(request)` with a live Request rides the DO's fetch channel (so a 101
   *  comes back); everything else is `invoke`. */
  invokeCapability(call: ItxExpression): Promise<unknown>;

  // the stream verbs, flattened onto itx
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** afterOffset default 0, limit default 500. Non-minting: reading a virgin stream leaves it virgin. */
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;
  /** Next matching event (default afterOffset = head at call time). 30s default timeout, 120s cap,
   *  rejects with code WAIT_TIMEOUT. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;

  /** Egress through the context: {{secret:project:NAME}} substituted in the DO, then FALLBACK. */
  fetch(request: Request): Promise<Response>;

  /** The live-stub registry, edge half: `provide(value, { key })` parks a capnweb value for the
   *  session (DON'T-PIN relay); `get(key)` / `list()` fold onto the DO's built-in; `close(key)`. */
  get rpcStubs(): RpcStubs;

  // ── SUGAR ──
  /** THE ONE provide door. `target` is EITHER an itx expression (a durable mount:
   *  `capability-provided { path, target }`, string at rest, same-path mounts shadow, newest wins)
   *  OR a live capnweb value (function | RpcTarget): parked under `path` in rpcStubs, then the
   *  ordinary mount `path ⇒ itx.rpcStubs.get('<path>')` is appended. Re-providing a live value
   *  re-parks (reconnect) and appends nothing. */
  provide(
    path: string,
    target: ItxExpression | ProviderStub,
  ): Promise<{ providedAtOffset: number }>;
  /** Pop a mount: by path (the newest winner at that exact path; what it shadowed is restored) —
   *  this also closes THIS session's parked stub under that path — or by identity. */
  revoke(input: string | { providedAtOffset: number }): Promise<void>;

  /** Subscribe a target to the log (the subscriptions layer's ONE event,
   *  `subscription-configured`). `target` is an itx expression whose terminal is callable with
   *  `(events, range)`, or a live callback (parked under `itx.subscriptions.<name>`). No name ⇒
   *  `sub-<8hex>`, removed when the session ends. Identical re-subscribe appends nothing. */
  subscribe(input: {
    name?: string;
    target: ItxExpression | ProviderStub;
    consumes?: string[];
  }): Promise<{ name: string }>;
  /** Appends `subscription-removed`; a stream-kept cursor goes with it; this session's parked
   *  callback under the name is closed. */
  unsubscribe(name: string): Promise<void>;

  /** Host `className` (a StreamProcessorDurableObject subclass exported by `source`) as the facet
   *  named `name` and subscribe its `processEventBatch`. Literally
   *  subscribe({ name, target: itx.load(source).getDurableObjectClass(className).get(name).processEventBatch, consumes }). */
  enableProcessor(
    name: string,
    ref: { source: WorkerSource; className: string; consumes?: string[] },
  ): Promise<{ name: string }>;
  /** unsubscribe(name) + delete the facet, storage included: a re-enable is a clean rebuild. */
  disableProcessor(name: string): Promise<void>;

  // ── everything else ──
  /** Any undeclared dotted access folds into invokeCapability: itx.kv.get(k), itx.cd('/x').read(),
   *  itx.facets.get('tally').snapshot(), itx.myCap.hello(), itx.site.fetch(request). */
  [dotted: string]: unknown;
}
```

Semantics worth knowing:

- `provide` with a live value parks the stub **first**, then appends the mount,
  so the event records a capability that can already serve. If the DO refuses
  the mount, the relay is disposed again.
- Presence (which live keys have an open transport) is `itx.rpcStubs.list()`,
  never the capability table. The table is pure data.
- Mounts carry nothing but `{ path, target }`. Delivery policy, processor
  hosting, and lanes are gone from the mount event; those live in the
  subscriptions layer (section 6).

### 4.3 The types those methods use

`src/context/expression.ts`

```ts
/** One step: a property read, or a call with JSON args. */
type Step = string | [method: string, ...args: unknown[]];
/** A call written as data: the scope root ("itx") then steps. */
type Expression = Step[];
/** Either codec half: "itx.facets.get('core')" or ["itx","facets",["get","core"]]. */
type ItxExpression = string | Expression;
/** A mount's left side: dotted names only, no calls. */
type CapabilityPath = string[];
```

`src/stream/events.ts`

```ts
type StreamEventInput = {
  /** Convention: events.iterate.com/<domain>/<fact>. Any non-empty string is accepted. */
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Provenance, stamped by the engine when a processor appends. */
  source?: {
    processor?: {
      slug: string;
      version: string;
      whileProcessing?: { offset: number; type: string };
    };
  };
  /** Same key + same body → the existing event is returned; different body → IDEMPOTENCY_CONFLICT. */
  idempotencyKey?: string;
  /** Rides to subscribers that name its type, takes an offset, is NEVER persisted and costs NO
   *  write. Cannot carry an idempotencyKey. */
  ephemeral?: true;
};

/** A committed event: the input plus the identity the stream assigned. */
type StreamEvent = StreamEventInput & { offset: number; createdAt: string; path: string };

type WaitForEventFilter = { type?: string; afterOffset?: number; timeoutMs?: number };

/** The contiguity proof a delivery carries: the half-open offset window (after, through]. */
type ScannedRange = { after: number; through: number };
```

`src/context/rpc-stub-relay.ts`

```ts
/** A live capnweb value you hand to provide/subscribe: a function or an RpcTarget instance. */
type ProviderStub = unknown;
```

### 4.4 The built-in roots (what `itx.<root>` resolves to on the DO)

`src/context/built-ins.ts`. These are the kernel. A call `itx.<root>...` whose
root is one of these resolves **directly**, before the capability table is
consulted, so they cannot be shadowed. Everything else goes to the table
(section 9.1).

```ts
interface BuiltInScope {
  /** Identify this context. */
  whoami(): { projectId: string; path: string };

  /** Project-prefixed durable key/value. The `${projectId}:` prefix IS the isolation. */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };

  /** This context's log. Same commit pipeline as IterateContext.append / read. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;

  /** Another context of the same project, routed through ITS table. Same resolver as the edge cd.
   *  Own path → same isolate; anything else → a Workers-RPC call to that DO. */
  cd(path: string): ContextHandle;

  /** Egress: {{secret:project:NAME}} substituted, then FALLBACK — the same terminal a loaded
   *  worker's globalOutbound lands on. */
  fetch(request: Request): Promise<Response>;

  /** The live rpc-stub REGISTRY — physical, never event-sourced. `get(key)` is how a mount names a
   *  parked value; offline ⇒ CONNECTION_OFFLINE at call time. `list()` is presence. */
  rpcStubs: {
    get(key: string): RpcStubHandle;
    list(): string[];
  };

  /** Address a facet that is ALREADY RUNNING by name (a processor, a named instance); reaches
   *  any method the facet's object exposes. `delete` removes it, storage included. */
  facets: { get(name: string): FacetHandle; delete(name: string): void };

  /** The subscriptions layer, read: the table (an inline reduce) joined with the stream-kept cursors. */
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };

  /** Load code → a WORKER, then pick the host (mirror of Cloudflare's Worker Loader). */
  load(source: WorkerSource): {
    /** A stateless WorkerEntrypoint isolate: ANY method it exports, by name. `props` is
     *  Cloudflare's WorkerStubEntrypointOptions.props, read back as this.ctx.props. */
    getEntrypoint(className?: string, opts?: { props?: unknown }): EntrypointHandle;
    /** A DurableObject class hosted as a durable FACET of this context (own storage).
     *  `.get()` with no name is named by the class. */
    getDurableObjectClass(className: string): { get(name?: string): FacetHandle };
  };

  /** Sugar for a bare lambda string: wraps it into a WorkerEntrypoint and runs
   *  load(...).getEntrypoint().run(...). The lambda receives (itx, ...args). */
  runScript(script: string, ...args: unknown[]): Promise<unknown>;
}

/** Where code comes from: an itx expression that evaluates to module source(s), a bare
 *  string, or inline files. "itx.kv.get('src/greet.js')" is the common shape. */
type WorkerSource = string | Expression | { type: "inline"; files: Record<string, string> };

type SubscriptionListEntry = {
  name: string;
  target: string; // the expression, printed
  consumes?: string[];
  configuredAtOffset: number;
  /** Present ONLY when the stream keeps the cursor (a target that cannot own its progress). */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
};

// ContextHandle / EntrypointHandle are InvokeHandle (context/invoke-handle.ts): a real RpcTarget
// whose unknown dotted members fold into one dispatch, so the chain pipelines over every lane.
// FacetHandle and RpcStubHandle are InvokeHandle SUBCLASSES — brands the delivery loop reads
// (section 6). Spell whatever the target exposes.
```

Two rules that follow from the resolver:

- A provided target must be rooted at `itx` (`itx.provide("itx.greet", "itx.kv.get")`
  is legal; `"kv.get"` is rejected). Userspace can only reach a root by recursing
  through the `itx` symbol.
- The path `itx` by itself is the shortest legal mount path and acts as a
  default route: it claims any call whose root is not a built-in. This is how
  ancestry is spelled (section 9.4).

### 4.5 Facets you can address, and the three always-on inline reduces

`itx.facets.get(name)` walks the facet's object. For a processor facet the
doors are those of `StreamProcessorDurableObject` (section 5.3): `snapshot`,
`liveSnapshot`, `waitUntilProcessed`, `wake`, `processEventBatch`. For a loaded
`DurableObject` class hosted as a facet, every method the class defines is
reachable the same way, and a terminal `.fetch(request)` rides the facet's own
fetch channel (so a 101 works).

Three reduce-only processors are always on and run **inline** in the commit
transaction. They have no facet, but their snapshots are exposed through the
same door, and their names are reserved (a subscription may not take them):

```ts
// itx.facets.get('core').snapshot().state
type CoreState = {
  incarnation?: number; // grows across hibernation wakes
  paused: { reason: string } | null;
  breaker: { capacity: number; refillPerSecond: number; tokens: number; lastAtMs: number } | null;
};

// itx.facets.get('capability-table').snapshot().state   (contract 5.0.0)
type CapabilityTable = {
  mounts: Array<{
    path: string[]; // ["itx","greet"]
    target: Expression; // always present; a live stub's is itx.rpcStubs.get('<path>')
    providedAtOffset: number; // the mount's identity
  }>;
};

// itx.facets.get('subscriptions').snapshot().state
type SubscriptionsState = {
  subscriptions: Record<
    string,
    {
      target: Expression;
      consumes?: string[];
      configuredAtOffset: number;
      halted?: { afterOffset: number; attempts: number; error?: string };
      resumed?: { afterOffset?: number; atOffset: number };
    }
  >;
};
```

There is no separate status verb anywhere: presence is `itx.rpcStubs.list()`,
enabled processors are `itx.subscriptions.list()` entries whose target ends in
`.processEventBatch`, and a halted delivery is a `halted` field.

---

## 5. Writing code that runs inside a context

A loaded isolate receives exactly two things: `env.ITX` (a stub of
`ItxEntrypoint`, section 8) and a `globalOutbound` that routes every `fetch()`
through the context's egress. The processor SDK is injected as `./processor.js`
into every load, so `import { ... } from "./processor.js"` always works.

### 5.1 A stateless entrypoint

```ts
// stored with itx.kv.put("src/greet.js", ...)
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Greeter extends WorkerEntrypoint {
  async run(name) {
    const itx = await this.env.ITX.get(); // the real IterateContext scope, pipelinable
    await itx.append({ type: "greeted", payload: { name } });
    return `hi ${name}`;
  }
  async fetch(request) {
    return new Response("hello");
  } // makes this a fetch-shaped capability
}
```

```ts
await itx.load("itx.kv.get('src/greet.js')").getEntrypoint().run("jonas");
await itx.provide("itx.greet", "itx.load(\"itx.kv.get('src/greet.js')\").getEntrypoint()");
await itx.greet.run("jonas"); // now reachable by name, through the table
const res = await itx.greet.fetch(new Request("https://x/")); // its fetch: the terminal-fetch rule

// the bare-lambda sugar
await itx.runScript("async (itx, n) => (await itx.kv.get('counter')) ?? n", 0);
```

A stateless entrypoint cannot own progress, so subscribing one is the
at-least-once case (section 6):

```ts
await itx.provide("itx.digest", "itx.load(\"itx.kv.get('src/digest.js')\").getEntrypoint()");
await itx.subscribe({ name: "digest", target: "itx.digest.processEventBatch", consumes: ["mark"] });
```

### 5.2 A durable class hosted as a facet

```ts
// stored with itx.kv.put("src/counter.js", ...)
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async bump() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}
```

```ts
const src = "itx.kv.get('src/counter.js')";
await itx.load(src).getDurableObjectClass("Counter").get("c1").bump(); // 1
await itx.facets.get("c1").bump(); // 2, same instance, no source
await itx.provide(
  "itx.counter",
  `itx.load(${JSON.stringify(src)}).getDurableObjectClass('Counter').get('c1')`,
);
await itx.counter.bump(); // 3
```

A facet keeps its storage across restarts; a source change restarts it in
place (`versionedFacet`). The class is minted with `props: { contextName, name }`,
readable as `this.ctx.props`. A busy stateful facet pins its context DO awake,
an accepted trade. Facets have no alarms (workerd#6810); a future "append at
this time" primitive on the context is the planned replacement, not a proxy.

### 5.3 A stream processor

A processor is a `DurableObject` subclass, hosted exactly like the counter
above, whose base class knows how to fold the log. `src/sdk/index.ts` is the
whole userspace SDK, bundled into `./processor.js`:

```ts
export { StreamProcessorDurableObject, type StreamProcessorProps, type ItxBinding };
export { defineProcessorContract, StreamEvent, StreamEventInput, jsonEqual }; // + processor types
export { z } from "zod";
export { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
export { applyPatch, diff, type PatchOp };
export { LiveState, type LiveStateSink };
```

The base class, `src/sdk/stream-processor-durable-object.ts`:

```ts
type StreamProcessorProps = { contextName: string; name: string };

abstract class StreamProcessorDurableObject<
  State,
  Env extends { ITX: ItxBinding } = { ITX: ItxBinding },
> extends DurableObject<Env, StreamProcessorProps> {
  abstract readonly contract: ProcessorContract<State>;

  // ── the three hooks you override ──
  /** Pure. Return the NEXT state (a new object), or null/undefined to keep the current. */
  protected reduce(args: ReduceArgs<State>): State | null | undefined;
  /** Side effects. Synchronous by design; register async work via the two helpers in args. */
  protected processEvent(args: ProcessEventArgs<State>): undefined;
  /** The live projection clients see. Default: the reduced state verbatim. */
  protected projectLiveState(state: State): unknown;

  // ── what you reach ──
  protected readonly context: { projectId: string; path: string; name: string }; // from ctx.props
  protected readonly name: string; // facet name = subscription name = .get(name)
  protected get itx(): Promise<unknown>; // the owning context's scope (env.ITX.get())
  protected get stream(): ProcessorStream; // append / read through env.ITX
  protected publishLiveState(): void;
  protected idempotencyKey(key: string, whileProcessing?: StreamEvent): string;

  // ── the doors the delivery loop and itx.facets.get(name) reach ──
  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void>;
  wake(): Promise<void>;
  snapshot(): Promise<{ offset: number; state: State }>;
  liveSnapshot(): Promise<{ rev: number; state: unknown }>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void>;
  // NEVER define alarm(): facets have none.
}
```

The engine underneath (`src/stream/processor.ts`) is unchanged in shape and is
what the base class's hooks delegate to:

```ts
type ProcessorContract<State> = {
  slug: string;
  /** Bumping re-reduces from offset 0 (reduce only; side effects never re-run). */
  version: string;
  description?: string;
  /** Types to react to, or "*" for every DURABLE event. Ephemerals only when named. */
  consumes: readonly string[];
  /** What this processor's own append may emit. */
  emits: readonly string[];
  initialState: () => State;
};

/** zod schemas in, ProcessorContract + buildEvent out. stateSchema must parse {}. */
function defineProcessorContract<S extends z.ZodType>(c: {
  slug: string;
  version: string;
  description: string;
  stateSchema: S;
  events: Record<string, { description?: string; payloadSchema: z.ZodType }>;
  consumes: readonly string[];
  emits: readonly string[];
}): ProcessorContract<z.infer<S>> & { stateSchema: S; buildEvent(e): StreamEventInput };

type ReduceArgs<State> = { event: StreamEvent; state: State };
type ProcessEventArgs<State> = {
  /** null on the eventless at-head pass. */
  event: StreamEvent | null;
  state: State;
  previousState: State;
  /** Validated against `emits`, provenance-stamped. */
  append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>;
  /** Hold the cursor until work settles (FIFO with other blockers of the same event). */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** Fire-and-forget; may overtake later events; outcome must be state-recoverable. */
  runInBackground: (work: () => Promise<unknown>) => void;
  delivery: { caughtUp: boolean };
};

/** Reduce-only: contract + reduce, no processEvent. Hostable INLINE at the commit point. */
type ReduceOnlyProcessor<State> = {
  contract: ProcessorContract<State>;
  reduce(args: ReduceArgs<State>): State | null | undefined;
};
```

A complete userspace processor (this is the one the `/demo` page loads):

```ts
import { StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";

const contract = defineProcessorContract({
  slug: "presence",
  version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs.",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  events: {},
  consumes: ["tick", "poke"],
  emits: [],
});

export class Presence extends StreamProcessorDurableObject {
  contract = contract;
  #lastPokeMs = 0;
  reduce({ event, state }) {
    if (event.type === "tick") return { ...state, ticks: state.ticks + 1 };
  }
  processEvent({ event }) {
    if (event?.type === "poke") {
      this.#lastPokeMs = Date.now();
      this.publishLiveState();
    }
  }
  projectLiveState(state) {
    return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs };
  }
}
```

```ts
await itx.kv.put("src/presence.js", PRESENCE_SRC);
await itx.enableProcessor("presence", {
  source: "itx.kv.get('src/presence.js')",
  className: "Presence",
});
await itx.append({ type: "tick" });
await itx.facets.get("presence").snapshot(); // { offset, state: { ticks: 1 } }
await itx.facets.get("presence").liveSnapshot(); // { rev, state: { ticks: 1, lastPokeMs: 0 } }
await itx.subscriptions.get("presence"); // { name, target: "itx.load(...).getDurableObjectClass('Presence').get('presence').processEventBatch", ... }
await itx.disableProcessor("presence"); // removes the subscription, deletes the facet + storage
```

How it is hosted: `enableProcessor` is nothing but a subscription whose target
is `itx.load(source).getDurableObjectClass(className).get(name).processEventBatch`.
The DO loads your module plus `processor.js` into one isolate, takes the class
by name, and hosts it as a facet named `name` with `props: { contextName, name }`.
Every commit the delivery loop evaluates the target, sees a `FacetHandle`, and
pushes `processEventBatch(events, range)` to it; the engine inside the facet
keeps its own checkpoint and gap-repairs from the log when a range does not
chain. There is no runner module and no host-side processor registry.

### 5.4 Live state for mini-apps, and the client side

A durable class that is not a processor can still publish live state:

```ts
import { DurableObject } from "cloudflare:workers";
import { LiveState } from "./processor.js";

export class Chatroom extends DurableObject {
  #live = new LiveState(this.env.ITX, "chat", { messages: [] }); // sink, key, initial
  state() {
    return this.#live.snapshot();
  } // the seed door: { rev, state }
  post(who, text) {
    const cur = this.#live.get();
    this.#live.set({ messages: [...cur.messages, { who, text }] }); // diff → rev+1 → ephemeral delta
  }
}
```

```ts
class LiveState<S> {
  constructor(
    sink: {
      append(e: { type: string; ephemeral?: true; payload?: Record<string, unknown> }): unknown;
    },
    key: string,
    initial: S,
  );
  get(): S;
  snapshot(): { rev: number; state: S };
  /** Diff held → next; on a real change bump rev and append
   *  events.iterate.com/live-state/changed { key, from, to, patch } (ephemeral). Lossy by contract. */
  set(next: S): void;
}
```

A live-state watcher is an ordinary subscription that names the delta type:
`consumes: ["events.iterate.com/live-state/changed"]` (every key's deltas
arrive; filter `payload.key` client-side). `src/client/live-state-client.ts`
and `src/client/react.tsx` do exactly that:

```ts
function connectLiveState<S>(itx: LiveItx, opts: {
  key: string;
  name?: string;
  door: () => Promise<{ rev: number; state: S }>;   // e.g. () => itx.facets.get('presence').liveSnapshot()
  onResync?: (result: "healed" | Error) => void;
}): Promise<{ store: LiveStateStore<S>; dispose(): Promise<void> }>;

function useLiveState<S>(itx, { key, name?, door }): { value: S | undefined; rev: number | null; status: "connecting" | "live" | "error"; error?: string };
```

Subscribe happens before the first seed; a delta whose `from` does not match
the held rev triggers one single-flight re-read of the door.

### 5.5 Event conventions, control events, and the layer events

- Type strings follow `events.iterate.com/<domain>/<fact>`; anything non-empty
  is accepted, and short bare types like `"tick"` are fine in tests.
- `idempotencyKey`: same key and same body returns the existing event; a
  different body throws. Processors derive keys with `this.idempotencyKey(...)`.
- `ephemeral: true`: takes an offset from the shared sequence, is delivered to
  subscribers that name its type, is never persisted, never reaches an inline
  reduce, and **costs no write**: an ephemeral-only append does no transaction
  and does not move the high-water mark. The contract that buys this: an
  ephemeral's offset is unique within an incarnation; a later incarnation
  resumes from the last durable mark, and `stream/woken` (durable, first batch
  of each incarnation) marks the boundary. Every persisted checkpoint in the
  package advances only on a batch that carried a durable.
- Stream control is ordinary events read by the inline core reduce:

```ts
await itx.append({ type: "events.iterate.com/stream/paused", payload: { reason: "maintenance" } });
await itx.append({ type: "events.iterate.com/stream/resumed" });
await itx.append({
  type: "events.iterate.com/stream/breaker-configured",
  payload: { capacity: 100, refillPerSecond: 1 },
});
await itx.append({ type: "events.iterate.com/stream/breaker-configured" }); // empty payload = breaker off
```

- The layers' own events, all plain appends you may read or write yourself:

| Event                                                           | Payload                                   | Written by                                         |
| --------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| `events.iterate.com/capability-table/capability-provided`       | `{ path, target }` (both strings)         | `provide`                                          |
| `events.iterate.com/capability-table/capability-revoked`        | `{ providedAtOffset }`                    | `revoke`                                           |
| `events.iterate.com/stream/subscription-configured`             | `{ name, target, consumes? }`             | `subscribe` / `enableProcessor`                    |
| `events.iterate.com/stream/subscription-removed`                | `{ name }`                                | `unsubscribe` / `disableProcessor`                 |
| `events.iterate.com/stream/subscription-delivery-halted`        | `{ name, afterOffset, attempts, error? }` | the delivery loop, after the ladder                |
| `events.iterate.com/stream/subscription-delivery-resumed`       | `{ name, afterOffset? }`                  | you, to un-halt and optionally seek                |
| `events.iterate.com/rpc-stub/attached` / `detached` (ephemeral) | `{ key }`                                 | the transport table, first/last transport of a key |
| `events.iterate.com/live-state/changed` (ephemeral)             | `{ key, from, to, patch }`                | `LiveState.set`                                    |
| `events.iterate.com/stream/woken`                               | `{ incarnation }`                         | the stream, first commit of an incarnation         |

Refusals surface as coded errors: `STREAM_PAUSED`, `STREAM_BREAKER_OPEN`,
`IDEMPOTENCY_CONFLICT`, `EPHEMERAL_IDEMPOTENCY_KEY`, `NO_CAPABILITY_MATCH`,
`NO_FACET`, `CONNECTION_OFFLINE`, `WAIT_TIMEOUT`, `NOT_A_METHOD`.

---

## 6. Subscriptions and the one delivery loop

`src/stream/subscriptions.ts` is the table (four events, one reduce,
`configure` / `remove` doors that append idempotently against the current
state). `src/stream/subscription-delivery.ts` is the loop, run from the
stream's post-commit hook. For every subscription it filters the batch by
`consumes`, evaluates the target expression, and asks the **value** what it is:

- A `FacetHandle` or an `RpcStubHandle` **owns its progress**: a facet keeps its
  own checkpoint and gap-repairs from the log; a live client owns its offset and
  heals a range gap with `read(through)`. It gets a fire-and-forget push of
  `(events, { after, through })`, serialized per subscription. A stalled tab
  never blocks the chain; `CONNECTION_OFFLINE` is swallowed. No cursor row.
- Anything else (a Worker-Loader entrypoint, a sibling context via `cd`, a
  mount alias to one) cannot own progress, so **the stream keeps a cursor**:
  at-least-once, the awaited call is the ack, one bounded retry ladder
  (1s·2ⁿ, ≤30 min, 15 attempts; an error with `retryable: false` halts at once),
  then a `subscription-delivery-halted` fact. Retries ride the DO's own alarm.
  The cursor lives in memory and is written to kv only when a delivered batch
  contained a durable event.

Nothing reads a "kind" off an event: the kind is the evaluated value's brand,
minted by the built-in that produced it, so an alias classifies correctly
because it evaluates to the same handle. `consumes` has one rule
(`consumesEvent`, shared with the engine and the inline core): absent or `"*"`
means every durable event; naming a type opts it in, ephemerals included.

```ts
// a live tab
const { name } = await itx.subscribe({
  target: (events, range) => render(events),
  consumes: ["mark"],
});
// the stateless worker (stream-kept cursor)
await itx.subscribe({ name: "digest", target: "itx.digest.processEventBatch", consumes: ["mark"] });
(await itx.subscriptions.get("digest")).cursor; // { confirmedOffset, attempt, nextAttemptAtMs? }
// recovery from a halt, or a seek
await itx.append({
  type: "events.iterate.com/stream/subscription-delivery-resumed",
  payload: { name: "digest", afterOffset: 40 },
});
```

Per subscription the loop remembers the last `through` it handed over, so a
batch the filter skipped still rides inside the next delivered range and a push
subscriber's chain stays contiguous. A cursor target additionally receives
ephemerals when it is caught up (they ride the pushed batch), never when it is
behind.

---

## 7. The Durable Object's Workers-RPC surface (host level)

`src/iterate-context-durable-object.ts`. You do not call this directly as a
client, but this is the skeleton everything above forwards to. `IterateContext`
calls the verbs; the edge relay calls the transport verbs; facets reach the
context only through `env.ITX`.

```ts
class IterateContextDurableObject extends DurableObject<BuiltInsEnv> {
  // ── the stream ──
  append(...inputs: StreamEventInput[]): Promise<StreamEvent[]>;
  read(
    afterOffset?: number,
    limit?: number,
  ): { events: StreamEvent[]; scannedThroughOffset: number };
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;

  // ── dispatch: ONE door ──
  /** parse → built-in-first / longest-path mount → evaluate → replay remainder. */
  invoke(call: ItxExpression, depth?: number): Promise<unknown>;

  // ── the capability table (pure data) ──
  provideCapability(input: {
    path: string;
    target: ItxExpression;
  }): Promise<{ providedAtOffset: number }>;
  revokeCapability(input: { providedAtOffset?: number; path?: string }): Promise<void>;

  // ── the subscriptions table ──
  configureSubscription(input: {
    name: string;
    target: ItxExpression;
    consumes?: string[];
  }): Promise<{ name: string; configuredAtOffset: number }>;
  removeSubscription(name: string): Promise<void>;

  // ── facets ──
  /** The generic facet door: resolve the facet locally (a name, or load + class + name), walk
   *  `path`, apply `args`. Facet stubs are non-transferable, so the walk happens here. */
  facetInvoke(
    ref: string | { source?: unknown; className?: string; name?: string },
    path: string[],
    args: unknown[],
  ): Promise<unknown>;
  deleteFacet(name: string): void;

  // ── doors the edge relay calls (the hibernatable stub dance) ──
  rpcStubAttach(input: { path: string }): { transportId: string };
  rpcStubActivate(input: { transportId: string; invoker: unknown }): unknown;
  /** In-memory socket facts { stubs, pagedIn, pagesPending, dormant }. Not on the itx surface. */
  transportState(): Record<string, unknown>;

  // ── native platform entry points ──
  /** Ordered partial-fetch walk: x-itx-stub-pager (pager WS) → x-itx-fetch-upgrade (live-cap 101
   *  leg) → x-itx-cap (the fetch lane) → else EGRESS: {{secret:project:NAME}} substitution then
   *  FALLBACK.fetch. */
  fetch(request: Request): Promise<Response>;
  /** The cursor retry pump, then idle quiesce (aborts idle facets, disposes paged-in stubs). */
  alarm(): Promise<void>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
  webSocketClose(ws: WebSocket, code: number, reason: string): void;
  webSocketError(ws: WebSocket): void;
}
```

What one context reaches another through, `src/stream/stream.ts`:

```ts
/** What itx.cd(path) routes through. A sibling DO stub satisfies it structurally; the own DO
 *  is wrapped by localContext(). */
interface Context {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;
  invoke(call: ItxExpression): Promise<unknown>;
}
```

---

## 8. Worker entrypoints, DO classes, bindings

| Export (from `src/worker.ts`) | Kind                                                                                   | Surface                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`                     | module worker `fetch`                                                                  | `/api` (capnweb: WS or one-shot HTTP batch → `UnauthenticatedSession`), `/cap?context=<id or name>&cap=<expr>` (fetch lane → DO with `x-itx-cap`; 400 without both), `/demo`, `/version` |
| `IterateContextDurableObject` | Durable Object (binding `CONTEXT`)                                                     | section 7                                                                                                                                                                                |
| `ItxEntrypoint`               | `WorkerEntrypoint`, minted via `ctx.exports.ItxEntrypoint({ props: { contextName } })` | `get()` → the real `IterateContext` scope; `append`, `read`, `waitForEvent`; `fetch` (egress)                                                                                            |
| `DummyControlPlane`           | `WorkerEntrypoint`                                                                     | `fetch` = bare `fetch(request)`. Bound as `FALLBACK` only in solo/test config                                                                                                            |

Injected into loaded isolates, never deployed as a class:

| Module         | Source                                 | Role                                                   |
| -------------- | -------------------------------------- | ------------------------------------------------------ |
| `processor.js` | `src/sdk/index.ts` via `build-sdk.mjs` | the userspace SDK (section 5.3), present in every load |

The other package, `packages/v3/control-plane-shell`:

```ts
class ControlPlaneShell extends WorkerEntrypoint<Env> {
  /** Egress terminal: substitute {{secret:platform:NAME}} then fetch the internet. */
  fetch(request: Request): Promise<Response>;
  /** Stand-in. Only "itx.auth.gate" answers. Nothing in project-worker calls this yet. */
  invokeCapability(callPath: string, args?: unknown[]): Promise<unknown>;
}
// default fetch: GET /emit?projectId=&path=&type= appends into a project's context (outer → inner)
```

Bindings (`wrangler.jsonc`):

| Binding               | Kind                                                | Used for                                                      |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `CONTEXT`             | DO namespace → `IterateContextDurableObject`        | every context, `getByName(codec)`                             |
| `LOADER`              | Worker Loader                                       | `itx.load`, `runScript`, processors                           |
| `ITX_KV`              | KV                                                  | `itx.kv`, keys prefixed `${projectId}:`                       |
| `SECRETS_KV`          | KV                                                  | egress substitution, keys `secret:${projectId}:${name}`       |
| `CF_VERSION_METADATA` | version metadata                                    | folded into loader cacheKeys so a deploy mints fresh isolates |
| `FALLBACK`            | service → `iterate-control-plane#ControlPlaneShell` | the egress terminal                                           |

The loader cacheKey is `${kind}:${deploy}:${owner}:${contentHash}`. Every
distinct key is a billed dynamic worker, so nothing per request may ever enter
it.

---

## 9. Four flows

### 9.1 A dotted call

```mermaid
sequenceDiagram
  participant C as client (capnweb)
  participant E as IterateContext (edge)
  participant D as IterateContextDurableObject
  participant T as CapabilityTableProcessor
  C->>E: itx.greet.run("jonas")
  Note over E: prototype hop folds to<br/>["itx","greet",["run","jonas"]]
  E->>D: invoke(expression)   (Workers RPC)
  D->>T: resolve(tableState, expression)
  alt root is a built-in (kv, cd, load, facets, rpcStubs, ...)
    T->>T: apply against { ...builtIns, itx }
  else userspace mount
    T->>T: route: longest matching path, ties → newest
    T->>T: evaluate target against { itx }, replay remainder
  end
  T-->>D: value (or NO_CAPABILITY_MATCH)
  D-->>E: value
  E-->>C: value
```

The `itx` symbol inside a target is an `InvokeHandle` that re-enters `resolve`
with the depth carried, so alias mounts compose (`itx.greet ⇒ itx.load(...).getEntrypoint()`,
`itx.hello ⇒ itx.greet.run`). A terminal `.fetch(request)` takes the DO's fetch
channel instead of `invoke`, with the capability in `x-itx-cap`; the table's
`resolveFetch` walks the same rows.

### 9.2 A live capability and the pager

```mermaid
sequenceDiagram
  participant C as client (capnweb)
  participant E as edge relay (Parking)
  participant D as context DO
  C->>E: itx.provide("itx.robot", robotObject)
  E->>D: rpcStubAttach({ path: "itx.robot" })
  D-->>E: { transportId }
  E->>D: open stub-pager WebSocket (x-itx-stub-pager, carries transportId)
  Note over D: rpc-stub/attached { key: "itx.robot" } (ephemeral)
  E->>D: provideCapability({ path: "itx.robot", target: "itx.rpcStubs.get('itx.robot')" })
  Note over D: capability-provided { path, target } appended — pure data
  D-->>C: { providedAtOffset }
  Note over D: ... idle: DO hibernates, socket survives ...
  C->>D: itx.robot.move(10)   (via edge, invoke)
  D->>E: { type: "page" } down the pager socket
  E->>D: rpcStubActivate({ transportId, invoker })   fresh Workers-RPC stub
  D->>E: invoker.invoke(["move"], [10])
  E->>C: robotObject.move(10)   (capnweb, same session)
  C-->>D: result
  Note over D: stub kept warm while traffic flows,<br/>disposed at idle quiesce; a page gets it back
```

The DO never retains a client stub across idle, so any number of connected
clients leave it free to hibernate. Presence is `itx.rpcStubs.list()`; a key
gaining its first transport appends `rpc-stub/attached`, losing its last
appends `rpc-stub/detached` (both ephemeral; a replaced transport emits
neither). The mount stays in the table when the socket closes; a call then
fails with `CONNECTION_OFFLINE` until the client re-provides, which re-parks and
appends nothing.

### 9.3 A commit

```mermaid
sequenceDiagram
  participant A as caller (itx.append)
  participant D as context DO
  participant S as Stream
  participant I as inline reduces (core, capability-table, subscriptions)
  participant L as SubscriptionDelivery
  participant F as facet (processor)
  participant P as live stub (tab)
  participant W as stateless worker (cursor)
  A->>D: append(events)
  D->>S: append(events)
  S->>I: admit: core state (paused? breaker tokens?)
  alt every event ephemeral
    S->>S: offsets from memory — no transaction, no mark write
  else
    S->>S: idempotency, offsets, chunk large bodies, high-water mark — one transaction
    S->>I: reduce fresh DURABLE events in the same transaction, checkpoint on change
  end
  S-->>D: committed StreamEvent[]
  D->>L: onCommit(events, after, through)
  L->>L: per subscription: consumes filter, evaluate target, read the brand
  L->>F: processEventBatch(events, range)   FacetHandle: awaited push
  L->>P: (events, range)                    RpcStubHandle: fire-and-forget push
  L->>W: processEventBatch(events, range)   else: from the stream-kept cursor, awaited = ack
  I->>P: live-state/changed deltas for changed inline states
  D-->>A: StreamEvent[]
```

`range` is `{ after, through }`; a subscriber whose chain has a hole heals
with `read(afterOffset)`. A subscriber whose `consumes` skipped a batch still
sees the skipped span in its next range.

### 9.4 Ancestry as a default route

There is no parent link. A child spells one by mounting the shortest path with
a target in the parent:

```ts
const child = itx.cd("/agents/support");
await child.provide("itx", "itx.cd('/')"); // misses go to the project root
await child.someRootCapability.doThing(1); // not a built-in, no longer match → default route
```

```mermaid
sequenceDiagram
  participant C as child DO (/agents/support)
  participant R as root DO (/)
  Note over C: invoke(["itx","someRootCapability",["doThing",1]])
  C->>C: "someRootCapability" is not a built-in → route → ["itx"] wins (remainder = whole tail)
  C->>C: evaluate target itx.cd("/") → built-in cd → InvokeHandle for the root
  C->>R: invoke(["itx","someRootCapability",["doThing",1]])   (one Workers-RPC hop)
  R->>R: resolve against the ROOT's table (its own default route may forward again)
  R-->>C: value
```

Built-ins never fall through (`whoami`, `kv`, `append`, `read` stay the
child's). Nothing appends this mount for you today. The recursion-depth guard
does not survive a `cd` hop, so do not mount `itx ⇒ itx.cd('/')` on the root
itself.

---

## 10. Vocabulary

| Word               | Meaning here                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| context            | one `IterateContextDurableObject`, named `{projectId}.iterate{path}`; a stream + a capability table + a subscriptions table + transport            |
| session            | what `/api` hands you: `UnauthenticatedSession → authenticate() → Session → projects.get(id)`; a session is not a context, it is how you reach one |
| capability path    | dotted names starting with `itx`, no calls: `itx.greet`                                                                                            |
| mount              | a row in the capability table, `{ path, target, providedAtOffset }`, created by a `capability-provided` event; nothing else rides it               |
| shadow stack       | same-path mounts stack; newest wins; revoke pops one                                                                                               |
| default route      | a mount at the bare path `itx`; claims any non-built-in call                                                                                       |
| built-in           | a root of `BuiltInScope`; resolved before the table; unshadowable                                                                                  |
| expression         | `["itx", ...steps]` or its string form; the persisted currency of every target                                                                     |
| InvokeHandle       | a pipelinable `RpcTarget` returned mid-chain (`cd`, `load(...)`); `FacetHandle` and `RpcStubHandle` are its two brands                             |
| rpc stub           | a live capnweb value parked for a session under a key; `itx.rpcStubs.get(key)` is how a mount or a subscription names it; presence is `list()`     |
| subscription       | a named row `{ target, consumes? }` in the subscriptions table; delivered every commit by the one loop                                             |
| push               | delivery to a target that owns its progress (a facet, a live stub): fire-and-forget `(events, range)`                                              |
| stream-kept cursor | delivery to a target that cannot own progress: at-least-once from a kv cursor, retry ladder, halt fact                                             |
| processor          | a `StreamProcessorDurableObject` subclass hosted as a facet and subscribed to `processEventBatch`; `enableProcessor` is the sugar                  |
| inline reduce      | a reduce-only processor run inside the commit transaction: `core`, `capability-table`, `subscriptions`                                             |
| facet              | a workerd `ctx.facets` child of the DO with its own storage; hosts loaded `DurableObject` classes, processors included                             |
| scanned range      | `{ after, through }` delivered with each batch; the contiguity proof subscribers chain                                                             |
| ephemeral          | an event that takes an offset but is never stored and costs no write; delivered only to subscribers that name its type                             |
| incarnation        | one life of the DO between evictions; `stream/woken` opens each; ephemeral offsets are unique within one                                           |
| live state         | a `LiveState` holder's `{ rev, state }` plus `live-state/changed` deltas; clients chain revs and re-seed on a gap                                  |
| pager              | the hibernatable WebSocket from edge relay to DO; the DO sends `{ type: "page" }` to get a fresh stub                                              |
| egress             | any fetch leaving project code: `{{secret:project:NAME}}` substituted in the DO, then `FALLBACK.fetch`                                             |
| fetch lane         | reaching a fetch-shaped capability: `/cap?context=&cap=` from outside, a terminal `itx.x.fetch(request)` from inside a session                     |

---

## 11. Read next

- `docs/tutorial-build-the-iterate-context.md` builds the same system from
  nothing in eight bricks and maps each chapter to these files.
- `LAYERS.md` is the bottom-up layer map (axioms → mounts → subscriptions →
  processors → live state).
- `docs/design-onion-subscriptions-processors.md` is the design of record for
  the subscriptions and processors layers, with the decisions table.
- The source headers of `context/built-ins.ts`, `context/capability-table.ts`,
  `iterate-context.ts`, `stream/subscription-delivery.ts`,
  `fetch/fetch-capabilities.ts` and `context/hibernatable-rpc-stub.ts` each
  carry their doctrine at the top.
- `e2e/*.e2e.test.ts` are the executable examples; `e2e/support/client.ts` is
  the whole client surface a test uses.
