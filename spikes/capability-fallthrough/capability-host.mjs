// The uniform capability host — the whole "look around the corner" idea in one class.
//
//   • Everything is a CapabilityHost. iterate, the control plane, and a project are
//     THE SAME class, differing only in what they provide and who their parent is.
//   • A host resolves an unknown member via ONE fallback: its own mounts first,
//     then it falls through to its `parent` host (which may be a REMOTE stub).
//   • Capabilities are provided data: "live" (a stub/RpcTarget whose calls travel
//     back to the provider) or "static" (a value returned by copy).
//   • The ergonomic `host.egress.fetch(url)` works because the fallback lives on the
//     PROTOTYPE (not a wrapper Proxy around the instance). So an instance is a real
//     RpcTarget — safe to return across a NATIVE Workers-RPC boundary (spike 1's
//     rule) — while unknown-member access still resolves, in-isolate, during
//     capnweb/Workers-RPC expression evaluation. No bare Proxy ever crosses a wire.

import { RpcTarget } from "capnweb";

// Names the fallthrough trap must NOT treat as capability lookups — promise/stub/JS
// machinery probes these. (Same spirit as installPrototypeInvokeCapabilityFallback's guard.)
const RESERVED = new Set([
  "then",
  "catch",
  "finally",
  "dup",
  "onRpcBroken",
  "constructor",
  "toJSON",
  "toString",
  "valueOf",
  "asymmetricMatch",
]);

class CapabilityHostBase extends RpcTarget {
  #name;
  #caps = new Map(); // name -> { kind: "live" | "static", cap }
  #parent = null; // a CapabilityHost stub (local or remote) to fall through to

  constructor(name, parent = null) {
    super();
    this.#name = name;
    this.#parent = parent;
  }

  whoami() {
    return this.#name;
  }

  /** Set the host this one falls through to. `parent` may be a remote stub — dup() it so a
   *  REMOTE `setParent` call doesn't hand us a stub capnweb disposes when the call returns
   *  (red-team-3: undisposed → permanent unauthenticated fallthrough wedge). */
  setParent(parent) {
    this.#parent = parent && typeof parent.dup === "function" ? parent.dup() : parent;
    return true;
  }

  /**
   * Provide a capability. `kind`:
   *   "live"   – `cap` is a stub / RpcTarget; calls travel to the provider. We dup()
   *              so it survives past this call (params are disposed when the call ends).
   *   "static" – `cap` is a plain value, returned by copy.
   */
  provide(name, cap, kind = "live") {
    // Stubs (capnweb OR native Workers-RPC) need dup() to survive param-disposal; local
    // RpcTargets don't have a real `.dup` (the host trap returns undefined — `dup` is RESERVED).
    const stored = kind === "live" && typeof cap?.dup === "function" ? cap.dup() : cap;
    this.#caps.set(name, { kind, cap: stored });
    return true;
  }

  /**
   * THE single fallback. Resolve `name` locally, else fall through to the parent.
   * Returns a live stub/RpcTarget (dup'd) or a static value; throws at the terminal.
   * When the parent is remote this returns an RpcPromise, so the caller's continued
   * `.foo(bar)` pipelines onward in the same round trip.
   */
  resolve(name) {
    const hit = this.#caps.get(name);
    if (hit) {
      if (hit.kind === "live" && typeof hit.cap?.dup === "function") return hit.cap.dup();
      return hit.cap;
    }
    if (this.#parent) return this.#parent.resolve(name);
    throw new Error(`[${this.#name}] no capability "${name}" and no parent to fall through to`);
  }
}

// Install the single fallback as a PROTOTYPE hop: unknown member access on any instance
// routes to `instance.resolve(prop)`. Real methods (resolve/provide/…) are found lower on
// the chain and never hit the trap. Crucially, the trap's own target inherits from
// RpcTarget.prototype, so RpcTarget.prototype STAYS in the chain — the instance is still a
// real `RpcTarget` (`instanceof` holds; capnweb passes it by reference, not by value).
// Because this is a prototype hop and not an instance wrapper, no bare Proxy crosses a wire.
const trapTarget = Object.create(RpcTarget.prototype);
const fallthroughProto = new Proxy(trapTarget, {
  get(target, prop, receiver) {
    if (typeof prop === "symbol" || RESERVED.has(prop) || Reflect.has(target, prop))
      return Reflect.get(target, prop, receiver);
    return receiver.resolve(prop); // resolve unknown capability by name
  },
  has(target, prop) {
    // Capability NAMES appear present (prototype-like). But symbols and reserved names must
    // report their REAL presence — else `Symbol.dispose in host` is true while the value is
    // undefined, and capnweb's teardown calls `undefined()` → crash on every disconnect
    // (red-team-3 & -4, reproduced). Do NOT claim to have things we don't.
    if (typeof prop === "symbol" || RESERVED.has(prop)) return Reflect.has(target, prop);
    return true;
  },
});
Object.setPrototypeOf(CapabilityHostBase.prototype, fallthroughProto);

export const CapabilityHost = CapabilityHostBase;
