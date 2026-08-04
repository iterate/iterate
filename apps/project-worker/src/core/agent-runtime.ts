// agent-runtime.ts — code injected into every loaded agent's confined isolate.
//
// `ITX_SURFACE_MODULE` is injected as `itx.js`. It wraps the raw `env.ITX` host stub in the ergonomic, dotted
// `itx.a.b(args)` surface (target-core §4.2/§4.3, the client-side hop): each call compiles to
// `stub.invokeCapability("itx.a.b", [args])`. This is a plain accumulating Proxy in the AGENT's own isolate
// (it never crosses a wire, so the workerd#6873 brand-check doesn't apply). Promise-pipelining of chained
// calls is a later refinement — today each call is one round trip to the host.

export const ITX_SURFACE_MODULE = /* js */ `
export function itxFromStub(stub) {
  const build = (parts) =>
    new Proxy(function () {}, {
      get(_t, prop) {
        // not a thenable, and don't treat symbol/probe reads as capability segments
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return build([...parts, prop]);
      },
      apply(_t, _thisArg, args) {
        return stub.invokeCapability(parts.join("."), args);
      },
    });
  return build(["itx"]);
}
`;

// Wraps a repo file whose default export is a capability function `(itx, ...args) => result` so the host can
// run it confined as a STATELESS dynamic worker (target-core §4.1 — the apps/os "stateless" ref: a plain
// function, no durable identity). The args arrive as a JSON body; the result goes back as JSON. `cap.js` is
// the repo file; `itx.js` is the surface above.
export const CODE_CAP_RUNNER = /* js */ `
import cap from "./cap.js";
import { itxFromStub } from "./itx.js";
export default {
  async fetch(request, env) {
    const args = await request.json();
    const itx = itxFromStub(env.ITX);
    const result = typeof cap === "function" ? await cap(itx, ...args) : cap;
    return Response.json({ result });
  }
};
`;

// The STATEFUL dynamic-worker wrapper (mirrors apps/os StatefulWorkerDurableObject + worker-runner). The repo
// file `cap.js` exports a `DurableObject` subclass named `className`; this wraps it in a host-owned subclass
// `__HostedActor` and runs THAT as a FACET (its own isolated SQLite `ctx.storage`, durable across calls).
//
// Why the wrapper: a stub to a Worker-Loader facet is NON-TRANSFERABLE across the Worker boundary (workerd:
// "Entrypoints to dynamically-loaded workers cannot be transferred to other Workers … have the parent Worker
// expose an entrypoint which constructs the dynamic worker and forwards to it"). `facet.fetch()` works (a
// Response passes by value); a custom facet-METHOD result gets pipelined, and the pipeline hands the caller a
// facet-stub reference → forbidden. So the RPC lane is TUNNELED over `fetch`: the host POSTs `{method,args}`
// to `/__itx_rpc`, the wrapper invokes the user method locally and returns the result by value. Any other path
// falls through to the user class's own `fetch` (the WS/streaming lane), so both lanes stay a plain `fetch`.
export function statefulDoRunner(className: string): string {
  const c = JSON.stringify(className);
  return /* js */ `
import * as __user from "./cap.js";
const __Base = __user[${c}];
if (typeof __Base !== "function") throw new Error("stateful worker does not export class " + ${c});
const __userOwnsFetch = Object.prototype.hasOwnProperty.call(__Base.prototype, "fetch");
export class __HostedActor extends __Base {
  async fetch(request) {
    if (new URL(request.url).pathname === "/__itx_rpc") {
      const { method, args } = await request.json();
      const fn = this[method];
      if (typeof fn !== "function")
        return Response.json({ __itx_err: 'no method "' + method + '"' }, { status: 404 });
      const result = await fn.apply(this, args || []);
      return Response.json({ __itx_ok: true, result: result === undefined ? null : result });
    }
    if (__userOwnsFetch) return super.fetch(request); // the user class's own fetch (WS/streaming lane)
    return new Response("stateful worker: no fetch handler\\n", { status: 404 });
  }
}
`;
}
