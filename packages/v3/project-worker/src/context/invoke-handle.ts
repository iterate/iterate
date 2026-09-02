// context/invoke-handle.ts — a GENUINE, pipelinable RpcTarget for a MID-CHAIN capability handle
// (a live row's transport bridge, `facets.get(name)`, `cd(path)`, `load(src).getEntrypoint()` /
// `load(src).getDurableObjectClass(name).get(instance)`).
//
// A mid-chain handle must be a GENUINE RpcTarget: a mid-chain call returns it ACROSS an RPC
// boundary (`itx.facets.get('b').hello()` is two dispatches — `get('b')` returns the handle, then
// `.hello()` is called ON it), and workerd's promise-pipeline classifier brand-checks a method's
// return — a JS Proxy never passes (NonPipelinable; cloudflare/workerd#6873), a real RpcTarget does
// on both hops (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on workerd), so the
// second call pipelines.
//
// The prototype-hop fallback (dotted-path-proxy.ts) reduces unknown dotted members (`.hello`,
// `.demo.timer.callLater`) into ONE `invokeCapability(expression)` — `[...prefix, [method, ...args]]`,
// relative to the handle (empty scope root). Providers stay plain `RpcTarget` subclasses (which
// capnweb already requires to pass a capability by reference); the client stays just capnweb.

import { RpcTarget } from "capnweb";
import { installPrototypeInvokeCapabilityFallback } from "./dotted-path-proxy.ts";
import { toExpression, type ItxExpression } from "./expression.ts";

/** A branded, pipelinable handle whose unknown dotted members reduce into ONE `dispatch(path, args)`.
 *  `dispatch` routes the reduced path into the underlying object — a borrowed rpc stub
 *  (`RpcStubDirectory.invoke`), a facet's method walk (the DO's facet door), a sibling context, or a
 *  stateful loaded class. Declared members (`invokeCapability` / `applyRoot`) win over the fallback,
 *  so a capability cannot be named either — the two reserved words this wrapper adds. */
export class InvokeHandle extends RpcTarget {
  readonly #dispatch: (path: string[], args: unknown[]) => unknown;
  constructor(dispatch: (path: string[], args: unknown[]) => unknown) {
    super();
    this.#dispatch = dispatch;
  }
  /** THE reduce door the prototype hop dispatches onto (the receiver IS the invoker — this instance).
   *  The `ItxExpression` is RELATIVE to this handle (empty scope root — the hop is installed with
   *  `[]`): property-read steps then a final call step, unpacked back into `(path, args)`. */
  invokeCapability(call: ItxExpression): unknown {
    const expr = toExpression(call);
    const tail = expr.at(-1);
    if (tail === undefined) return this.#dispatch([], []);
    const [method, args] =
      typeof tail === "string" ? [tail, [] as unknown[]] : [tail[0], tail.slice(1)];
    return this.#dispatch([...(expr.slice(0, -1) as string[]), method], args);
  }
  /** Root-apply: call the bare capability this handle fronts (empty path). `callOn` (dispatch.ts)
   *  uses this when a matched mount's target IS an InvokeHandle and args are applied at the mount —
   *  `handle(events, range)` ⇒ the lent callback the handle delivers to. */
  applyRoot(args: unknown[]): unknown {
    return this.#dispatch([], args);
  }
}
installPrototypeInvokeCapabilityFallback(InvokeHandle, []);

// ── the two BRANDS the subscription delivery loop reads ──
// A subscription's target evaluates to SOMETHING; the loop asks the value what it is. These two
// kinds OWN THEIR PROGRESS, so a push needs no cursor on the stream side: a facet keeps its own
// checkpoint and gap-repairs from the log (stream/processor.ts), a live client owns its offset (it
// chains delivered ranges and heals with read). Anything else — a Worker-Loader entrypoint, a
// sibling context, a remote — cannot, and the stream keeps a cursor for it (subscription-delivery.ts).
// Nothing is declared on any event; the brand is minted where the built-in mints the handle.

/** `itx.facets.get(name)` / `load(src).getDurableObjectClass(C).get(name)` — a facet of this context. */
export class FacetHandle extends InvokeHandle {}
/** `itx.rpcStubs.get(key)` — a live stub lent to the registry. */
export class RpcStubHandle extends InvokeHandle {}
