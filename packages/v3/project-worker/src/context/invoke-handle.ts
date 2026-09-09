// context/invoke-handle.ts — THE DOTTED DOOR: how a surface that declares only fixed methods
// (`IterateContext`: invoke / provide / subscribe / …; a mid-chain handle: invoke / applyRoot) is
// spoken as deep dotted access — `itx.slack.chat.postMessage({...})`, `itx.kv.put('k','v')`,
// `handle.demo.timer.callLater()` — with every unknown segment accumulating into ONE
// `invoke(expression)` dispatch, `[...root, ...prefix, [method, ...args]]`. Declared members always
// win. Three pieces, one file: the reserved names, the function-backed PATH PROXY, and the
// PROTOTYPE HOP that installs the fallback on a class; then `InvokeHandle`, the genuine RpcTarget a
// mid-chain capability is handed back as, and `walkStepsOnRpcStub`, the step walk over a capnweb stub.
//
// WHY A PROTOTYPE HOP AND NOT A PROXY AROUND THE INSTANCE (the design this clean room tried FIRST
// and reverted): workerd RPC classifies a call's RESULT for promise pipelining with native brand
// checks that a JS Proxy can never pass (`serializeJsValueWithPipeline` in workerd's worker-rpc.c++
// → falls to `NonPipelinable`; upstream: cloudflare/workerd#6873). So a surface returned FROM A
// METHOD must hand back a REAL, unproxied instance or every pipelined call on it dies with "The RPC
// receiver does not implement the method ...". A mid-chain call returns its handle ACROSS an RPC
// boundary (`itx.facets.get('b').hello()` is two dispatches — `get('b')` returns the handle, then
// `.hello()` is called ON it), and capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on
// workerd, so a real RpcTarget passes on both hops and the second call pipelines. The hop squares
// that with dynamic dispatch by inserting one proxied link BETWEEN `Class.prototype` and its parent:
//
//   instance ──proto──▶ Class.prototype ──proto──▶ Proxy(hop) ──proto──▶ parent
//
// - The instance is a genuine, natively-branded RpcTarget → workerd's pipeline classifier accepts
//   it (SingleStub), so `x.get(p).method()` chains work in one expression.
// - Declared members (own prototype methods/getters) resolve BEFORE the hop — built-ins win, so a
//   dynamic capability can never shadow a declared name (the deliberate trade-off).
// - Unknown string keys reach the hop's `get` trap and become path proxies, dispatched via the
//   receiver's own `invoke`; the receiver IS the invoker, so it wires with zero glue.
// - Instances stay clean of own properties, so Workers RPC's instance-property protection needs
//   no `getOwnPropertyDescriptor` help.
//
// KNOWN QUIRKS (accepted, by parity with apps/os): no `has` trap on the hop, so `"x" in instance`
// reflects DECLARED members only while `instance.x` conjures a dispatcher — feature-detect with
// access, not `in`; a typo'd built-in (`itx.strems`) is a syntactically valid dynamic dispatch that
// fails at the capability table, not a crisp missing-method error.
//
// The library tier may import this module and the codec only (library/boundary.test.ts).

import { RpcTarget } from "capnweb";
import type { ItxExpression } from "./expression.ts";

/** The dispatch door every dotted miss collapses onto. `IterateContext` implements it directly (root
 *  `itx`); a mid-chain `InvokeHandle` implements it relative to itself (empty root). */
type InvokeTarget = {
  invoke(itxExpression: ItxExpression): unknown;
};

/** Names that must NEVER become dynamic capability segments — a dispatcher answering them would turn
 *  a plain property probe into a live capability call. Enforced at the prototype-chain hop and at
 *  every depth of the path proxies it hands out. Two kinds, one set: */
const RESERVED: ReadonlySet<string> = new Set([
  // JS/RPC protocol machinery a framework or capnweb probes on any object (`then` above all: an
  // instance must never look thenable, or every `await` of it would resolve a capability).
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
  // Names common protocols LOOK UP on arbitrary objects and CALL if callable: JSON.stringify
  // (toJSON) and vitest/jest equality (asymmetricMatch). The asymmetricMatch case is worse than
  // noise — vitest treats any object with a callable asymmetricMatch as an asymmetric matcher, and
  // a dispatcher returning a (truthy) Promise makes the equality SPURIOUSLY PASS. The bar for this
  // half is HIGH (these names become unreachable as dotted segments; explicit invoke still
  // reaches them): probed-and-called by ubiquitous protocols AND implausible as capability names.
  "toJSON",
  "asymmetricMatch",
]);

/** The path proxy: a function-backed Proxy (not an RpcTarget instance) — each missing property
 *  extends `path`, and applying the function reduces the whole accumulated access into ONE
 *  `invoke(expression)` call, `[...root, ...path.slice(0, -1), [path.at(-1), ...args]]`. */
function createItxExpressionPathProxy(
  invoker: InvokeTarget,
  root: readonly string[],
  path: string[],
): unknown {
  const valueFor = (key: string) => createItxExpressionPathProxy(invoker, root, [...path, key]);
  return new Proxy(function () {}, {
    apply(_target, _thisArg, args) {
      const method = path[path.length - 1];
      const expr: ItxExpression = [...root, ...path.slice(0, -1), [method, ...(args as unknown[])]];
      return invoker.invoke(expr);
    },
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (RESERVED.has(key)) return undefined;
      return valueFor(key);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
      if (typeof key === "symbol" || RESERVED.has(key)) return undefined;
      // Cap'n Web's server-side path traversal probes own descriptors before reading a segment.
      // Dynamic roots need to look discoverable here so calls like
      // itx.slack.chat.postMessage(...) reach the apply trap.
      return { configurable: true, enumerable: true, value: valueFor(key), writable: false };
    },
    has(target, key) {
      if (typeof key === "symbol") return key in target;
      return !RESERVED.has(key);
    },
  });
}

/** Install the dotted fallback on a class's PROTOTYPE CHAIN (the hop drawn in the header): declared
 *  members win through normal property lookup, and only missing roots become path proxies that
 *  dispatch through the receiver's own `invoke` with the scope `root` (`["itx"]` for the edge
 *  context, `[]` for a handle). Call ONCE per class. Constructor inheritance (`super()`) is
 *  untouched — only `Class.prototype`'s parent link changes, and the hop forwards everything it does
 *  not intercept. */
export function installPrototypeInvokeFallback<T extends abstract new (...args: never[]) => object>(
  cls: T,
  root: readonly string[],
): void {
  const parentPrototype = Object.getPrototypeOf(cls.prototype) as object;
  const hop = new Proxy(Object.create(parentPrototype) as object, {
    get(hopTarget, key, receiver) {
      // Symbols and anything the parent chain already answers (dispose protocol, capnweb
      // internals, Object.prototype) pass through with the instance as receiver.
      if (typeof key === "symbol" || key in hopTarget) {
        return Reflect.get(hopTarget, key, receiver);
      }
      if (RESERVED.has(key)) return undefined;
      // The dynamic fallback exists for INSTANCES. A lookup whose receiver is not one — someone
      // probing `Class.prototype.foo` directly, a framework walking prototypes — must see plain
      // "undefined", not conjure a dispatcher over an uninitialized receiver.
      if (!(receiver instanceof (cls as unknown as abstract new (...args: never[]) => object))) {
        return undefined;
      }
      // The receiver IS the invoker (it implements invoke). Its method resolves at CALL
      // time, so a trap firing mid-construction (a property miss on `this` before field initializers
      // ran) can't bake a dispatcher over half-initialized state into the path proxy.
      return createItxExpressionPathProxy(receiver as unknown as InvokeTarget, root, [key]);
    },
  });
  Object.setPrototypeOf(cls.prototype, hop);
}

/** A branded, pipelinable handle for a MID-CHAIN capability (a live row's transport bridge,
 *  `facets.get(name)`, `cd(path)`, `workers.get(spec)` / `facets.get(name, { source, className })`)
 *  whose unknown dotted members reduce into ONE dispatch of the itx-expression STEPS relative to it.
 *  `dispatch` routes those steps into the underlying object — a borrowed rpc stub
 *  (`RpcStubDirectory.invokeRpcStub`), a facet's method walk (the DO's facet door), a sibling
 *  context, or a stateful loaded class. Declared members (`invoke` / `applyRoot`) win over the
 *  fallback, so a capability cannot be named either — the two reserved words this wrapper adds.
 *  Providers stay plain `RpcTarget` subclasses (which capnweb already requires to pass a capability
 *  by reference); the client stays just capnweb. */
export class InvokeHandle extends RpcTarget {
  readonly #dispatchItxExpressionSteps: (itxExpressionSteps: ItxExpression) => unknown;
  constructor(dispatchItxExpressionSteps: (itxExpressionSteps: ItxExpression) => unknown) {
    super();
    this.#dispatchItxExpressionSteps = dispatchItxExpressionSteps;
  }
  /** THE reduce door the prototype hop dispatches onto (the receiver IS the invoker — this instance).
   *  The expression is RELATIVE to this handle (empty scope root — the hop is installed with `[]`). */
  invoke(itxExpressionSteps: ItxExpression): unknown {
    return this.#dispatchItxExpressionSteps(itxExpressionSteps);
  }
  /** Root-apply: call the bare capability this handle fronts — the ANONYMOUS call step. `callOn`
   *  (dispatch.ts) uses this when a rewritten call's target IS an InvokeHandle and args are applied
   *  to it — `handle(events, range)` ⇒ the lent callback the handle delivers to. */
  applyRoot(args: unknown[]): unknown {
    return this.#dispatchItxExpressionSteps([["", ...args]]);
  }
}
installPrototypeInvokeFallback(InvokeHandle, []);

/** Walk itx-expression steps off a capnweb stub (a session's lent client stub, a remote API's main
 *  object): a property step reads through the stub, a call step calls the method, the ANONYMOUS call
 *  step (`""`) calls the value itself (a bare function lent as a capability). NO await inside the
 *  loop: on a capnweb stub every step is a PIPELINED path — a property read yields a stub for the
 *  property, a call yields a promise that is itself a stub — so an n-step chain costs ONE round trip,
 *  flushed by the caller's single await; a rejection anywhere in the chain lands there too. A DIRECT
 *  call on the stub, never `.apply`: reading `.apply` off a capnweb stub's method is itself a
 *  pipelined remote path (dispatch.ts's DataCloneError learning). Lives HERE, beside the handle, and
 *  not with `walkSteps` in dispatch.ts: the library tier may import this module and the codec only
 *  (library/boundary.test.ts), and library/capnweb.ts walks a remote's stub with it. */
export function walkStepsOnRpcStub(stub: unknown, steps: ItxExpression): unknown {
  let value: unknown = stub;
  for (const step of steps) {
    if (typeof step === "string") value = (value as Record<string, unknown>)[step];
    else {
      const [method, ...args] = step;
      value =
        method === ""
          ? (value as (...a: unknown[]) => unknown)(...args)
          : (value as Record<string, (...a: unknown[]) => unknown>)[method](...args);
    }
  }
  return value;
}

// ── the two BRANDS the subscription delivery loop reads ──
// A subscription's target evaluates to SOMETHING; the loop asks the value what it is. These two
// kinds OWN THEIR PROGRESS, so a push needs no cursor on the stream side: a facet keeps its own
// checkpoint and gap-repairs from the log (stream/processor.ts), a live client owns its offset (it
// chains delivered ranges and heals with readEvents). Anything else — a Worker-Loader entrypoint, a
// sibling context, a remote — cannot, and the stream keeps a cursor for it (subscription-delivery.ts).
// Nothing is declared on any event; the brand is minted where the built-in mints the handle.

/** `itx.facets.get(name)` / `itx.facets.get(name, { source, className })` — a facet of this context. */
export class FacetHandle extends InvokeHandle {}
/** `itx.rpcStubs.get(key)` — a live stub lent to the registry. */
export class RpcStubHandle extends InvokeHandle {}
