// The client-safe half of the ONE calling convention (Law 6).
//
// The kernel (itx.ts) dispatches every capability as `target.call({ path,
// args })`. This module owns the two pure pieces of that convention that
// must load OUTSIDE workerd — withItx providers in Node and the browser
// REPL import them at runtime, so nothing here may touch cloudflare:workers
// (itx.ts re-exports all of it for server-side imports):
//
//   - PathProxy        dots → data (consumer side, zero round trips)
//   - replayPathCall   data → dots (receiver-preserving replay)
//
// There is deliberately NO callsite wrapper here: a plain object (or bare
// function) IS a live capability — the core's dispatch replays paths onto
// its members (itx.ts). The only things at an itx callsite are capnweb /
// Workers RPC stubs and your own objects.
//
// This is the only place in the codebase that plays reserved-name games.
// Capability *names* are validated at registration time instead (itx.ts), so
// the proxy only needs to protect protocol-level names on intermediate path
// segments.

// The ONE calling convention's shapes.
type PathCall = { path: string[]; args: unknown[] };

/**
 * The optional self-description method the core probes at provide time
 * (itx.ts): a call-implementing target answering `call({ path:
 * ["describeItx"], args: [] })` with `{ types?, instructions? }` describes
 * itself into the journaled meta. Reserved below so user capability paths
 * can never collide with the protocol name.
 */
const SELF_DESCRIPTION_METHOD = "describeItx";

/**
 * Names that must never traverse a dynamic surface — prototype-pollution
 * vectors, capnweb stub controls, and thenable/`Function.prototype` traps.
 * The single source of truth for BOTH the consumer-side path proxy and the
 * server-side path replay (`replayPathCall`), so a hand-built `path` reaching
 * `invoke` directly is filtered identically.
 */
const RESERVED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  SELF_DESCRIPTION_METHOD,
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "apply",
  "bind",
  "call",
  "catch",
  "constructor",
  "dup",
  "finally",
  "hasOwnProperty",
  "isPrototypeOf",
  "map",
  "onRpcBroken",
  "propertyIsEnumerable",
  "prototype",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
]);

type PathProxyCall = (input: PathCall) => unknown;

/**
 * Class-shaped constructor that actually returns a callable Proxy: real
 * JavaScript property access accumulates a path locally (zero round trips)
 * and the terminal call invokes the supplied callback once. The class wrapper
 * exists so call sites read as "this is an RPC-able object"; workerd supports
 * Proxy-wrapped functions/targets across RPC since the DataCloneError
 * limitation was fixed (workerd#3184).
 */
export class PathProxy {
  constructor(callPath: PathProxyCall) {
    return pathNode(callPath, []) as unknown as PathProxy;
  }
}

function pathNode(callPath: PathProxyCall, path: string[]): Function {
  return new Proxy((...args: unknown[]) => callPath({ args, path }), {
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
 * supervisor's invoke, itx.ts).
 *
 * Walks `path` segments on `target` and calls the terminal method ON ITS
 * PARENT (`parent[method](...args)`), never pulling the function off first:
 * Workers RPC / WorkerEntrypoint methods may depend on their receiver, and
 * detaching them can make workerd try to transfer the entrypoint
 * (capnweb LEARNINGS, "Preserve Receivers").
 */
export async function replayPathCall(
  target: unknown,
  call: PathCall,
  context?: { capability?: string },
): Promise<unknown> {
  // Filter the path here too, not just in the consumer proxy: `invoke` is a
  // public verb, so a caller can hand-build a `path` and reach this directly.
  // This is the authoritative reserved-name gate.
  for (const segment of call.path) {
    if (RESERVED_PATH_SEGMENTS.has(segment)) {
      throw new Error(`Capability path segment "${segment}" is reserved.`);
    }
  }

  // A replay MISS on a known capability points the caller back at discovery
  // — the suffix is only honest when a name exists for describe() to show.
  const miss = (message: string) =>
    new Error(
      context?.capability
        ? `${message} (capability "${context.capability}") — describe() lists what exists.`
        : message,
    );

  if (call.path.length === 0) {
    if (typeof target !== "function") {
      throw miss("Capability invoked as a function but the target is not callable.");
    }
    return await target(...call.args);
  }

  let parent: unknown = target;
  for (const segment of call.path.slice(0, -1)) {
    parent = await (parent as Record<string, unknown>)[segment];
    if (parent == null) {
      throw miss(`Capability path ${call.path.join(".")} hit ${String(parent)}.`);
    }
  }

  const method = call.path.at(-1)!;
  const holder = parent as Record<string, (...args: unknown[]) => unknown>;
  if (typeof holder[method] !== "function") {
    throw miss(`Capability path ${call.path.join(".")} did not resolve to a function.`);
  }
  return await holder[method](...call.args);
}
