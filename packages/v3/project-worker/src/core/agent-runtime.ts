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

// (The STATEFUL dynamic-worker wrapper `statefulDoRunner` was removed: with native facet RPC
// (Reflect.apply in StatefulWorkerDurableObject.invokeCapability), the runner loads the user's
// `DurableObject` class DIRECTLY and calls its methods — no `__HostedActor` fetch-tunnel wrapper.)

/** Load a confined dynamic worker — THE one loader wiring (stateless code caps, userspace facet
 *  processors, the stateful runner all ride it). The confinement contract, stated once: `itx.js`
 *  (the dotted surface above) is always injected, and the worker's WHOLE world — `env.ITX` and
 *  every global fetch — is its owning context, so sibling calls and egress route through the
 *  host's dispatch with no second path. Callers version their `cacheKey` themselves (content
 *  hash + deploy id — see the stale-isolate learning in stateful-worker-durable-object.ts).
 *
 *  ═══════════════════════════════════════════════════════════════════════════════════════════
 *  ⚠️  THE cacheKey IS A DOLLAR AMOUNT — one of the most cost-sensitive levers in the system.
 *  Cloudflare bills EVERY DISTINCT value ever passed to `LOADER.get` as a Dynamic Worker at
 *  $0.002/worker/day. apps/os PR #2504: a per-request random nonce in the key produced ~3.9M
 *  identities ≈ $7.8k in ~3 weeks, plus a cold isolate build on every dispatch (~5MB, 1-2s).
 *  Key components must be LOW-CARDINALITY and each one priced: deploy version × owning context
 *  × content hash — NEVER a random nonce, timestamp, request id, or offset. (The tension the
 *  nonce papered over is real — a loaded isolate captures the minting host's `env.ITX`/
 *  `globalOutbound`, which can die with the host's incarnation; we accept the rare
 *  re-dial failure and re-key on DEPLOY, not per use.)
 *  ═══════════════════════════════════════════════════════════════════════════════════════════ */
export function confinedWorker(
  loader: WorkerLoader,
  cacheKey: string,
  mainModule: string,
  modules: Record<string, string>,
  host: Fetcher,
) {
  return loader.get(cacheKey, () => ({
    compatibilityDate: "2026-07-01",
    mainModule,
    modules: { "itx.js": ITX_SURFACE_MODULE, ...modules },
    env: { ITX: host },
    globalOutbound: host,
  }));
}
