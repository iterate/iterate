// context/dotted-path-proxy.ts — THE NATURAL DOTTED CLIENT SURFACE.
//
// A client is JUST capnweb (iterate-context.ts invariant): what it holds is a plain capnweb proxy
// of the server-side `IterateContext` RpcTarget. This module is what lets that proxy be spoken as deep
// dotted property access — `itx.slack.chat.postMessage({...})`, `itx.kv.put('k','v')`,
// `itx.myLiveCap.hello()` — even though `IterateContext` declares only fixed methods
// (invoke / provide / rewrite / …). Every unknown segment accumulates into ONE `invoke`
// dispatch carrying an `ItxExpressionInput`; declared methods always win.
//
// `IterateContext.invoke(ItxExpressionInput)` is the exact InvokeTarget shape this
// expects (installed with scope root `["itx"]`), and the receiver IS the invoker — so it wires with
// zero glue.

import type { ItxExpression, ItxExpressionInput } from "./expression.ts";

/** The dispatch door every dotted miss collapses onto. `IterateContext` implements it directly (root `itx`); a
 *  mid-chain `InvokeHandle` implements it relative to itself (empty root). The accumulated dotted
 *  access reduces into ONE `ItxExpressionInput` — `[...root, ...prefix, [method, ...args]]`. */
type InvokeTarget = {
  invoke(call: ItxExpressionInput): unknown;
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

/**
 * Builds the dotted-path fallback used by dynamic itx capabilities.
 *
 * A function-backed proxy (not an RpcTarget instance): each missing property extends the path,
 * and applying the function reduces the whole accumulated access into ONE
 * `invoke(expression)` call — `[...root, ...prefix, [method, ...args]]`.
 */
export function createItxExpressionPathProxy(
  invoker: InvokeTarget,
  root: readonly string[],
  path: string[] = [],
): unknown {
  const valueFor = (key: string) => createItxExpressionPathProxy(invoker, root, [...path, key]);
  return new Proxy(function () {}, {
    apply(_target, _thisArg, args) {
      // Reduce the accumulated dotted access into ONE ItxExpressionInput (structured half): the scope root,
      // the property-read prefix, then the final call step carrying the args.
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

/**
 * Install the dynamic-capability fallback on a class's PROTOTYPE CHAIN: built-in members win
 * through normal property lookup, and only missing roots become dynamic capability paths — which
 * lets a surface expose concrete methods like `invoke` while also supporting provided paths such
 * as `itx.slack.chat.postMessage(...)`.
 *
 * KEY DESIGN IDEA: the RpcTarget with its known members sits *in front of* the itx Durable
 * Object. Built-ins resolve here in the isolate; only unknown roots fall through to
 * `invoke` (the DO's dynamic table). The deliberate trade-off: a dynamic capability can
 * never shadow a built-in name — the built-in always wins.
 *
 * Why a prototype hop and not a Proxy AROUND the instance (the design this clean room tried
 * FIRST and reverted): workerd RPC classifies a call's RESULT for promise pipelining with native
 * brand checks that a JS Proxy can never pass (`serializeJsValueWithPipeline` in workerd's
 * worker-rpc.c++ → falls to `NonPipelinable`; upstream: cloudflare/workerd#6873). So a surface
 * returned FROM A METHOD must hand back a REAL, unproxied instance or every pipelined call on it
 * dies with "The RPC receiver does not implement the method ...". This helper squares that with
 * dynamic dispatch by inserting one proxied hop BETWEEN `Class.prototype` and its parent:
 *
 *   instance ──proto──▶ Class.prototype ──proto──▶ Proxy(hop) ──proto──▶ parent
 *
 * - The instance is a genuine, natively-branded RpcTarget → workerd's pipeline classifier accepts
 *   it (SingleStub), so `x.get(p).method()` chains work in one expression.
 * - Declared members (own prototype methods/getters) resolve BEFORE the hop — built-ins win.
 * - Unknown string keys reach the hop's `get` trap and become dynamic capability path proxies,
 *   dispatched via the receiver's own `invoke`.
 * - Instances stay clean of own properties, so Workers RPC's instance-property protection needs
 *   no `getOwnPropertyDescriptor` help.
 *
 * Call ONCE per class. Constructor inheritance (`super()`) is untouched — only `Class.prototype`'s
 * parent link changes, and the hop forwards everything it doesn't intercept.
 *
 * KNOWN QUIRKS (accepted, by parity with apps/os):
 * - No `has` trap on the hop: `"x" in instance` reflects DECLARED members only, while `instance.x`
 *   conjures a dispatcher — feature-detect with access, not `in`.
 * - A typo'd built-in (`itx.strems`) is a syntactically valid dynamic dispatch that fails at the
 *   capability table, not a crisp missing-method error — inherent to dynamic fallback.
 */
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
