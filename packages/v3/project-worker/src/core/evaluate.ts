// core/evaluate.ts — the capability-path MATCHER + the EVALUATOR/DISPATCHER (split out of
// expression.ts so the codec there stays under one screen; re-exported from there so
// ./core/expression.ts remains the single import site). `match` claims a call for a mount; `evaluate`
// walks a concrete Expression against a SCOPE of named roots; `apply` finishes a matched call;
// `pathProxy` is the programmatic write-half that builds a dotted Expression. Authority is re-derived
// from the handed scope on every call — nothing here captures it, so deleting a stored expression IS
// revocation.
import { codedError } from "./errors.ts";
import type { Expression } from "./expression.ts";

/** A successful claim of a call by a capability path. */
export type Match = {
  /** THE ranking rule: the longest matching path wins; ties go to the newest mount. */
  matchedSegments: number;
  /** The call's args at the boundary, when the FINAL segment matched a call step (path `itx.grok` vs
   *  call `itx.grok({...})`) — applied to the evaluated target. */
  boundaryArgs?: unknown[];
  /** The call's unmatched tail, replayed on the evaluated target. */
  remainder: Expression;
};

/** Claim `call` with a capability path: each segment matches a same-named string step, or — FINAL
 *  segment only — a same-named call step whose args become the boundary args. Longest match wins. */
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

// RPC exposure doctrine (Kenton, workerd #1028), enforced HERE at THE dispatch point — the parser's
// name blacklist is client-side convenience that the structured-Expression and dotted-invoke doors
// bypass: what an object merely INHERITS from Object/Function.prototype is not capability surface, and
// the three magic names never resolve. Refusal is indistinguishable from absence (same as a missing
// step), so callers cannot probe. Identity-based on purpose, never a descriptor walk: views may be
// Proxies (pathProxy, capnweb / Workers-RPC stubs) whose descriptor traps don't mirror `get`. An
// own/override with the same name resolves to a DIFFERENT function and passes — the object chose it.
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

// THE step walk (shared by evaluate + apply): property steps `Reflect.get` carrying the receiver; call
// steps `Reflect.apply` ON that receiver (detaching a method from a Workers-RPC receiver breaks it);
// every step is awaited so stub-returning calls pipeline. `where` names the walk in errors.
async function walkSteps(
  start: { value: unknown; receiver: unknown },
  steps: Expression,
  where: string,
): Promise<{ value: unknown; receiver: unknown }> {
  let { value, receiver } = start;
  for (const step of steps) {
    value = await value;
    if (value == null) throw new Error(`${where} hit ${String(value)} at ${JSON.stringify(step)}`);
    if (typeof step === "string") value = stepGet((receiver = value) as object, step);
    else {
      const fn = stepGet(value as object, step[0]);
      if (typeof fn !== "function")
        throw codedError("NOT_A_METHOD", `${where}: ${JSON.stringify(step[0])} is not a method`);
      receiver = undefined;
      value = await Reflect.apply(fn, value, step.slice(1));
    }
  }
  return { value: await value, receiver };
}

// ⚠️ THE DataCloneError LEARNING LIVES HERE — invoke facet/RPC-stub methods with
// `Reflect.apply(fn, receiver, args)`, NEVER `stub[m].apply(stub, args)`: reading `.apply` off an RPC
// stub's method proxy is a capnweb PIPELINED REMOTE PATH; calling it passes the stub as an argument,
// so workerd serializes it — and a Worker-Loader facet stub may never be serialized
// (`requireAllowsTransfer()` throws) → `DataCloneError: Durable Object Facet stubs cannot be
// transferred between Workers`. walkSteps does exactly the safe thing (stepGet + Reflect.apply,
// receiver carried); do not "simplify" it away — this idiom cost a full investigation.
/** Dotted-path invocation over a LOCAL object graph (facet stub, hosted class, any dotted view): walk
 *  intermediates receiver-preservingly, apply the terminal. ONE walk for every such door. */
export async function invokePath(
  target: unknown,
  path: string[],
  args: unknown[],
  where: string,
): Promise<unknown> {
  const steps = [...path.slice(0, -1), [path.at(-1)!, ...args]] as Expression;
  return (await walkSteps({ value: target, receiver: undefined }, steps, where)).value;
}

/** Walk a concrete expression against named scope roots. `Object.hasOwn` (not `in`) is the provenance
 *  gate — scope absence IS the gate, and `in` would leak Object.prototype names as phantom roots. */
export async function evaluate(
  scope: Record<string, unknown>,
  expr: Expression,
): Promise<{ value: unknown; receiver: unknown }> {
  const [root, ...steps] = expr;
  if (typeof root !== "string" || !Object.hasOwn(scope, root))
    throw new Error(`expression root ${JSON.stringify(root)} is not in scope`);
  return walkSteps({ value: scope[root], receiver: undefined }, steps, "expression");
}

/** Finish a matched call: evaluate the target, apply the boundary args on the carried receiver (the
 *  caller invoked at the mount itself), replay the remainder, then apply any runtime `extraArgs` (the
 *  fetch lane's live Request). A non-callable target receiving args is a LOUD error, never a silent
 *  drop. */
export async function apply(
  scope: Record<string, unknown>,
  target: Expression,
  m: Pick<Match, "boundaryArgs" | "remainder">,
  extraArgs?: unknown[],
): Promise<unknown> {
  let { value, receiver } = await evaluate(scope, target);
  if (m.boundaryArgs) {
    if (typeof value !== "function")
      throw new Error(
        `mount target is not callable but the call passed ${m.boundaryArgs.length} arg(s)`,
      );
    value = await Reflect.apply(value, receiver, m.boundaryArgs);
  }
  ({ value, receiver } = await walkSteps({ value, receiver }, m.remainder, "remainder"));
  if (extraArgs) {
    if (typeof value !== "function")
      throw new Error(
        `the resolved value is not callable but ${extraArgs.length} runtime arg(s) were passed`,
      );
    value = await Reflect.apply(value, receiver, extraArgs);
  }
  return await value;
}

/** The dotted surface as a runtime Proxy — the programmatic write-half of the codec: property gets
 *  accumulate path segments, calling hands `(segments, args)` to `call`. `then`/symbol probes return
 *  undefined so a proxy is never mistaken for a thenable mid-await. Calling the BARE root is a loud
 *  error (mirroring the parser) unless `allowRootCall` — a PROVIDER proxy, where a parked bare callback
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
