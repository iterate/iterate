// The client-safe half of the ONE calling convention (Law 6).
//
// The kernel (itx.ts) dispatches every capability as `target.call({ path,
// args })`. This module owns the pure pieces of that convention that must
// load OUTSIDE workerd, so nothing here may touch cloudflare:workers:
//
//   - replayPathCall     data → dots (receiver-preserving replay)
//   - isPathMissMessage  recognizes a replay's path-miss error
//
// The consumer-side dots → data proxy is createInvokeCapabilityPathProxy
// (domains/itx/utils.ts).
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
  call: { path: string[]; args: unknown[] },
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
  // Wording changes here must keep isPathMissMessage matching.
  const miss = (message: string) =>
    new Error(
      context?.capability
        ? `${message} (capability "${context.capability}") — describe() lists what exists.`
        : message,
    );

  if (!call.path.length) {
    if (typeof target !== "function") {
      throw miss("Capability invoked as a function but the target is not callable.");
    }
    return await target(...call.args);
  }

  let parent: unknown = target;
  for (const segment of call.path.slice(0, -1)) {
    parent = await (parent as Record<string, unknown>)[segment];
    if (!parent) {
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

/**
 * True when `message` is a replayPathCall traversal miss — the caller drove a
 * dotted path that does not exist on the replayed target (mid-path `hit
 * undefined`, leaf `did not resolve to a function`, or a non-callable root).
 * Deliberately NOT matched: the reserved-segment rejection above — that is a
 * protocol violation, not a wrong guess at the surface, and its message must
 * survive. Error normalizers use this to answer misses with their surface's
 * calling-convention grammar, so the caller's next attempt is shaped right.
 */
export function isPathMissMessage(message: string): boolean {
  return (
    message.includes("did not resolve to a function") ||
    /Capability path .* hit (undefined|null)\./.test(message) ||
    message.includes("Capability invoked as a function but the target is not callable")
  );
}
