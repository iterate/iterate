// context/invoke-handle.ts — a GENUINE, pipelinable RpcTarget for a MID-CHAIN capability handle
// (a live row's transport bridge, `facets.get(name)`, `cd(path)`, `load(src).getEntrypoint()` /
// `facets.get(name, { source, className })`).
//
// A mid-chain handle must be a GENUINE RpcTarget: a mid-chain call returns it ACROSS an RPC
// boundary (`itx.facets.get('b').hello()` is two dispatches — `get('b')` returns the handle, then
// `.hello()` is called ON it), and workerd's promise-pipeline classifier brand-checks a method's
// return — a JS Proxy never passes (NonPipelinable; cloudflare/workerd#6873), a real RpcTarget does
// on both hops (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on workerd), so the
// second call pipelines.
//
// The prototype-hop fallback (dotted-path-proxy.ts) reduces unknown dotted members (`.hello`,
// `.demo.timer.callLater`) into ONE `invoke(expression)` — `[...prefix, [method, ...args]]`,
// relative to the handle (empty scope root). Providers stay plain `RpcTarget` subclasses (which
// capnweb already requires to pass a capability by reference); the client stays just capnweb.

import { RpcTarget } from "capnweb";
import { installPrototypeInvokeFallback } from "./dotted-path-proxy.ts";
import { toItxExpression, type ItxExpression, type ItxExpressionInput } from "./expression.ts";

/** A branded, pipelinable handle whose unknown dotted members reduce into ONE dispatch of the
 *  itx-expression STEPS relative to it. `dispatch` routes those steps into the underlying object — a
 *  borrowed rpc stub (`RpcStubDirectory.invokeRpcStub`), a facet's method walk (the DO's facet door),
 *  a sibling context, or a stateful loaded class. Declared members (`invoke` / `applyRoot`)
 *  win over the fallback, so a capability cannot be named either — the two reserved words this
 *  wrapper adds. */
export class InvokeHandle extends RpcTarget {
  readonly #dispatchItxExpressionSteps: (itxExpressionSteps: ItxExpression) => unknown;
  constructor(dispatchItxExpressionSteps: (itxExpressionSteps: ItxExpression) => unknown) {
    super();
    this.#dispatchItxExpressionSteps = dispatchItxExpressionSteps;
  }
  /** THE reduce door the prototype hop dispatches onto (the receiver IS the invoker — this instance).
   *  The expression is RELATIVE to this handle (empty scope root — the hop is installed with `[]`). */
  invoke(call: ItxExpressionInput): unknown {
    return this.#dispatchItxExpressionSteps(toItxExpression(call));
  }
  /** Root-apply: call the bare capability this handle fronts — the ANONYMOUS call step. `callOn`
   *  (dispatch.ts) uses this when a rewritten call's target IS an InvokeHandle and args are applied
   *  to it — `handle(events, range)` ⇒ the lent callback the handle delivers to. */
  applyRoot(args: unknown[]): unknown {
    return this.#dispatchItxExpressionSteps([["", ...args]]);
  }
}
installPrototypeInvokeFallback(InvokeHandle, []);

// ── the two BRANDS the subscription delivery loop reads ──
// A subscription's target evaluates to SOMETHING; the loop asks the value what it is. These two
// kinds OWN THEIR PROGRESS, so a push needs no cursor on the stream side: a facet keeps its own
// checkpoint and gap-repairs from the log (stream/processor.ts), a live client owns its offset (it
// chains delivered ranges and heals with read). Anything else — a Worker-Loader entrypoint, a
// sibling context, a remote — cannot, and the stream keeps a cursor for it (subscription-delivery.ts).
// Nothing is declared on any event; the brand is minted where the built-in mints the handle.

/** `itx.facets.get(name)` / `itx.facets.get(name, { source, className })` — a facet of this context. */
export class FacetHandle extends InvokeHandle {}
/** `itx.rpcStubs.get(key)` — a live stub lent to the registry. */
export class RpcStubHandle extends InvokeHandle {}
