// server.ts — a complete Cloudflare Worker that hosts the itx workshop steps.
//
// One Worker, one ITX Durable Object, one durable event log.
//
//   /step0  -> Server (whoami)                            [Step 0]
//   /step1  -> RegisterServer (server calls back client)  [Step 1]
//   /itx    -> the ITX Durable Object, served over capnweb [Steps 2-11]
//
// There is ONE itx context here and it is the real thing: ItxDO hosts
// `Itx extends StreamProcessor<ItxContract>` (itx-processor.ts) — the actual
// class from @iterate-com/streams — and backs it with the real `Stream` Durable
// Object as its durable event log. Steps 2-6 (provide/invoke, the live
// cross-client rendezvous, deep dotted paths into the real Slack SDK) and
// Steps 8/11 (the fold of a durable event log; replay rebuilds the table) all
// run against that one context. A NAKED capnweb stub drives it — the dynamic
// server-side proxy serves the verbs and pipelines deep paths; there is no
// client-side path proxy.
//
// (Production's apps/os/src/itx/itx-durable-object.ts is this same shape plus the
// context chain, dial, coordinates and a subscription-driven host — Step 12.)

import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse, newWebSocketRpcSession } from "capnweb";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import { Itx } from "./itx-processor.ts";
import { ItxContract } from "./itx-contract.ts";
// Incremental step folders (steps/README.md). Each is mounted under
// /steps/<id>/* so earlier and half-built steps stay live alongside the rest.
import * as step01 from "./steps/01-socket/worker.ts";
import * as step08 from "./steps/08-auth/worker.ts";
// The real durable event log from @iterate-com/streams — re-exported so wrangler
// hosts it as a Durable Object.
export { Stream } from "@iterate-com/streams/workers/durable-objects/stream";

// Retain a provided capability past the provide call's return. capnweb disposes
// argument stubs when the call returns; a stub exposes dup(), and a plain object
// crosses by value with its function members as stubs, so we walk and dup them.
function retain(target: any): any {
  if (target && typeof target.dup === "function") return target.dup();
  if (target && typeof target === "object") {
    const out: any = Array.isArray(target) ? [] : {};
    for (const k of Object.keys(target)) out[k] = retain(target[k]);
    return out;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Step 0: the simplest server.
// ---------------------------------------------------------------------------
class Server extends RpcTarget {
  whoami() {
    return "the itx server";
  }
}

// ---------------------------------------------------------------------------
// Step 1: the server calls the client.
// The client passes { runSwift } as an argument; the server calls it back.
// ---------------------------------------------------------------------------
class RegisterServer extends RpcTarget {
  async register(laptop: { runSwift: (code: string) => Promise<string> }) {
    // Real-Swift-only program: a ClosedRange folded with reduce. The harness's
    // JS fallback can only evaluate `print(<arithmetic>)`, so `(1...10)` +
    // `.reduce` is impossible to fake — a "55\n" here PROVES Swift actually ran.
    const out = await laptop.runSwift(`print((1...10).reduce(0, +))`);
    return `your laptop says: ${out}`;
  }
}

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

// Steps 5 & 6: the ONE server-side dynamic proxy. This is the whole trick that
// lets a NAKED capnweb client stub call `itx.invoke(...)` AND deep paths like
// `itx.slack.chat.postMessage(msg)` with no client-side library — capnweb
// pipelines the dotted path from the bare stub into one message, and this proxy
// collapses it into a single `invoke(path, args)` against the live context.
//
// Three non-obvious requirements (each cost a debugging round; all proven in
// min-dynamic-target.mjs and live over real workerd):
//   1. The target must be FUNCTION-typed (a Proxy over `function(){}`), NOT a
//      Proxy over an RpcTarget. capnweb classifies an rpc-target by prototype
//      and forbids fabricated "instance properties"; a function-typed target is
//      traversed via Object.hasOwn, where fabricated own properties are allowed.
//   2. getOwnPropertyDescriptor is load-bearing, not just get. Server-side
//      capnweb does Object.hasOwn(value, segment) BEFORE reading value[segment];
//      without the descriptor trap every segment reads as absent and the chain
//      dies at ".chat of undefined".
//   3. `has` must answer for non-reserved names too.
function dynamicHandle(target: any, path: string[] = []): any {
  // A name is a VERB if the served handle actually has a method by that name
  // (provideCapability / invoke / revokeCapability / list / …); anything else
  // extends the accumulating path. Deriving this from the target keeps the proxy
  // agnostic to which handle it wraps.
  const verbAt = (key: string) =>
    path.length === 0 && !RESERVED.has(key) && typeof target[key] === "function";
  const valueFor = (key: string) =>
    verbAt(key) ? (target as any)[key].bind(target) : dynamicHandle(target, [...path, key]);
  return new Proxy(function () {}, {
    get(t, key) {
      if (typeof key === "symbol") return Reflect.get(t, key);
      if (key === "then" || RESERVED.has(key)) return undefined;
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
      // A bare-stub deep path lands here: invoke the accumulated path.
      return target.invoke(path, args as unknown[]);
    },
  });
}

interface Env {
  ITX: DurableObjectNamespace<ItxDO>;
  PROJECT: DurableObjectNamespace<ProjectDO>;
  STREAM: DurableObjectNamespace<any>;
  // Worker Loader (Step 09): build + run a worker from a ref at runtime.
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
// THE itx context — one Durable Object hosting the real StreamProcessor.
//
// The capability table is the FOLD of a durable event log: provide appends an
// event, the fold projects it, replaying the log rebuilds it (Steps 8/11). The
// processor's checkpoint is a disposable cache in this DO's storage; the live
// stubs (Step 4's bridge) are an in-memory field inside the processor; the log
// itself is the real `Stream` Durable Object, dialed by name.
// ---------------------------------------------------------------------------
export class ItxDO extends DurableObject<Env> {
  // The processor is hosted (not just newed) so the stream can deliver batches
  // to it: createStreamProcessorHost wires the checkpoint storage + keep-alive,
  // and on subscription handshake it pumps every appended batch into the
  // processor's ingest. (Same pattern as apps/os/src/itx/itx-durable-object.ts.)
  host = createStreamProcessorHost(this.ctx);
  #itx = this.host.add(
    ItxContract.slug,
    (deps) =>
      new Itx({
        ...deps,
        iterateContext: { stream: this.#log() },
        dial: (address) => this.#dial(address), // Step 09: restore a sturdy ref
        roots: this.#projectRoots(), // Step 10: itx.fetch on a project context
        parentItx: () => this.#parentContext(), // Step 11: climb to the parent
      }),
  );
  #subscriptionConfigured = false;

  // A context is a project id + a path (Step 12). We name the host DO by that
  // coordinate: "prj:<id>" is the project itx; "prj:<id>/agents/<name>" is an
  // agent itx under it. Helpers below derive the project id and the parent.
  #project(): string | null {
    const name = this.ctx.id.name ?? "";
    return name.startsWith("prj:") ? name.slice("prj:".length).split("/")[0] : null;
  }

  // Step 10: ONLY the project-root context ("prj:<id>", no sub-path) is born with
  // `fetch` as a root capability — provided, not built in — backed by that
  // project's Project DO. Agent/sub-contexts inherit `fetch` via the chain.
  #projectRoots(): Record<string, any> {
    const name = this.ctx.id.name ?? "";
    const projectId = this.#project();
    if (!projectId || name !== `prj:${projectId}`) return {};
    return {
      fetch: (url: string, init?: RequestInit) =>
        this.env.PROJECT.getByName(projectId).egress(url, init),
    };
  }

  // Step 11: the parent context. An agent ("prj:<id>/agents/<name>") climbs to
  // its project ("prj:<id>") on a miss; the project root has no parent here.
  #parentContext(): { invoke(input: { path: string[]; args: unknown[] }): any } | null {
    const name = this.ctx.id.name ?? "";
    const projectId = this.#project();
    if (!projectId || name === `prj:${projectId}`) return null; // project root: top of the chain
    return this.env.ITX.getByName(`prj:${projectId}`).itx();
  }

  // dial (Step 09): turn a sturdy address into a callable by BUILDING AND RUNNING
  // its worker via the Worker Loader. `{ type: "rpc", worker: { type: "source",
  // source }, entrypoint, props }` → a live entrypoint stub whose methods run in
  // the loaded isolate, with `props` arriving as `this.ctx.props`. The isolate is
  // cached by content (same source → same isolate, no rebuild).
  #dial(address: any): any {
    if (address?.type !== "rpc") throw new Error("capability address is not dialable");
    const worker = address.worker;
    if (worker?.type !== "source") {
      throw new Error(`worker type "${worker?.type}" is not supported here (only "source")`);
    }
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

  // This context's durable event log is its OWN stream, named by coordinate —
  // a context IS its stream coordinate (Step 11). Re-resolve the stub per call
  // so it stays valid across the log's lifecycle.
  #coordinate(): string {
    return `workshop:/${this.ctx.id.name ?? "itx"}`;
  }
  #log() {
    return {
      append: (args: any) => this.env.STREAM.getByName(this.#coordinate()).append(args),
      appendBatch: (args: any) => this.env.STREAM.getByName(this.#coordinate()).appendBatch(args),
    };
  }

  // Configure the stream → processor subscription ONCE (idempotent): append a
  // `subscription-configured` event pointing the stream at THIS DO's
  // requestStreamSubscription. The Stream DO then dials us and pumps every
  // appended batch into the processor — automatic delivery, including events
  // written by anyone else (not just this context's own provides).
  #ensureSubscriptionConfigured(): void {
    if (this.#subscriptionConfigured) return;
    this.#subscriptionConfigured = true;
    const name = this.ctx.id.name ?? "itx";
    this.ctx.waitUntil(
      this.env.STREAM.getByName(this.#coordinate()).append({
        event: {
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
        },
      } as any),
    );
  }

  // A METHOD that returns the processor (workerd can't pipeline through a property).
  itx(): Itx {
    this.#ensureSubscriptionConfigured();
    return this.#itx;
  }

  // The Stream DO dials this to start delivering batches to the host's processor.
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    this.#ensureSubscriptionConfigured();
    return this.host.requestStreamSubscription(args);
  }

  // Step 07 intent: append an event to the stream WITHOUT touching the processor
  // — an "external writer". The processor must learn of it purely via the
  // subscription delivery (proving the stream pushes, not just self-ingest).
  appendToStream(event: unknown): Promise<unknown> {
    this.#ensureSubscriptionConfigured();
    return this.env.STREAM.getByName(this.#coordinate()).append({ event });
  }

  // Durability proof, server-side: build a FRESH processor and replay the whole
  // durable log into it. Its rebuilt table must match the live one — the fold is
  // the source of truth, the log survives, the processor is reconstructible.
  async freshFoldCapabilityNames(): Promise<string[]> {
    const log = this.env.STREAM.getByName(this.#coordinate());
    const events = await log.getEvents({});
    const fresh = new Itx({
      iterateContext: {
        stream: {
          append: () => {
            throw new Error("replay is read-only");
          },
          appendBatch: () => {
            throw new Error("replay is read-only");
          },
        },
      },
    });
    await fresh.ingest({ events, streamMaxOffset: events.at(-1)?.offset ?? 0 });
    return fresh.listCapabilities();
  }
}

// What the stateless Worker serves to each client: a LOCAL capnweb RpcTarget
// that forwards the verbs to the DO. This keeps the client↔Worker boundary pure
// capnweb and the Worker↔DO boundary pure Workers-RPC. It dups live stubs at the
// edge (Step 4) and adapts the bare-stub calling convention to the processor's
// bag-of-props verbs. A client's live stub is passed THROUGH here to the DO; the
// handle's invocation is kept alive (ctx.waitUntil) so the stub stays callable
// when another client invokes it.
class WorkerHandle extends RpcTarget {
  #node: DurableObjectStub<ItxDO>;
  constructor(node: DurableObjectStub<ItxDO>) {
    super();
    this.#node = node;
  }
  provideCapability(path: string[], capability: any) {
    // Dup at THIS (Worker) layer first: `capability` is a capnweb import from the
    // client; when this provide call returns, capnweb disposes that import, which
    // would break the DO's copy. dup() retains it so client→Worker→DO survives.
    return this.#node.itx().provideCapability({ path, capability: retain(capability) });
  }
  invoke(path: string[], args: unknown[]) {
    return this.#node.itx().invoke({ path, args });
  }
  revokeCapability(path: string[]) {
    return this.#node.itx().revokeCapability({ path });
  }
  list() {
    return this.#node.itx().listCapabilities();
  }
  freshFold() {
    return this.#node.freshFoldCapabilityNames();
  }
  // Step 07: append straight to the durable log (an "external writer"); the
  // processor should learn of it via the subscription, not via a provide call.
  appendToStream(event: unknown) {
    return this.#node.appendToStream(event);
  }
}

// Step 10 — the Project Durable Object. One per project; it owns the project's
// egress. Its `egress` method does the actual outbound fetch (named `egress`, not
// `fetch`, because a DO's `fetch` is its HTTP entrypoint). A project-scoped itx is
// born with this wired as the `fetch` root (see ItxDO.#projectRoots), so
// `itx.fetch(url)` routes here — egress is the project's, tagged with its id.
export class ProjectDO extends DurableObject<Env> {
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Incremental step folders (steps/README.md).
    if (path === "/steps/01-socket") {
      return step01.handle(request);
    }

    // Step 08 — auth: only complete the socket if the token grants the project,
    // and scope the itx to that project's own context (named by project id).
    if (path === "/steps/08-auth") {
      const project = url.searchParams.get("project") ?? "";
      const auth = step08.authorizeProjectAccess(request, project);
      if (!auth.ok) return new Response(auth.message, { status: auth.status });

      const node = env.ITX.getByName(`prj:${project}`);
      const main = dynamicHandle(new WorkerHandle(node));
      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();
      newWebSocketRpcSession(server as unknown as WebSocket, main);
      ctx.waitUntil(
        new Promise<void>((resolve) => server.addEventListener("close", () => resolve())),
      );
      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    // Step 11 — the chain: open a project context (?project=alice) or an agent
    // context under it (?project=alice&agent=foo). The agent's parent is the
    // project; a miss on the agent climbs to the project (super). Auth is the
    // same project check as Step 08.
    if (path === "/steps/11-chain") {
      const project = url.searchParams.get("project") ?? "";
      const agent = url.searchParams.get("agent");
      const auth = step08.authorizeProjectAccess(request, project);
      if (!auth.ok) return new Response(auth.message, { status: auth.status });

      const coordinate = agent ? `prj:${project}/agents/${agent}` : `prj:${project}`;
      const node = env.ITX.getByName(coordinate);
      const main = dynamicHandle(new WorkerHandle(node));
      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();
      newWebSocketRpcSession(server as unknown as WebSocket, main);
      ctx.waitUntil(
        new Promise<void>((resolve) => server.addEventListener("close", () => resolve())),
      );
      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    if (path === "/step0") {
      return newWorkersRpcResponse(request, new Server());
    }
    if (path === "/step1") {
      return newWorkersRpcResponse(request, new RegisterServer());
    }

    // Everything else rendezvouses in the ONE shared ITX DO named "itx". The
    // capnweb session terminates HERE, in the stateless Worker — the DO exposes
    // its processor via the node.itx() method. The client receives a NAKED stub
    // of the dynamic handle: it calls the verbs directly AND pipelines deep dotted
    // paths (itx.slack.chat.postMessage(...)) with no client-side library.
    if (path === "/itx") {
      // A context is named. `?ctx=<name>` selects which ITX DO (and thus which
      // durable log) you meet — a fresh name = a fresh context. Clients that want
      // to rendezvous pass the same name; the default "itx" is the shared one.
      const node = env.ITX.getByName(url.searchParams.get("ctx") ?? "itx");
      const main = dynamicHandle(new WorkerHandle(node));

      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();
      newWebSocketRpcSession(server as unknown as WebSocket, main);

      // Keep this invocation's I/O context alive for the socket's lifetime.
      // Without it, when this fetch returns the Worker→DO RPC that carries a
      // client's live stub is torn down, and a later cross-client call dies with
      // "the execution context which hosts this callback is no longer running."
      ctx.waitUntil(
        new Promise<void>((resolve) => server.addEventListener("close", () => resolve())),
      );

      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    return new Response("itx-workshop-repro: try /step0 /step1 /itx", {
      status: 404,
    });
  },
};
