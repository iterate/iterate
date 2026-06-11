// The ONE consumer-side adapter for dynamic capability surfaces (Law 6).
//
// A PathProxy turns real JavaScript property access into a single terminal
// call: `proxy.chat.postMessage(args)` accumulates ["chat", "postMessage"]
// locally (zero round trips) and then invokes the supplied callback once.
// The kernel knows exactly ONE calling convention — `target.call({ path,
// args })` — and this module owns both halves of bridging real objects onto
// it: `replayPathCall` (data → dots, receiver-preserving) and
// `asPathCallable` (wrap a member-shaped object so it speaks the
// convention, replaying in the process where the object is concrete).
//
// This is the only place in the codebase that plays reserved-name games.
// Capability *names* are validated at registration time instead
// (protocol.ts), so the proxy only needs to protect protocol-level names on
// intermediate path segments.

import { RpcTarget } from "capnweb";
import { RESERVED_PATH_SEGMENTS, type PathCall, type PathCallTarget } from "./protocol.ts";

export type PathProxyCall = (input: PathCall) => unknown;

/**
 * Class-shaped constructor that actually returns a callable Proxy. The class
 * wrapper exists so call sites read as "this is an RPC-able object"; workerd
 * supports Proxy-wrapped functions/targets across RPC since the
 * DataCloneError limitation was fixed (workerd#3184).
 */
export class PathProxyRpcTarget {
  constructor(callPath: PathProxyCall) {
    return pathNode(callPath, []) as unknown as PathProxyRpcTarget;
  }
}

function pathNode(callPath: PathProxyCall, path: string[]): Function {
  const fn = (...args: unknown[]) => callPath({ args, path });

  return new Proxy(fn, {
    apply(_target, _thisArg, args) {
      return callPath({ args, path });
    },
    get(target, key, receiver) {
      // `then` must read as undefined so promise assimilation never mistakes
      // a path node for a thenable mid-chain.
      if (key === "then") return undefined;
      // Symbols resolve on the function itself (e.g. Symbol.dispose). String
      // keys ALWAYS extend the path unless reserved — we never fall through to
      // Function.prototype, so an SDK method literally named `name`/`call`/
      // `bind`/`length` still traverses correctly. (The dangerous prototype
      // names are in RESERVED_PATH_SEGMENTS.)
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (RESERVED_PATH_SEGMENTS.has(key)) return undefined;
      return pathNode(callPath, [...path, key]);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
      if (typeof key === "symbol" || RESERVED_PATH_SEGMENTS.has(key)) return undefined;
      // Workers RPC probes own-property descriptors when serializing; report
      // path extensions as readable values so stubs traverse cleanly.
      return {
        configurable: true,
        enumerable: true,
        value: pathNode(callPath, [...path, key]),
        writable: false,
      };
    },
    has(target, key) {
      if (typeof key === "symbol") return key in target;
      if (RESERVED_PATH_SEGMENTS.has(key)) return false;
      return true;
    },
  });
}

/**
 * Receiver-preserving path replay — the server-side counterpart of the
 * proxy, and the only other place paths are interpreted (inside the
 * supervisor's invoke, spec §4.4).
 *
 * Walks `path` segments on `target` and calls the terminal method ON ITS
 * PARENT (`parent[method](...args)`), never pulling the function off first:
 * Workers RPC / WorkerEntrypoint methods may depend on their receiver, and
 * detaching them can make workerd try to transfer the entrypoint
 * (capnweb LEARNINGS, "Preserve Receivers").
 */
export async function replayPathCall(target: unknown, call: PathCall): Promise<unknown> {
  // Filter the path here too, not just in the consumer proxy: `itxInvoke` is
  // a public DO method, so a caller can hand-build a `path` and reach this
  // directly. This is the authoritative reserved-name gate.
  for (const segment of call.path) {
    if (RESERVED_PATH_SEGMENTS.has(segment)) {
      throw new Error(`Capability path segment "${segment}" is reserved.`);
    }
  }

  if (call.path.length === 0) {
    if (typeof target !== "function") {
      throw new Error("Capability invoked as a function but the target is not callable.");
    }
    return await target(...call.args);
  }

  let parent: unknown = target;
  for (const segment of call.path.slice(0, -1)) {
    parent = await (parent as Record<string, unknown>)[segment];
    if (parent == null) {
      throw new Error(`Capability path ${call.path.join(".")} hit ${String(parent)}.`);
    }
  }

  const method = call.path.at(-1)!;
  const holder = parent as Record<string, (...args: unknown[]) => unknown>;
  if (typeof holder[method] !== "function") {
    throw new Error(`Capability path ${call.path.join(".")} did not resolve to a function.`);
  }
  return await holder[method](...call.args);
}

/**
 * Make a member-shaped object speak the kernel's ONE calling convention:
 * `asPathCallable(obj).call({ path, args })` replays the path on `obj` via
 * {@link replayPathCall} — in THIS process, where `obj` is concrete.
 *
 * Two homes, one helper:
 * - Server-side, the registry wraps the concrete objects it dials itself
 *   (env bindings, loader entrypoints, facets) so dispatch never branches.
 * - Client-side, a live provider wraps a plain object-of-methods (or a bare
 *   function) before provideCapability(): the wrapper extends capnweb's
 *   RpcTarget so it crosses the session as a stub, and the replay then runs
 *   back in the provider's process. Providers that implement `call`
 *   themselves (the SDK-shaped FakeSlackSdk pattern) don't need it.
 */
export function asPathCallable(target: unknown): PathCallTarget {
  return new PathCallable(target);
}

class PathCallable extends RpcTarget {
  readonly #target: unknown;

  constructor(target: unknown) {
    super();
    this.#target = target;
  }

  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this.#target, input);
  }
}
