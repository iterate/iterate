// The ONE consumer-side adapter for dynamic capability surfaces (Law 6).
//
// A PathProxy turns real JavaScript property access into a single terminal
// call: `proxy.chat.postMessage(args)` accumulates ["chat", "postMessage"]
// locally (zero round trips) and then invokes the supplied callback once.
// Both capability invoke modes ride on this: the callback either replays the
// path on a member-shaped target or delivers `{ path, args }` to a
// path-call target — the proxy itself doesn't know or care.
//
// This is the only place in the codebase that plays reserved-name games.
// Capability *names* are validated at registration time instead
// (protocol.ts), so the proxy only needs to protect protocol-level names on
// intermediate path segments.

import type { PathCall } from "./protocol.ts";

const RESERVED_PATH_SEGMENTS = new Set([
  "__proto__",
  "catch",
  "constructor",
  "dup",
  "finally",
  "hasOwnProperty",
  "map",
  "onRpcBroken",
  "prototype",
  "then",
  "toString",
  "valueOf",
]);

export type PathProxyCall = (input: PathCall) => unknown;

export type PathProxyOptions = {
  dispose?: () => void;
};

/**
 * Class-shaped constructor that actually returns a callable Proxy. The class
 * wrapper exists so call sites read as "this is an RPC-able object"; workerd
 * supports Proxy-wrapped functions/targets across RPC since the
 * DataCloneError limitation was fixed (workerd#3184).
 */
export class PathProxyRpcTarget {
  constructor(callPath: PathProxyCall, options: PathProxyOptions = {}) {
    return pathNode(callPath, [], options.dispose) as unknown as PathProxyRpcTarget;
  }
}

function pathNode(
  callPath: PathProxyCall,
  path: string[],
  dispose: (() => void) | undefined,
): Function {
  const fn = (...args: unknown[]) => callPath({ args, path });

  Object.defineProperty(fn, Symbol.dispose, {
    configurable: true,
    value() {
      dispose?.();
    },
  });

  return new Proxy(fn, {
    apply(_target, _thisArg, args) {
      return callPath({ args, path });
    },
    get(target, key, receiver) {
      // `then` must read as undefined so promise assimilation never mistakes
      // a path node for a thenable mid-chain.
      if (key === "then") return undefined;
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (RESERVED_PATH_SEGMENTS.has(key)) return undefined;
      if (key in target) return Reflect.get(target, key, receiver);
      return pathNode(callPath, [...path, key], dispose);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
      if (key in target) return undefined;
      if (typeof key === "symbol" || RESERVED_PATH_SEGMENTS.has(key)) return undefined;
      // Workers RPC probes own-property descriptors when serializing; report
      // path extensions as readable values so stubs traverse cleanly.
      return {
        configurable: true,
        enumerable: true,
        value: pathNode(callPath, [...path, key], dispose),
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
