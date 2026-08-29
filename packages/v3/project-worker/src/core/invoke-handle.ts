// core/invoke-handle.ts — a GENUINE, pipelinable RpcTarget for a MID-CHAIN capability handle
// (`connections.get(key)`, `facets.get(slug)`, `cd(path)`, `workers.get(ref)`).
//
// These used to return a bare `pathProxy` (dispatch.ts) — a Proxy-over-function. It folds dotted
// members fine, but it is NOT a native RpcTarget, and a mid-chain call returns it ACROSS an RPC
// boundary: `itx.rpcStubs.get('b').hello()` is TWO dispatches — `get('b')` returns the handle,
// then `.hello()` is called ON it. workerd's promise-pipeline classifier brand-checks the return
// of a method and a JS Proxy can NEVER pass (NonPipelinable; cloudflare/workerd#6873), so over
// Workers RPC (DO→/api, and loaded-worker→DO) the `.hello()` died with "The RPC receiver does not
// implement the method hello". A real RpcTarget passes the classifier on BOTH lanes (capnweb's
// RpcTarget IS the native `cloudflare:workers` RpcTarget on workerd), so the second call pipelines.
//
// The prototype-hop fallback (dotted-path-proxy.ts) folds unknown dotted members (`.hello`,
// `.demo.timer.callLater`) into ONE `invokeCapability({ path, args })` — the SAME fold the pathProxy
// did, now carried on a pipelinable brand. Providers are UNCHANGED (still a plain `RpcTarget`
// subclass like `new Demo()` — which capnweb already requires to pass a capability by reference);
// the client is UNCHANGED (still just capnweb). The whole cost is this one wrapper on OUR side.

import { RpcTarget } from "capnweb";
import { installPrototypeInvokeCapabilityFallback } from "./dotted-path-proxy.ts";

/** A branded, pipelinable handle whose unknown dotted members fold into ONE `dispatch(path, args)`.
 *  `dispatch` routes the folded path into the underlying object — a connection's retained callback
 *  (`#itxConnections.invoke`), a facet's method walk (`facetInvoke`), a sibling context, or a
 *  stateful loaded class. Declared members (just `invokeCapability`) win over the fallback, so a
 *  capability cannot be named `invokeCapability` — the one reserved word this wrapper adds. */
export class InvokeHandle extends RpcTarget {
  readonly #dispatch: (path: string[], args: unknown[]) => unknown;
  constructor(dispatch: (path: string[], args: unknown[]) => unknown) {
    super();
    this.#dispatch = dispatch;
  }
  /** THE fold door the prototype hop dispatches onto (default `invokerFor` = the instance itself). */
  invokeCapability(call: { path: string[]; args: unknown[] }): unknown {
    return this.#dispatch(call.path, call.args);
  }
}
installPrototypeInvokeCapabilityFallback(InvokeHandle);
