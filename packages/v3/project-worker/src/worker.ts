// The PROJECT WORKER — the stateless edge. capnweb terminates at `/api`; everything else forwards to the
// StreamDurableObject over Workers RPC (the DO does the real work and stays hibernatable). `DummyControlPlane` is
// the solo-mode fallback entrypoint (the deployed config binds FALLBACK to the real control-plane shell instead).

import { WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import { StreamDurableObject } from "./stream-durable-object.ts";
import { canonicalName } from "./core/names.ts";
import { ProjectSession } from "./core/itx-surface.ts";

export { StreamDurableObject };
export { StatefulWorkerDurableObject } from "./stateful-worker-durable-object.ts";
export { ProcessorFacet } from "./processor-facet.ts";
export { ItxEntrypoint } from "./itx-entrypoint.ts";

interface Env {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
}

// The SOLO fallback (target-core §3.4): a whole control plane, trivially — platform-secret substitution (none in
// solo) then terminal; `invokeCapability` is the capability fallthrough. Bound as FALLBACK only in solo config.
export class DummyControlPlane extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
  async invokeCapability(callPath: string, _args?: unknown[]): Promise<unknown> {
    if (callPath === "itx.auth.gate") return { ok: true };
    throw new Error(`DummyControlPlane: no capability "${callPath}"`);
  }
}

// Bumped every deploy so a smoke test can wait for THIS build to propagate (workers.dev lags ~1-2min/colo).
const CODE_VERSION = "live-13";

/** The context host DO for a request's `?ctx=` (defaults to `prj_demo`). The DO does the real work. */
function host(env: Env, url: URL) {
  return env.CONTEXT.getByName(canonicalName(url.searchParams.get("ctx") ?? "prj_demo"));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/version") return new Response(CODE_VERSION + "\n");

    // THE ONE capnweb ENTRYPOINT (the hard rule): capnweb terminates HERE, in the stateless worker; the DO is
    // reached only over Workers RPC. A client dials `/api` and gets a `ProjectSession` (`get`/`connect` → itx).
    if (url.pathname === "/api")
      // newWorkersRpcResponse serves BOTH a WebSocket upgrade AND a one-shot HTTP batch —
      // a CLI script or cron does one POST, no socket handshake. (Batch sessions cannot hold
      // live capabilities: connect/provideCapability need the relay to outlive the response —
      // the relay's park call simply fails there, which is the honest error.)
      return newWorkersRpcResponse(
        request,
        new ProjectSession(env.CONTEXT, url.searchParams.get("ctx") ?? "prj_demo", ctx),
      );

    // THE FETCH LANE — the ONE fetch door: reach a fetch-shaped capability (WS upgrades and all) by a
    // serialized ItxExpression in `?cap=`. Set `x-itx-cap` and forward to the context host.
    if (url.pathname === "/cap") {
      const headers = new Headers(request.headers);
      const cap = url.searchParams.get("cap");
      if (cap) headers.set("x-itx-cap", cap);
      return host(env, url).fetch(new Request(request, { headers }));
    }

    // Observability forwards straight to the DO.
    if (url.pathname === "/state") return host(env, url).fetch(request);

    return new Response("project-worker — /api (capnweb), /cap, /state, /version\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
