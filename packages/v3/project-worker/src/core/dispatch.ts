// core/dispatch.ts — match a capability call to a mount, then EXECUTE it against a LIVE object graph
// (the codec that turns strings ⇄ these structures is ./expression.ts). One engine (`walkSteps`)
// under three doors — `evaluate` (from a named scope root), `invokePath` (from a bare target),
// `apply` (a matched mount). `pathProxy` is the programmatic write-half that builds expressions by
// being called. `match` claims a call for a capability path (longest-prefix; the final segment may
// consume the call's args as boundary args; the unmatched tail is the remainder apply() replays).

import { codedError } from "./errors.ts";
import type { Expression } from "./expression.ts";

/** A successful claim of a call by a capability path. */
export type Match = {
  /** THE RANKING RULE: the longest matching path wins; ties go to the newest mount. */
  matchedSegments: number;
  /** The call's args at the boundary, when the FINAL path segment matched a call step (`itx.grok`
   *  vs `itx.grok({...})`) — applied to the evaluated target. */
  boundaryArgs?: unknown[];
  /** The call's unmatched tail, replayed on the evaluated target. */
  remainder: Expression;
};

/** Claim `call` with a capability `path`, segment by segment from the start: each segment matches a
 *  string step of the same name, or — FINAL segment only — a call step of the same method (its args
 *  become the boundary args). No placeholders or captures (that generality had zero users and
 *  shipped two codec bugs before it was deleted in increment 55). */
export function match(path: readonly string[], call: Expression): Match | null {
  let boundaryArgs: unknown[] | undefined;
  for (let i = 0; i < path.length; i++) {
    const c = call[i];
    if (c === undefined) return null; // path longer than the call
    if (typeof c === "string") {
      if (c !== path[i]) return null;
    } else if (c[0] !== path[i] || i !== path.length - 1)
      return null; // call consume: final only
    else boundaryArgs = c.slice(1);
  }
  return { matchedSegments: path.length, boundaryArgs, remainder: call.slice(path.length) };
}

// RPC-EXPOSURE DOCTRINE (Kenton, workerd #1028), enforced at THE dispatch point: what an object
// merely INHERITS from Object/Function.prototype is not capability surface, and __proto__ /
// constructor / prototype never resolve. Refusal is indistinguishable from absence, so callers
// cannot probe. Identity-based on purpose — views may be Proxies (pathProxy, capnweb / Workers-RPC
// stubs) whose descriptor traps don't mirror `get` — never a descriptor walk; an own override with
// the same name resolves to a DIFFERENT function and is allowed (the doctrine permits what the
// object chose).
const INHERITED_BUILTINS = new Set<unknown>(
  [Object.prototype, Function.prototype].flatMap((proto) =>
    Object.getOwnPropertyNames(proto)
      .map((k) => Object.getOwnPropertyDescriptor(proto, k)?.value)
      .filter((v) => typeof v === "function"),
  ),
);

/** Resolve one step's property as capability surface — `undefined` for anything only inherited. */
export function stepGet(value: object, key: string): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  const resolved = Reflect.get(value, key);
  return INHERITED_BUILTINS.has(resolved) ? undefined : resolved;
}

/**
 * THE step walk (shared by `evaluate`, `apply`, `invokePath`): property steps `Reflect.get` with
 * the receiver carried; call steps `Reflect.apply` ON that receiver (detaching a method from a
 * Workers-RPC receiver breaks it); every step is awaited so stub-returning calls pipeline
 * naturally. `where` names the walk in errors (`expression` / `remainder`).
 *
 * ⚠️  DataCloneError LEARNING (a full investigation — see FACET-RPC-INVESTIGATION.md): invoke
 * facet/RPC-stub methods with `Reflect.apply(fn, receiver, args)`, NEVER `stub[m].apply(stub,
 * args)`. Reading `.apply` off an RPC stub's method proxy is a capnweb PIPELINED REMOTE PATH;
 * calling it passes the stub as an argument, so workerd serializes it — and a Worker-Loader facet
 * stub may never be serialized (`requireAllowsTransfer()` throws unconditionally) → `DataCloneError:
 * Durable Object Facet stubs cannot be transferred between Workers`. Do not "simplify" this away.
 */
async function walkSteps(
  start: { value: unknown; receiver: unknown },
  steps: Expression,
  where: string,
): Promise<{ value: unknown; receiver: unknown }> {
  let { value, receiver } = start;
  for (const step of steps) {
    value = await value;
    if (value == null) throw new Error(`${where} hit ${String(value)} at ${JSON.stringify(step)}`);
    if (typeof step === "string") {
      receiver = value;
      value = stepGet(value as object, step);
    } else {
      const [method, ...args] = step;
      const fn = stepGet(value as object, method);
      if (typeof fn !== "function")
        throw codedError("NOT_A_METHOD", `${where}: ${JSON.stringify(method)} is not a method`);
      receiver = undefined;
      value = await Reflect.apply(fn, value, args);
    }
  }
  return { value: await value, receiver };
}

/**
 * Dotted-path invocation over a LOCAL object graph — a facet stub, a hosted class, any dotted
 * view: walk the intermediates receiver-preservingly, apply the terminal. ONE walk for every "call
 * path X with args on this object" door (the parent's facetInvoke, the stateful runner); the
 * DataCloneError learning on `walkSteps` above is exactly why the hand-rolled copies it replaced
 * were the drift class.
 */
export async function invokePath(
  target: unknown,
  path: string[],
  args: unknown[],
  where: string,
): Promise<unknown> {
  const steps = [...path.slice(0, -1), [path.at(-1)!, ...args]] as Expression;
  return (await walkSteps({ value: target, receiver: undefined }, steps, where)).value;
}

/**
 * Walk a CONCRETE expression against named scope roots (`itx`, plus config-provenance built-ins;
 * event provenance simply lacks the built-ins in scope — unspellable, not policed). `Object.hasOwn`,
 * not `in`: scope absence IS the provenance gate, and `in` would leak Object.prototype names as
 * phantom roots.
 */
export async function evaluate(
  scope: Record<string, unknown>,
  expr: Expression,
): Promise<{ value: unknown; receiver: unknown }> {
  const [root, ...steps] = expr;
  if (typeof root !== "string" || !Object.hasOwn(scope, root))
    throw new Error(`expression root ${JSON.stringify(root)} is not in scope`);
  return walkSteps({ value: scope[root], receiver: undefined }, steps, "expression");
}

/** Apply `args` to a resolved value on its carried receiver, or a LOUD error if it is not callable
 *  (never the silent arg-drop apps/os shipped). */
async function callOn(value: unknown, receiver: unknown, args: unknown[]): Promise<unknown> {
  if (typeof value !== "function")
    throw new Error(`mount target is not callable but ${args.length} arg(s) were passed`);
  return Reflect.apply(value, receiver, args);
}

/**
 * Finish a matched call: evaluate the target, apply the boundary args at the mount itself (on the
 * carried receiver), replay the remainder on the result, then apply any runtime `extraArgs` — the
 * fetch lane hands the live Request in here, since a Request is not expression data.
 */
export async function apply(
  scope: Record<string, unknown>,
  target: Expression,
  m: Pick<Match, "boundaryArgs" | "remainder">,
  extraArgs?: unknown[],
): Promise<unknown> {
  let { value, receiver } = await evaluate(scope, target);
  if (m.boundaryArgs) value = await callOn(value, receiver, m.boundaryArgs);
  ({ value, receiver } = await walkSteps({ value, receiver }, m.remainder, "remainder"));
  if (extraArgs) value = await callOn(value, receiver, extraArgs);
  return await value;
}

/** The dotted surface as a runtime Proxy — the programmatic write-half of the codec: property gets
 *  accumulate path segments, calling hands `(segments, args)` to `call`. `then`/symbol probes return
 *  undefined so a proxy is never mistaken for a thenable mid-await. Calling the BARE root is a loud
 *  error (mirroring the parser) unless `allowRootCall` — a PROVIDER proxy whose parked bare callback
 *  IS the callable. */
export function pathProxy(
  call: (segments: string[], args: unknown[]) => unknown,
  opts?: { allowRootCall?: boolean },
): unknown {
  const build = (segments: string[]): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, p) =>
        p === "then" || typeof p === "symbol" ? undefined : build([...segments, p as string]),
      apply: (_t, _this, args) => {
        if (segments.length === 0 && !opts?.allowRootCall)
          throw new Error("cannot call the scope symbol itself — name a capability first");
        return call(segments, args as unknown[]);
      },
    });
  return build([]);
}
