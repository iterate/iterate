// context/dispatch.ts — EXECUTE a rewritten call's steps against a LIVE object graph (the codec that
// turns strings ⇄ these structures is ./expression.ts; the rules that rewrite a call to a built-in
// root are ./itx-expression-rewriting.ts). `walkSteps` is THE step walk — `ItxExpressionResolver`
// replays the steps after the root with it; the facet door and the delivery loop walk steps on a
// local object with it. `callOn` applies args to a resolved value. The dotted write-half (a handle
// whose dotted access reduces into one dispatch) is `InvokeHandle` (context/invoke-handle.ts) — the
// ONE such primitive, pipelinable over Workers RPC.

import { codedError } from "../lib/errors.ts";
import type { ItxExpression } from "./expression.ts";
import { InvokeHandle } from "./invoke-handle.ts";

// Promise brands the step walk threads UNAWAITED (see walkSteps): property access and calls
// pipeline on them natively, so the whole chain reduces into one round trip and the caller's terminal
// await is the single flush. worker.ts registers the native cloudflare:workers RpcPromise/RpcProperty
// at boot — that import can't live here because the unit lane runs this module in Node, where the
// list stays empty and every step is simply awaited.
const PIPELINED_RPC_BRANDS: (abstract new (...args: never[]) => unknown)[] = [];
/** Register a pipelinable promise brand (the workerd entrypoint's two calls at boot). */
export function registerPipelinedRpcBrand(brand: abstract new (...args: never[]) => unknown): void {
  PIPELINED_RPC_BRANDS.push(brand);
}
const pipelined = (v: unknown): boolean => PIPELINED_RPC_BRANDS.some((b) => v instanceof b);

// RPC-EXPOSURE DOCTRINE (Kenton, workerd #1028), enforced at THE dispatch point: what an object
// merely INHERITS from Object/Function.prototype is not capability surface, and __proto__ /
// constructor / prototype never resolve. Refusal is indistinguishable from absence, so callers
// cannot probe. Identity-based on purpose — views may be Proxies (capnweb / Workers-RPC
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
function stepGet(value: object, key: string): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  const resolved = Reflect.get(value, key);
  return INHERITED_BUILTINS.has(resolved) ? undefined : resolved;
}

/**
 * THE step walk: property steps `Reflect.get` with the receiver carried; call steps `Reflect.apply`
 * ON that receiver (detaching a method from a Workers-RPC receiver breaks it); every step is awaited
 * so stub-returning calls pipeline naturally. `where` names the walk in errors.
 *
 * ⚠️  DataCloneError LEARNING (a full investigation — see FACET-RPC-INVESTIGATION.md): invoke
 * facet/RPC-stub methods with `Reflect.apply(fn, receiver, args)`, NEVER `stub[m].apply(stub,
 * args)`. Reading `.apply` off an RPC stub's method proxy is a capnweb PIPELINED REMOTE PATH;
 * calling it passes the stub as an argument, so workerd serializes it — and a Worker-Loader facet
 * stub may never be serialized (`requireAllowsTransfer()` throws unconditionally) → `DataCloneError:
 * Durable Object Facet stubs cannot be transferred between Workers`. Do not "simplify" this away.
 */
export async function walkSteps(
  start: { value: unknown; receiver: unknown },
  steps: ItxExpression,
  where: string,
): Promise<{ value: unknown; receiver: unknown }> {
  let { value, receiver } = start;
  for (const step of steps) {
    // A pipelinable RPC promise (native workerd — PIPELINED_RPC_BRANDS) must NOT be awaited
    // mid-chain: property access and calls pipeline on it natively, so the whole chain reduces into
    // one round trip and the caller's terminal await settles it (a facet's `.get(n).method()`, a
    // loaded entrypoint's `.run()`). Everything else (plain promises, thenables) keeps the
    // await-every-step behavior.
    if (!pipelined(value)) value = await value;
    if (value == null) throw new Error(`${where} hit ${String(value)} at ${JSON.stringify(step)}`);
    if (typeof step === "string") {
      receiver = value;
      value = stepGet(value as object, step);
    } else {
      const [method, ...args] = step;
      if (method === "") {
        // the ANONYMOUS call step (expression.ts): call the value itself — a live stub's root call
        value = callOn(value, receiver, args);
        receiver = undefined;
        if (!pipelined(value)) value = await value;
        continue;
      }
      const fn = stepGet(value as object, method);
      if (typeof fn !== "function")
        throw codedError("NOT_A_METHOD", `${where}: ${JSON.stringify(method)} is not a method`);
      receiver = undefined;
      value = Reflect.apply(fn, value, args);
      if (!pipelined(value)) value = await value;
    }
  }
  return { value: pipelined(value) ? value : await value, receiver };
}

/** Apply `args` to a resolved value on its carried receiver, or a LOUD error if it is not callable
 *  (never the silent arg-drop apps/os shipped). An `InvokeHandle` (a mid-chain capability handle —
 *  a live stub's transport bridge, a facet handle, a borrowed callback stub the delivery loop pushes to) is NOT a JS function
 *  (it is a real RpcTarget so dotted access pipelines — context/invoke-handle.ts), so ROOT-calling it
 *  means dispatching those args at its EMPTY path: `handle(events,range)` ⇒ the bare callback the
 *  handle fronts. This is the one bridge between "callable capability" and "pipelinable RpcTarget". */
export async function callOn(value: unknown, receiver: unknown, args: unknown[]): Promise<unknown> {
  if (typeof value === "function") return Reflect.apply(value, receiver, args);
  if (value instanceof InvokeHandle) return value.applyRoot(args);
  throw new Error(`target is not callable but ${args.length} arg(s) were passed`);
}
