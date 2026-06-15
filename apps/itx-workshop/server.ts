// server.ts — a complete Cloudflare Worker that hosts the itx workshop steps.
//
// One Worker, three WebSocket endpoints, one Durable Object.
//
//   /step0  -> Server (whoami)                            [Step 0]
//   /step1  -> RegisterServer (server calls back client)  [Step 1]
//   /itx    -> dynamicHandle over the DO's Itx core        [Steps 2-6]
//
// Steps 2-6 ALL talk to /itx with a NAKED capnweb stub — the same dynamic
// server-side proxy serves the verbs (provide/invoke/list) and deep dotted
// paths (itx.slack.chat.postMessage). There is no client-side path proxy.
//
// The DO is addressed by the constant name "itx" so every connection meets the
// same registry (the rendezvous claim).

import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse, newWebSocketRpcSession } from "capnweb";

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

// ---------------------------------------------------------------------------
// Steps 2/4/6: the Itx core registry. Lives INSIDE the DO.
// ---------------------------------------------------------------------------

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

function resolveLongestPrefix(
  caps: Map<string, unknown>,
  path: string[],
): { entry: unknown; remainder: string[] } | null {
  for (let i = path.length; i >= 1; i--) {
    const key = path.slice(0, i).join(".");
    if (caps.has(key)) {
      return { entry: caps.get(key), remainder: path.slice(i) };
    }
  }
  return null;
}

// Replay the remaining path onto a target, then call it with args. We call the
// LAST segment as a method ON its receiver (not detached + .apply), because a
// retained capnweb member is a stub whose `.apply` is a path segment, not a
// function — and calling `receiver[last](...args)` both preserves `this` and
// dispatches the stub correctly.
async function replayPath(target: any, remainder: string[], args: unknown[]) {
  if (remainder.length === 0) {
    return typeof target === "function" ? await target(...args) : target;
  }
  let receiver = target;
  for (let i = 0; i < remainder.length - 1; i++) {
    if (RESERVED.has(remainder[i])) throw new Error(`reserved segment "${remainder[i]}"`);
    receiver = receiver[remainder[i]];
  }
  const last = remainder[remainder.length - 1];
  if (RESERVED.has(last)) throw new Error(`reserved segment "${last}"`);
  return await receiver[last](...args);
}

class Itx extends RpcTarget {
  #caps = new Map<string, any>();

  provideCapability(name: string, target: any) {
    // capnweb disposes an argument stub when the provide call RETURNS, so a
    // naive `set(name, target)` is dead by the next call. Retain it (the
    // workshop's addendum: retainLiveProvider). A stub exposes dup(); a plain
    // object crosses by value with its function members as stubs, so we walk it
    // and dup each member.
    this.#caps.set(name, retain(target));
    return `provided ${name}`;
  }

  // Step 2/6: invoke accepts either a flat name (string) or a full path (array).
  async invoke(name: string | string[], args: unknown[]) {
    const path = Array.isArray(name) ? name : [name];
    const found = resolveLongestPrefix(this.#caps, path);
    if (!found) throw new Error(`no capability "${path.join(".")}"`);
    const { entry, remainder } = found;
    if (remainder.length === 0) {
      // direct call of a function capability
      if (typeof entry === "function") return await entry(...args);
      throw new Error(`capability "${path.join(".")}" is not callable`);
    }
    // path call: replay remainder onto the entry (e.g. slack.chat.postMessage)
    return await replayPath(entry, remainder, args);
  }

  // for tests: list registered names
  list() {
    return [...this.#caps.keys()];
  }
}

// Steps 5 & 6: the ONE server-side dynamic proxy. This is the whole trick that
// lets a NAKED capnweb client stub call `itx.runSwift(code)` AND deep paths like
// `itx.slack.chat.postMessage(msg)` with no client-side library — capnweb
// pipelines the dotted path from the bare stub into one message, and this proxy
// collapses it into a single `invoke(path, args)` against the runtime registry.
//
// Three non-obvious requirements (each cost a debugging round; all proven in
// min-dynamic-target.mjs and now live over real workerd):
//   1. The target must be FUNCTION-typed (a Proxy over `function(){}`), NOT a
//      Proxy over an RpcTarget. capnweb classifies an rpc-target by prototype
//      and forbids fabricated "instance properties"; a function-typed target is
//      traversed via Object.hasOwn, where fabricated own properties are allowed.
//   2. getOwnPropertyDescriptor is load-bearing, not just get. Server-side
//      capnweb does Object.hasOwn(value, segment) BEFORE reading value[segment];
//      without the descriptor trap every segment reads as absent and the chain
//      dies at ".chat of undefined". (This single missing trap was the entire
//      reason an earlier draft thought server-side path pipelining "didn't work"
//      over workerd — it does; the trap just has to be there.)
//   3. `has` must answer for non-reserved names too.
// Root verb names (provideCapability/invoke/list) resolve to the verb; any other
// name extends the accumulating path; the terminal call funnels into invoke().
const VERBS = new Set(["provideCapability", "invoke", "list"]);

function dynamicHandle(target: WorkerHandle, path: string[] = []): any {
  const verbAt = (key: string) => path.length === 0 && VERBS.has(key);
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
      return target.invoke(path, args as unknown[]);
    },
  });
}

export class ItxDO extends DurableObject {
  #itx = new Itx();

  // a METHOD that returns the RPC target (workerd can't pipeline through a property)
  itx() {
    return this.#itx;
  }
}

// ---------------------------------------------------------------------------
// The Worker: route each path to the right target. The WebSocket terminates in
// the (stateless) Worker; the DO only exposes its target via an RPC method.
// ---------------------------------------------------------------------------
interface Env {
  ITX: DurableObjectNamespace<ItxDO>;
}

// What the stateless Worker serves to each client: a LOCAL capnweb RpcTarget
// that forwards the four verbs to the DO. This keeps the client↔Worker boundary
// pure capnweb and the Worker↔DO boundary pure Workers-RPC — instead of
// re-exporting a raw Workers-RPC DO stub over capnweb (which tangles the two
// stub-lifetime systems). A client's live stub is passed THROUGH this handle to
// the DO; the handle's invocation is kept alive (ctx.waitUntil) so the stub
// stays callable when another client invokes it.
class WorkerHandle extends RpcTarget {
  #node: DurableObjectStub<ItxDO>;
  constructor(node: DurableObjectStub<ItxDO>) {
    super();
    this.#node = node;
  }
  provideCapability(name: string, target: any) {
    // Dup at THIS (Worker) layer first: `target` is a capnweb import from the
    // client; when this provide call returns, capnweb disposes that import,
    // which would break the DO's re-exported copy. dup() retains it so the
    // chain client→Worker→DO survives past the call.
    const retained = retain(target);
    return this.#node.itx().provideCapability(name, retained);
  }
  invoke(name: string | string[], args: unknown[]) {
    return this.#node.itx().invoke(name, args);
  }
  list() {
    return this.#node.itx().list();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/step0") {
      return newWorkersRpcResponse(request, new Server());
    }
    if (path === "/step1") {
      return newWorkersRpcResponse(request, new RegisterServer());
    }

    // Everything else rendezvouses in the ONE shared DO named "itx". The capnweb
    // session is terminated HERE, in the stateless Worker — the DO only exposes
    // its target via an RPC method (node.itx()). The client receives a NAKED
    // stub of the dynamic handle: it calls the verbs directly AND pipelines deep
    // dotted paths (itx.slack.chat.postMessage(...)) with no client-side library.
    if (path === "/itx") {
      const node = env.ITX.getByName("itx");
      const main = dynamicHandle(new WorkerHandle(node));

      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();
      newWebSocketRpcSession(server as unknown as WebSocket, main);

      // THE FIX: keep this invocation's I/O context alive for the socket's
      // lifetime. Without it, when this fetch returns, the Worker→DO RPC that
      // carries a client's live stub is torn down, and a later cross-client
      // call dies with "the execution context which hosts this callback is no
      // longer running." waitUntil holds the context open until the WS closes —
      // so the session terminates in the stateless Worker AND live caps work.
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
