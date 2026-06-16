// server.ts — the Cloudflare Worker that hosts itx.
//
// One Worker, one itx Durable Object per context coordinate, one durable event
// log per context. The whole surface is a single connect route:
//
//   /itx?context=prj:<id>                 -> a project context
//   /itx?context=prj:<id>/agents/<name>   -> an agent context (parent = project)
//   /itx?context=global                   -> the stateless platform root
//
// A NAKED Cap'n Web stub drives every context: the client calls the verbs
// directly (`itx.provideCapability({…})`) AND pipelines deep dotted paths
// (`itx.slack.chat.postMessage(msg)`) with NO client-side library. The trick is
// entirely server-side — `dynamicHandle` (below) collapses a pipelined path into
// one `invokeCapability({ path, args })` against the live context.

import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import { durableObjectProcessorSubscriber } from "@iterate-com/os/src/domains/streams/engine/shared/callable-subscriber.ts";
import { ItxContract } from "./contract.ts";
import { Itx, type ItxContext, type ProvideArgs, retain } from "./itx.ts";
import { GlobalContext } from "./global-context.ts";
import { authenticate, authorizeProjectAccess } from "./auth.ts";

// The real durable event log from apps/os — re-exported so wrangler hosts it as
// a Durable Object. A context's capability table is the fold of one of these.
export { Stream } from "@iterate-com/os/src/domains/streams/engine/workers/durable-objects/stream.ts";

// ---------------------------------------------------------------------------
// The server-side dynamic proxy — the load-bearing trick.
// ---------------------------------------------------------------------------
//
// Capabilities are registered at RUNTIME and change over a context's life, so
// the served target cannot be a class with fixed methods. It must answer names
// it has never heard of and collapse an accumulated dotted path into one
// `invokeCapability`. Three non-obvious requirements, each a real debugging
// round (and the reason an earlier draft wrongly concluded this "doesn't work"):
//
//   1. The target must be FUNCTION-typed (a Proxy over `function(){}`), NOT a
//      Proxy over an RpcTarget. Cap'n Web classifies an rpc-target by prototype
//      and forbids fabricated "instance properties"; a function-typed target is
//      traversed via Object.hasOwn, where fabricated own properties are allowed.
//   2. `getOwnPropertyDescriptor` is load-bearing, not just `get`. Server-side
//      Cap'n Web does Object.hasOwn(value, segment) BEFORE reading value[segment];
//      without the descriptor trap every segment reads as absent and the chain
//      dies at ".chat of undefined".
//   3. `has` must answer for non-reserved names too.

// Names Cap'n Web (or the JS runtime) probes that must never be treated as path
// segments or verbs — they would derail the proxy or trigger thenable detection.
const RESERVED = new Set([
  "then",
  "__proto__",
  "constructor",
  "prototype",
  "apply",
  "call",
  "bind",
  "dup",
  "onRpcBroken",
]);

function dynamicHandle({ rpcTarget, path = [] }: { rpcTarget: any; path?: string[] }): any {
  // A name is a VERB iff the served handle actually has a method by that name
  // (provideCapability / invokeCapability / …) AND we are at the root (path
  // empty). Anything else extends the accumulating path. Deriving "is a verb"
  // from the target keeps this proxy agnostic to which handle it wraps.
  const verbAt = (key: string) =>
    path.length === 0 && !RESERVED.has(key) && typeof rpcTarget[key] === "function";
  const valueFor = (key: string) =>
    verbAt(key)
      ? rpcTarget[key].bind(rpcTarget)
      : dynamicHandle({ rpcTarget, path: [...path, key] });
  return new Proxy(function () {}, {
    get(t, key) {
      if (typeof key === "symbol") return Reflect.get(t, key);
      if (RESERVED.has(key as string)) return undefined; // includes "then": never thenable
      return valueFor(key);
    },
    getOwnPropertyDescriptor(t, key) {
      if (typeof key === "symbol" || RESERVED.has(key as string))
        return Reflect.getOwnPropertyDescriptor(t, key);
      return { configurable: true, enumerable: true, writable: false, value: valueFor(key) };
    },
    has(t, key) {
      return typeof key === "symbol" ? key in t : !RESERVED.has(key as string);
    },
    apply(_t, _s, args) {
      // A bare-stub deep path lands here: invoke the accumulated path. One bag,
      // the same convention as every other verb.
      return rpcTarget.invokeCapability({ path, args: args as unknown[] });
    },
  });
}

// ---------------------------------------------------------------------------
// The serving edge — ONE adapter for every context.
// ---------------------------------------------------------------------------
//
// What the Worker serves to a client: a local Cap'n Web RpcTarget that forwards
// the itx protocol to the underlying context. It exists for two reasons:
//
//   • it keeps the client↔Worker boundary pure Cap'n Web and the Worker↔context
//     boundary its own (Workers RPC for a DO context, an in-process call for the
//     global root) — re-exporting a Workers-RPC stub directly over Cap'n Web
//     tangles the two stub-lifetime systems; and
//   • it dups a provided live stub at the edge (Cap'n Web disposes an argument
//     stub when the call returns, which would kill the copy the context keeps).
//
// Because every verb is bag-of-props on BOTH sides, the edge is a near-pure
// pass-through — the same adapter works for a DO-backed `Itx` and for the
// `GlobalContext`, so there is ONE edge, not one per context kind. `runScript`
// (codemode) needs the Worker Loader, which only a DO context has, so it is an
// optional injected callback rather than part of the `ItxContext` protocol.
class ItxRpcEdge extends RpcTarget {
  #ctx: ItxContext;
  #runScript?: (args: { code: string }) => Promise<unknown>;
  constructor(ctx: ItxContext, runScript?: (args: { code: string }) => Promise<unknown>) {
    super();
    this.#ctx = ctx;
    this.#runScript = runScript;
  }
  provideCapability(args: ProvideArgs) {
    // dup at THIS (Worker) layer: `capability` is a Cap'n Web import from the
    // client and is disposed when this call returns; dup retains it so the
    // client→Worker→context hop survives.
    return this.#ctx.provideCapability({ ...args, capability: retain(args.capability) });
  }
  invokeCapability(args: { path: string[]; args?: unknown[] }) {
    return this.#ctx.invokeCapability(args);
  }
  revokeCapability(args: { path: string[] }) {
    return this.#ctx.revokeCapability(args);
  }
  describe() {
    return this.#ctx.describe();
  }
  runScript(args: { code: string }) {
    if (!this.#runScript) throw new Error("this context does not support codemode (runScript)");
    return this.#runScript(args);
  }
}

interface Env {
  ITX: DurableObjectNamespace<ItxDO>;
  PROJECT: DurableObjectNamespace<Project>;
  AGENT: DurableObjectNamespace<Agent>;
  STREAM: DurableObjectNamespace<any>;
  // Worker Loader: build + run a worker from a sturdy address (dial) or a script
  // (codemode) at runtime.
  LOADER: {
    get(
      id: string,
      getCode: () => {
        compatibilityDate: string;
        compatibilityFlags: string[];
        mainModule: string;
        modules: Record<string, string>;
      },
    ): { getEntrypoint(name?: string, options?: { props?: Record<string, unknown> }): any };
  };
}

// Content-addressed cache key for a loaded isolate: same source → same isolate.
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// The itx context host — one Durable Object hosting the real StreamProcessor.
//
// The capability table is the FOLD of a durable event log: provide appends an
// event, the fold projects it, replaying the log rebuilds it. The processor's
// checkpoint is a disposable cache in this DO's storage; the live stubs are an
// in-memory field inside the processor; the log itself is the real `Stream`
// Durable Object, dialed by coordinate.
// ---------------------------------------------------------------------------
export class ItxDO extends DurableObject<Env> {
  // The processor is HOSTED (not just newed) so the stream can deliver batches to
  // it: createStreamProcessorHost wires checkpoint storage + keep-alive, and on
  // subscription handshake pumps every appended batch into the processor's ingest.
  host = createStreamProcessorHost(this.ctx);
  #itx = this.host.add(
    ItxContract.slug,
    (deps) =>
      new Itx({
        ...deps,
        iterateContext: { stream: this.#log() },
        dial: (address) => this.#dial(address), // capabilities AND the parent
        builtinCapabilities: this.#contextBuiltinCapabilities(), // from the domain object
        parentAddress: this.#parentAddress(), // the chain, as data
      }),
  );
  #subscriptionConfigured = false;

  // A context is named by its coordinate: "prj:<id>" is the project context,
  // "prj:<id>/agents/<name>" is an agent context under it. This extracts the
  // project id; null for any other (standalone) coordinate.
  #project(): string | null {
    const name = this.ctx.id.name ?? "";
    return name.startsWith("prj:") ? name.slice("prj:".length).split("/")[0] : null;
  }

  // A context is born with built-in capabilities defined by the DOMAIN object it
  // is scoped to. The project context gets the Project DO's built-ins (fetch); an
  // agent context gets the Agent DO's (whoami) AND inherits the project's via the
  // chain. The host decides WHICH coordinate maps to WHICH domain object; the
  // domain object defines WHAT it offers.
  #contextBuiltinCapabilities(): ProvideArgs[] {
    const name = this.ctx.id.name ?? "";
    const projectId = this.#project();
    if (!projectId) return [];
    if (name === `prj:${projectId}`) {
      return Project.builtinCapabilities(this.env.PROJECT.getByName(projectId));
    }
    if (/^prj:[^/]+\/agents\/.+$/.test(name)) {
      return Agent.builtinCapabilities(this.env.AGENT.getByName(name.slice("prj:".length)));
    }
    return [];
  }

  // A context's PARENT, as a sturdy ADDRESS the core dials to climb on a miss.
  // An agent parents to its project (a DO-backed context); a project root parents
  // to the GLOBAL root (a code address). A standalone context has no parent. The
  // host derives parentage from the coordinate topology — it is NOT folded from
  // the log (nothing reads a folded copy), so it lives only here.
  #parentAddress(): any | null {
    const name = this.ctx.id.name ?? "";
    const projectId = this.#project();
    if (!projectId) return null;
    if (name === `prj:${projectId}`) return { type: "code", context: "global" };
    return { type: "context", ref: `prj:${projectId}` };
  }

  // The ONE dialer: a sturdy ADDRESS → a callable stub. Address kinds are
  // dispatched on `type` — and capabilities and parent contexts share this one
  // door because the reference impl is unauthed within a connection. (Production
  // gates provider-supplied capability addresses and leaves trusted context
  // addresses ungated — two dials. Auth lives at the connect door instead.)
  #dial(address: any): any {
    // a parent: another context node (an agent's project), dialed by coordinate.
    if (address?.type === "context" && typeof address.ref === "string") {
      // `as any` breaks a deep StreamProcessor-generic instantiation that tsc
      // otherwise flags as "excessively deep" through the DO stub's return type.
      return (this.env.ITX.getByName(address.ref) as any).itx();
    }
    // a parent: the code-rooted global root — STATELESS, so constructed inline.
    // Needing no DO is exactly why it is the root. (Prod dials it as a loopback.)
    if (address?.type === "code" && address.context === "global") {
      return new GlobalContext({ access: "all" });
    }
    // a capability: BUILD AND RUN its worker via the Worker Loader.
    // `{ type: "rpc", worker: { type: "source", source }, entrypoint, props }` → a
    // live entrypoint stub whose methods run in the loaded isolate, `props`
    // arriving as `this.ctx.props`. The isolate is cached by content.
    if (address?.type === "rpc" && address.worker?.type === "source") {
      const worker = address.worker;
      const loaded = this.env.LOADER.get(
        `src:${address.entrypoint}:${hashString(worker.source)}`,
        () => ({
          compatibilityDate: "2025-04-27",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "main.js",
          modules: { "main.js": worker.source },
        }),
      );
      return loaded.getEntrypoint(address.entrypoint, { props: address.props ?? {} });
    }
    throw new Error(`address is not dialable: ${JSON.stringify(address)}`);
  }

  // This context's durable event log is its OWN stream, named by coordinate — a
  // context IS its stream coordinate. Re-resolve the stub per call so it stays
  // valid across the log's lifecycle.
  #coordinate(): string {
    return `refimpl:/${this.ctx.id.name ?? "itx"}`;
  }
  #log() {
    // `as any` on the stream stub avoids a deep StreamProcessor-generic
    // instantiation tsc flags as "excessively deep" through the DO stub type.
    const stream = (): any => (this.env.STREAM as any).getByName(this.#coordinate());
    return {
      append: (args: any) => stream().append(args),
      appendBatch: (args: any) => stream().appendBatch(args),
    };
  }

  // Configure the stream → processor subscription ONCE (idempotent): point the
  // stream at THIS DO's requestStreamSubscription. The Stream DO then dials us and
  // pumps every appended batch into the processor — automatic delivery, including
  // events written by anyone else, not just this context's own provides.
  #ensureSubscriptionConfigured(): void {
    if (this.#subscriptionConfigured) return;
    this.#subscriptionConfigured = true;
    const name = this.ctx.id.name ?? "itx";
    const event: any = {
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `itx-subscription:${name}`,
      payload: {
        subscriptionKey: `itx:${name}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "ITX",
          durableObjectName: name,
          processorName: ItxContract.slug,
        }),
      },
    };
    this.ctx.waitUntil(this.#log().append({ event }));
  }

  // A METHOD that returns the processor (workerd cannot pipeline through a
  // property). Lazily wires the subscription on first reach.
  itx(): Itx {
    this.#ensureSubscriptionConfigured();
    return this.#itx;
  }

  // The Stream DO dials this to start delivering batches to the host's processor.
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    this.#ensureSubscriptionConfigured();
    return this.host.requestStreamSubscription(args);
  }

  // Codemode: a capability can be a whole PROGRAM. The code is an
  // `async (itx) => …` function; we LOAD it as a worker (the Worker Loader, like
  // dial), hand it an itx handle so it can invoke/provide against THIS context,
  // and bracket the run with durable request/completed records. Everything the
  // script does between them is invisible to the log; the two events are the
  // audit record that a run happened.
  async runScript({ code }: { code: string }): Promise<unknown> {
    const executionId = crypto.randomUUID();
    const log = this.#log();
    await log.append({
      event: {
        type: "events.iterate.com/itx/script-execution-requested",
        payload: { executionId, code },
      },
    } as any);
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      const program = ${code};
      export class Script extends WorkerEntrypoint {
        async run(itx) { return await program(itx); }
      }
    `;
    const loaded = this.env.LOADER.get(`script:${hashString(code)}`, () => ({
      compatibilityDate: "2025-04-27",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.js",
      modules: { "main.js": source },
    }));
    // The itx handle the script receives — bag-of-props, the same protocol as
    // everywhere else. The methods become RPC stubs in the loaded isolate.
    const itxHandle = {
      provideCapability: (args: ProvideArgs) => this.#itx.provideCapability(args),
      invokeCapability: (args: { path: string[]; args?: unknown[] }) =>
        this.#itx.invokeCapability(args),
      describe: () => this.#itx.describe(),
    };
    const result = await loaded.getEntrypoint("Script").run(itxHandle);
    await log.append({
      event: {
        type: "events.iterate.com/itx/script-execution-completed",
        payload: { executionId },
      },
    } as any);
    return result;
  }
}

// ---------------------------------------------------------------------------
// The domain objects. A context's identity is a project id + a path, and at each
// coordinate sits a real domain Durable Object: the project root is a `Project`,
// an agent under it is an `Agent`. Each owns its resources AND defines the
// built-in capabilities a context scoped to it is born with — the production
// shape in miniature (apps/os has Project and Agent DOs; the itx context
// attaches to them by coordinate, and the agent's itx parent is the project's).
// ---------------------------------------------------------------------------

// The Project DO. Owns the project's egress AND defines a project context's
// built-ins. `egress` does the outbound fetch (named `egress`, not `fetch`,
// because a DO's `fetch` is its HTTP entrypoint).
export class Project extends DurableObject<Env> {
  async egress(
    url: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: string; viaProject: string }> {
    const response = await fetch(url, init);
    return {
      status: response.status,
      body: await response.text(),
      viaProject: this.ctx.id.name ?? "?",
    };
  }

  // The capabilities a context scoped to THIS project is born with — same shape
  // as a provideCapability call. A built-in is a capability pre-provided in code.
  static builtinCapabilities(project: DurableObjectStub<Project>): ProvideArgs[] {
    return [
      {
        path: ["fetch"],
        capability: (url: string, init?: RequestInit) => project.egress(url, init),
        instructions: "the project's HTTP egress",
      },
    ];
  }
}

// The Agent DO. Lives UNDER a project (coordinate "<id>/agents/<name>"). Owns its
// identity and defines its own built-ins (whoami). An agent context is born with
// these AND, on a miss, climbs to its project's context (the chain) — so an agent
// can call its own `whoami` AND the project's inherited `fetch`.
export class Agent extends DurableObject<Env> {
  whoami(): string {
    return `agent ${this.ctx.id.name ?? "?"}`;
  }

  static builtinCapabilities(agent: DurableObjectStub<Agent>): ProvideArgs[] {
    return [
      {
        path: ["whoami"],
        capability: () => agent.whoami(),
        instructions: "the agent's own identity",
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// The Worker entrypoint.
// ---------------------------------------------------------------------------

// Open a Cap'n Web WebSocket session serving `rpcTarget` (wrapped in the dynamic
// proxy) to the client. `ctx.waitUntil(close)` keeps this invocation's I/O
// context alive for the socket's lifetime — without it, the moment fetch returns
// the Worker→context RPC carrying a client's live stub is torn down, and a later
// cross-client call dies with "the execution context which hosts this callback
// is no longer running."
function serveItx(rpcTarget: RpcTarget, ctx: ExecutionContext): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();
  newWebSocketRpcSession(server as unknown as WebSocket, dynamicHandle({ rpcTarget }));
  ctx.waitUntil(new Promise<void>((resolve) => server.addEventListener("close", () => resolve())));
  return new Response(null, { status: 101, webSocket: pair[1] });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/itx") {
      return new Response(
        "minimal-itx: connect to /itx?context=prj:<id> | prj:<id>/agents/<name> | global",
        { status: 404 },
      );
    }

    const context = url.searchParams.get("context") ?? "";

    // The platform root: not project-scoped, so authenticate the principal only
    // and serve the STATELESS global context, scoped to the projects it may reach.
    // No DO and no stream — the context is constructed per connection.
    if (context === "global") {
      const principal = authenticate(request);
      if (!principal) return new Response("missing or invalid token", { status: 401 });
      return serveItx(new ItxRpcEdge(new GlobalContext({ access: principal.projects })), ctx);
    }

    // A project or agent context. Authorize the principal for the project, then
    // serve the DO-backed context at that coordinate. The edge also forwards
    // codemode (runScript) to the DO.
    const projectId = context.startsWith("prj:") ? context.slice("prj:".length).split("/")[0] : "";
    const auth = authorizeProjectAccess(request, projectId);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const node = env.ITX.getByName(context);
    const edge = new ItxRpcEdge(node.itx() as unknown as ItxContext, (args) =>
      node.runScript(args),
    );
    return serveItx(edge, ctx);
  },
};
