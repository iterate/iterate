// The PROJECT WORKER — the stateless edge. capnweb terminates at `/api`; everything else forwards to the
// IterateContextDurableObject over Workers RPC (the DO does the real work and stays hibernatable). `DummyControlPlane` is
// the solo-mode fallback entrypoint (the deployed config binds FALLBACK to the real control-plane shell instead).

import * as cloudflareWorkers from "cloudflare:workers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import { IterateContextDurableObject } from "./stream-durable-object.ts";
import { registerPipelinedRpcBrand } from "./core/dispatch.ts";
import { CAPABILITY_FETCH_HEADER } from "./core/fetch-capabilities.ts";
import { canonicalName } from "./core/durable-object-names.ts";
import { ProjectSession } from "./core/itx-surface.ts";
import { DEMO_PAGE_HTML } from "./generated/demo-page.ts";

// Native workerd RPC promises pipeline exactly like capnweb ones — thread them unawaited through
// the step walk too (dispatch.ts can't import cloudflare:workers itself: the unit lane runs it in
// Node). A call step yields an RpcPromise; a PROPERTY step on one yields an RpcProperty — both
// pipeline, so both register. Done once at module load, before any request can dispatch. The cast
// bridges a workers-types gap: the runtime exports both (verified by probe) but the .d.ts doesn't.
const { RpcPromise: NativeRpcPromise, RpcProperty: NativeRpcProperty } =
  cloudflareWorkers as unknown as Record<"RpcPromise" | "RpcProperty", abstract new () => unknown>;
registerPipelinedRpcBrand(NativeRpcPromise);
registerPipelinedRpcBrand(NativeRpcProperty);

export { IterateContextDurableObject };
export { ProcessorFacet } from "./processor-facet.ts";
export { ItxEntrypoint } from "./itx-entrypoint.ts";

interface Env {
  CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
}

// The SOLO fallback: the egress terminal, trivially — platform-secret substitution (none in solo)
// then a bare fetch. Bound as FALLBACK only in solo config (the deployed config binds the real
// control-plane shell instead). Capability-level control-plane egress (`itx.os`) was removed with
// config; it returns as `itx.connectToCapnweb(url)` when a real control plane lands.
export class DummyControlPlane extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}

// Bumped every deploy so a smoke test can wait for THIS build to propagate (workers.dev lags ~1-2min/colo).
const CODE_VERSION = "live-41";

/** The `?ctx=` slug when a request names none. */
const DEFAULT_CTX = "prj_demo";
const ctxSlug = (url: URL) => url.searchParams.get("ctx") ?? DEFAULT_CTX;

/** The context host DO for a request's `?ctx=`. The DO does the real work. */
function host(env: Env, url: URL) {
  return env.CONTEXT.getByName(canonicalName(ctxSlug(url)));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/version") return new Response(CODE_VERSION + "\n");

    // The hosted live-state demo: a self-contained page (React + the capnweb fork + useLiveState,
    // all inlined by build-sdk.mjs) that dials THIS worker's /api and renders a processor's reduced
    // ⊕ runtime live state. Open /demo against any deployment.
    if (url.pathname === "/demo")
      return new Response(DEMO_PAGE_HTML, {
        headers: { "content-type": "text/html;charset=utf-8" },
      });

    // THE ONE capnweb ENTRYPOINT (the hard rule): capnweb terminates HERE, in the stateless worker; the DO is
    // reached only over Workers RPC. A client dials `/api` and gets a `ProjectSession` (`get(context?)` → itx).
    if (url.pathname === "/api")
      // newWorkersRpcResponse serves BOTH a WebSocket upgrade AND a one-shot HTTP batch —
      // a CLI script or cron does one POST, no socket handshake. (Batch sessions cannot hold
      // live capabilities: rpcStubs.provide needs the relay to outlive the response —
      // the relay's park call simply fails there, which is the honest error.)
      return newWorkersRpcResponse(request, new ProjectSession(env.CONTEXT, ctxSlug(url), ctx));

    // THE FETCH LANE — the ONE fetch door: reach a fetch-shaped capability (WS upgrades and all) by a
    // serialized ItxExpression in `?cap=`. Set `x-itx-cap` and forward to the context host.
    if (url.pathname === "/cap") {
      const headers = new Headers(request.headers);
      const cap = url.searchParams.get("cap");
      if (cap) headers.set(CAPABILITY_FETCH_HEADER, cap);
      return host(env, url).fetch(new Request(request, { headers }));
    }

    return new Response("project-worker — /api (capnweb), /cap, /demo, /version\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
