// server.ts — a complete Cloudflare Worker that hosts the itx workshop steps.
//
// One Worker, one ITX Durable Object, one durable event log.
//
//   /step0  -> Server (whoami)                            [Step 0]
//   /step1  -> RegisterServer (server calls back client)  [Step 1]
//   /itx    -> the ITX Durable Object, served over capnweb [Steps 2-10]
//
// There is ONE itx context here and it is the real thing: ItxDO hosts
// `Itx extends StreamProcessor<ItxContract>` (itx-processor.ts) — the actual
// class from apps/os — and backs it with the real `Stream` Durable
// Object as its durable event log. Steps 2-6 (provide/invoke, the live
// cross-client rendezvous, deep dotted paths into the real Slack SDK) and
// Steps 8/10 (the fold of a durable event log; replay rebuilds the table) all
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
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import { durableObjectProcessorSubscriber } from "@iterate-com/os/src/domains/streams/engine/shared/callable-subscriber.ts";
import {
  Itx,
  replayPath,
  type DescribeResult,
  type ItxContext,
  type ProvideArgs,
} from "./itx-processor.ts";
import { ItxContract } from "./itx-contract.ts";
// Incremental step folders (steps/README.md). Each is mounted under
// /steps/<id>/* so earlier and half-built steps stay live alongside the rest.
import * as step01 from "./steps/01-socket/worker.ts";
import * as step02 from "./steps/02-server-calls-client/worker.ts";
import * as step03 from "./steps/03-provide-invoke/worker.ts";
import * as step04 from "./steps/04-durable-object/worker.ts";
import * as step08 from "./steps/08-auth/worker.ts";
// The real durable event log from apps/os — re-exported so wrangler
// hosts it as a Durable Object.
export { Stream } from "@iterate-com/os/src/domains/streams/engine/workers/durable-objects/stream.ts";
// The simple registry DO shared by steps 04-06 (the pre-StreamProcessor tier).
export { RegistryDO } from "./steps/04-durable-object/registry-do.ts";

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
function dynamicHandle({ rpcTarget, path = [] }: { rpcTarget: any; path?: string[] }): any {
  // A name is a VERB if the served handle actually has a method by that name
  // (provideCapability / invoke / revokeCapability / list / …); anything else
  // extends the accumulating path. Deriving this from the target keeps the proxy
  // agnostic to which handle it wraps.
  const verbAt = (key: string) =>
    path.length === 0 && !RESERVED.has(key) && typeof rpcTarget[key] === "function";
  const valueFor = (key: string) =>
    verbAt(key)
      ? (rpcTarget as any)[key].bind(rpcTarget)
      : dynamicHandle({ rpcTarget, path: [...path, key] });
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
      return rpcTarget.invokeCapability(path, args as unknown[]);
    },
  });
}

interface Env {
  ITX: DurableObjectNamespace<ItxDO>;
  PROJECT: DurableObjectNamespace<Project>;
  AGENT: DurableObjectNamespace<Agent>;
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
// event, the fold projects it, replaying the log rebuilds it (Steps 8/10). The
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
        dial: (address) => this.#dial(address), // Step 09/11: restore any sturdy address
        builtinCapabilities: this.#contextBuiltinCapabilities(), // Step 10: from the Project/Agent DO
        parentAddress: this.#parentRef()?.address ?? null, // Step 11: the parent, as data
      }),
  );
  #subscriptionConfigured = false;
  #contextCreated = false;

  // A context is a project id + a path (Step 12). We name the host DO by that
  // coordinate: "prj:<id>" is the project itx; "prj:<id>/agents/<name>" is an
  // agent itx under it. Helpers below derive the project id and the parent.
  #project(): string | null {
    const name = this.ctx.id.name ?? "";
    return name.startsWith("prj:") ? name.slice("prj:".length).split("/")[0] : null;
  }

  // Step 10: a context is born with built-in capabilities defined by the DOMAIN
  // object it's scoped to. The project-root context ("prj:<id>") gets the
  // `Project` DO's built-ins (fetch); an agent context ("prj:<id>/agents/<name>")
  // gets the `Agent` DO's own built-ins (whoami) AND inherits the project's via
  // the chain (Step 11). The ItxDO decides WHICH context maps to WHICH domain
  // object (by coordinate); the domain object defines WHAT it offers.
  #contextBuiltinCapabilities(): ProvideArgs[] {
    const name = this.ctx.id.name ?? "";
    const projectId = this.#project();
    if (!projectId) return [];
    if (name === `prj:${projectId}`) {
      return Project.builtinCapabilities(this.env.PROJECT.getByName(projectId));
    }
    // an agent context: prj:<id>/agents/<name> — its own DO is keyed by the
    // sub-coordinate "<id>/agents/<name>".
    if (/^prj:[^/]+\/agents\/.+$/.test(name)) {
      return Agent.builtinCapabilities(this.env.AGENT.getByName(name.slice("prj:".length)));
    }
    return [];
  }

  // Step 11 + 13: a context's PARENT, as DATA — a `{ ref, address }` birth-
  // certificate link, not a closure. An agent ("prj:<id>/agents/<name>") parents
  // to its project ("prj:<id>"), a DO-backed context node; the PROJECT root
  // parents to the GLOBAL context — the stateless, read-only platform capability
  // root (Step 13), a code address. A non-project context (the shared "itx") is
  // standalone and has no chain. The host knows the parentage at creation; it both
  // RECORDS it in the birth certificate and hands the address to the core to dial.
  #parentRef(): { ref: string; address: any } | null {
    const name = this.ctx.id.name ?? "";
    const projectId = this.#project();
    if (!projectId) return null; // standalone context (e.g. the shared "itx"): no chain
    if (name === `prj:${projectId}`) {
      return { ref: "global", address: { type: "code", context: "global" } };
    }
    return { ref: `prj:${projectId}`, address: { type: "context", ref: `prj:${projectId}` } };
  }

  // The ONE dialer: a sturdy ADDRESS → a callable stub. Three address kinds,
  // dispatched on `type` — two are CAPABILITIES, two are PARENT contexts, and they
  // share this one door because the toy is unauthed. (Production gates capability
  // addresses, which are provider-supplied, and leaves context addresses, which
  // are trusted, ungated — two dials. We solve for auth later.)
  #dial(address: any): any {
    // a parent: another context node (an agent's project), dialed by coordinate.
    if (address?.type === "context" && typeof address.ref === "string") {
      return this.env.ITX.getByName(address.ref).itx();
    }
    // a parent: the code-rooted global root (Step 13) — STATELESS, so constructed
    // inline; needing no DO is exactly why it's the root. The climb is project-
    // agnostic, so it gets full catalog access. (Prod dials it as a loopback.)
    if (address?.type === "code" && address.context === "global") {
      return new GlobalContext({ access: "all" });
    }
    // a capability (Step 09): BUILD AND RUN its worker via the Worker Loader.
    // `{ type: "rpc", worker: { type: "source", source }, entrypoint, props }` → a
    // live entrypoint stub whose methods run in the loaded isolate, `props` arriving
    // as `this.ctx.props`. The isolate is cached by content (same source → reused).
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

  // The birth certificate (Step 11), appended ONCE (idempotent — the fold takes
  // the first one). It records the context's name and PARENTAGE as data: the same
  // `{ ref, address }` the core dials to climb. The core climbs off the address
  // the host injected (so the very first climb never races this append's delivery
  // — the toy creates contexts lazily on connect, unlike production's "two appends
  // by the creator before first use"); this durable copy is for replay + audit.
  #ensureContextCreated(): void {
    if (this.#contextCreated) return;
    this.#contextCreated = true;
    const name = this.ctx.id.name ?? "itx";
    const parent = this.#parentRef();
    this.ctx.waitUntil(
      this.env.STREAM.getByName(this.#coordinate()).append({
        event: {
          type: "events.iterate.com/itx/context-created",
          idempotencyKey: `itx-context-created:${name}`,
          payload: { name, parent },
        },
      } as any),
    );
  }

  // A METHOD that returns the processor (workerd can't pipeline through a property).
  itx(): Itx {
    this.#ensureSubscriptionConfigured();
    this.#ensureContextCreated();
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

  // Step 12 — codemode: a capability can be a whole PROGRAM. The code is an
  // `async (itx) => …` function; we LOAD it as a worker (the Worker Loader, like
  // dial), hand it an itx handle so it can invoke/provide against this context,
  // and bracket the run with durable request/completed events. Everything the
  // script does between them is invisible to the log; the two events are the record.
  async runScript(code: string): Promise<unknown> {
    const executionId = crypto.randomUUID();
    const log = this.env.STREAM.getByName(this.#coordinate());
    await log.append({
      event: {
        type: "events.iterate.com/itx/script-execution-requested",
        payload: { executionId, code },
      },
    });
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
    // The itx handle the script receives — it can invoke and provide against this
    // very context (the methods become RPC stubs in the loaded isolate).
    const itxHandle = {
      invokeCapability: (path: string[], args: unknown[] = []) =>
        this.#itx.invokeCapability({ path, args }),
      provideCapability: (args: {
        path: string[];
        capability: any;
        instructions?: string;
        types?: string;
      }) => this.#itx.provideCapability(args),
      describe: () => this.#itx.describe(),
    };
    const result = await loaded.getEntrypoint("Script").run(itxHandle);
    await log.append({
      event: {
        type: "events.iterate.com/itx/script-execution-completed",
        payload: { executionId },
      },
    });
    return result;
  }

  // Durability proof, server-side: build a FRESH processor and replay the whole
  // durable log into it. Its rebuilt table must match the live one — the fold is
  // the source of truth, the log survives, the processor is reconstructible.
  async rebuildFromLog(): Promise<string[]> {
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
    return (await fresh.describe()).capabilities.map((c) => c.path.join("."));
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
  // The wire `provide` is a BAG ({ path, capability, instructions?, types? }) — the
  // SAME shape as the model's ProvideArgs and production's itx.provideCapability.
  // `instructions` (what the cap is for) and optional `types` (its surface) travel
  // with the capability; the fold carries them, describe() reads them back.
  provideCapability(args: {
    path: string[];
    capability: any;
    instructions?: string;
    types?: string;
  }) {
    // Dup at THIS (Worker) layer first: `capability` is a capnweb import from the
    // client; when this provide call returns, capnweb disposes that import, which
    // would break the DO's copy. dup() retains it so client→Worker→DO survives.
    return this.#node.itx().provideCapability({ ...args, capability: retain(args.capability) });
  }
  invokeCapability(path: string[], args: unknown[]) {
    return this.#node.itx().invokeCapability({ path, args });
  }
  revokeCapability(path: string[]) {
    return this.#node.itx().revokeCapability({ path });
  }
  // The one read verb: each reachable capability with the instructions/types it
  // was provided with (built-ins included, parent chain merged in). The metadata
  // round-trips client→DO→fold→here.
  describe() {
    return this.#node.itx().describe();
  }
  rebuildFromLog() {
    return this.#node.rebuildFromLog();
  }
  // Step 07: append straight to the durable log (an "external writer"); the
  // processor should learn of it via the subscription, not via a provide call.
  appendToStream(event: unknown) {
    return this.#node.appendToStream(event);
  }
  // Step 12 — codemode: run an `async (itx) => …` program in a loaded isolate.
  runScript(code: string) {
    return this.#node.runScript(code);
  }
}

// Step 10/11 — the domain objects. A context's identity is a project id + a path,
// and at each coordinate sits a real domain Durable Object: the project root is a
// `Project`, an agent under it is an `Agent`. Each owns its resources AND defines
// the built-in capabilities a context scoped to it is born with. This is the
// production shape in miniature: apps/os has Project and Agent durable objects;
// the itx context attaches to them by coordinate, and the agent's itx parent is
// the project's itx (the chain).

// The Project DO. One per project; it owns the project's egress AND defines the
// built-ins a project-scoped context is born with. `egress` does the actual
// outbound fetch (named `egress`, not `fetch`, because a DO's `fetch` is its HTTP
// entrypoint).
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

  // The capabilities a context scoped to THIS project is born with — the project
  // decides what it offers (here: `fetch`, wired to its own egress). Each entry is
  // the SAME shape as a provideCapability call ({ path, capability, instructions? });
  // a built-in is just a capability pre-provided in code instead of via an event.
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

// The Agent DO. One per agent, living UNDER a project (coordinate
// "<projectId>/agents/<name>"). It owns its identity and defines its own
// built-ins — here `whoami`. An agent context is born with these AND, on a miss,
// climbs to its project's context (the chain, Step 11): so an agent can call its
// own `whoami` AND the project's inherited `fetch` without re-providing it.
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
// Step 13 — the platform capability root. The root of the chain: every project
// context's parent, and itself parentless. It is the ONE context that is NOT a
// Durable Object and NOT a StreamProcessor — there is no stream to fold and
// nothing to persist, so it is just CONSTRUCTED IN CODE (per connection) and
// answers the SAME itx protocol (invokeCapability / describe) as any other
// context. What makes it the root:
//
//   - READ-ONLY: `provideCapability` / `revokeCapability` throw. You cannot
//     append to a context that has no log — so "you cannot provide into the
//     root" is structural, not a guard someone has to remember.
//   - NO PARENT: a capability miss has nowhere left to climb, so it just throws.
//
// Its capabilities are fixed, project-agnostic "catalog" caps, wired in as code:
// here a single `projects` cap (a { list, get }) — list the projects you can
// reach, get(id) to narrow into one. Adding a sibling (users, orgs, …) is just
// another entry, which is the whole reason the catalog rides the capability
// protocol instead of being bespoke handle code.
//
// (Production serves this from a named worker entrypoint dialed as a loopback,
// alongside the per-project defaults context; the toy constructs it inline
// because it is stateless and n-of-1. The catalog there narrows to a live
// project itx HANDLE and scopes `list` to the connect-time principal's access;
// the toy returns the context ref and scopes by a plain access list.)
// ---------------------------------------------------------------------------

// The catalog: every project any principal could reach (derived from the auth
// map). A global handle scoped to `access` only ever sees a subset of this.
const KNOWN_PROJECTS = [...new Set(Object.values(step08.PRINCIPALS).flatMap((p) => p.projects))];

export class GlobalContext implements ItxContext {
  #access: "all" | string[];
  // The fixed catalog capabilities. ONE cap `projects` whose deep path
  // (projects.list / projects.get(id)) replays onto this object — the exact same
  // deep-path shape as the mounted Slack SDK in Step 6.
  #capabilities: Record<string, any>;

  constructor(args: { access: "all" | string[] }) {
    this.#access = args.access;
    const reachable = () => (this.#access === "all" ? KNOWN_PROJECTS : this.#access);
    this.#capabilities = {
      projects: {
        list: () => reachable(),
        get: (id: string) => {
          if (!reachable().includes(id)) throw new Error(`no access to project "${id}"`);
          // Production narrows to a live project itx HANDLE here; the toy returns
          // the project's context ref (the narrowing target) to stay naked-stub simple.
          return { id, ref: `prj:${id}` };
        },
      },
    };
  }

  // The itx protocol — read side. Longest registered prefix wins, then the
  // remainder of the path is replayed onto the resolved cap (the same primitive
  // the StreamProcessor uses). The root has NO parent: the chain bottoms out here.
  async invokeCapability({ path, args = [] }: { path: string[]; args?: unknown[] }) {
    for (let i = path.length; i >= 1; i--) {
      const cap = this.#capabilities[path.slice(0, i).join(".")];
      if (cap) return await replayPath(cap, path.slice(i), args);
    }
    throw new Error(`no capability "${path.join(".")}" (the global root context has no parent)`);
  }

  // Same `DescribeResult` shape as a real context (enforced by `implements
  // ItxContext`), so it nests under a child's `parentCapabilities` uniformly —
  // except the root has no fold, so its capabilities are empty and it has no parent.
  async describe(): Promise<DescribeResult> {
    return {
      capabilities: [],
      // The root has no fold; its `projects` catalog is a built-in, listed the
      // same way a project context lists its `fetch` or an agent its `whoami`.
      builtins: [
        {
          path: ["projects"],
          kind: "live",
          address: null,
          instructions:
            "the project catalog: list() what you can reach, get(id) to narrow into one",
          types: null,
        },
      ],
      context: { name: "global", parent: null },
    };
  }

  // READ-ONLY — there is no log to append to.
  async provideCapability(): Promise<never> {
    throw new Error(
      "the global root context is stateless and read-only — you cannot provide a capability into it",
    );
  }
  async revokeCapability(): Promise<never> {
    throw new Error(
      "the global root context is stateless and read-only — there is nothing to revoke",
    );
  }
}

// The edge adapter for serving the global context directly to a client (the
// same role WorkerHandle plays for the ItxDO): it translates the dynamic proxy's
// positional `invokeCapability(path, args)` into the context's bag
// `invokeCapability({ path, args })` and forwards the verbs (so `provideCapability`
// throws over the wire). A naked stub can then call `global.projects.list()` and friends.
class GlobalItxRpcTarget extends RpcTarget {
  #global: GlobalContext;
  constructor(global: GlobalContext) {
    super();
    this.#global = global;
  }
  invokeCapability(path: string[], args: unknown[]) {
    return this.#global.invokeCapability({ path, args });
  }
  describe() {
    return this.#global.describe();
  }
  provideCapability() {
    return this.#global.provideCapability();
  }
  revokeCapability() {
    return this.#global.revokeCapability();
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
    if (path === "/steps/02-server-calls-client") {
      return step02.handle(request);
    }
    if (path === "/steps/03-provide-invoke") {
      return step03.handle(request);
    }
    if (path === "/steps/04-durable-object") {
      return step04.handle(request, env as any, ctx);
    }

    // Step 08 — auth: only complete the socket if the token grants the project,
    // and scope the itx to that project's own context (named by project id).
    if (path === "/steps/08-auth") {
      const project = url.searchParams.get("project") ?? "";
      const auth = step08.authorizeProjectAccess(request, project);
      if (!auth.ok) return new Response(auth.message, { status: auth.status });

      const node = env.ITX.getByName(`prj:${project}`);
      const main = dynamicHandle({ rpcTarget: new WorkerHandle(node) });
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
    // project; a miss on the agent resolves against the project. Auth is the
    // same project check as Step 08.
    if (path === "/steps/11-chain") {
      const project = url.searchParams.get("project") ?? "";
      const agent = url.searchParams.get("agent");
      const auth = step08.authorizeProjectAccess(request, project);
      if (!auth.ok) return new Response(auth.message, { status: auth.status });

      const coordinate = agent ? `prj:${project}/agents/${agent}` : `prj:${project}`;
      const node = env.ITX.getByName(coordinate);
      const main = dynamicHandle({ rpcTarget: new WorkerHandle(node) });
      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();
      newWebSocketRpcSession(server as unknown as WebSocket, main);
      ctx.waitUntil(
        new Promise<void>((resolve) => server.addEventListener("close", () => resolve())),
      );
      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    // Step 13 — the platform capability root. Authenticate the principal (no
    // project: the root is not project-scoped) and serve the STATELESS global
    // context, scoped to the projects that principal may reach. There is no DO
    // and no stream here — the context is constructed per connection.
    if (path === "/steps/13-platform-root") {
      const principal = step08.authenticate(request);
      if (!principal) return new Response("missing or invalid token", { status: 401 });
      const global = new GlobalContext({ access: principal.projects });
      const main = dynamicHandle({ rpcTarget: new GlobalItxRpcTarget(global) });
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
      const main = dynamicHandle({ rpcTarget: new WorkerHandle(node) });

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
