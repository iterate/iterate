// The PROJECT WORKER — the stateless edge. capnweb terminates at `/api`; everything else forwards to the
// ItxDurableObject over Workers RPC (the DO does the real work and stays hibernatable). `DummyControlPlane` is
// the solo-mode fallback entrypoint (the deployed config binds FALLBACK to the real control-plane shell instead).

import { WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { ItxDurableObject } from "./itx-durable-object.ts";
import { canonicalName } from "./core/names.ts";
import { ProjectSession } from "./core/itx-surface.ts";

export { ItxDurableObject };
export { StreamDurableObject } from "./stream-durable-object.ts";
export { StatefulWorkerDurableObject } from "./stateful-worker-durable-object.ts";
// Preserve the pre-skeleton runner exports so a live control-plane RUNNER binding keeps resolving.
export { ProjectRunner, ProjectEntrypoint, ProjectAuth } from "./index.ts";

interface Env {
  ITX_HOST: DurableObjectNamespace<ItxDurableObject>;
  LOADER: WorkerLoader;
  SECRETS_KV?: KVNamespace;
  APP_CONFIG?: string;
}

// The SOLO fallback (target-core §3.4): a whole control plane, trivially — platform-secret substitution (none in
// solo) then terminal; `invokeCapability` is the capability fallthrough. Bound as FALLBACK only in solo config.
export class DummyControlPlane extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
  async invokeCapability(callPath: string, _args?: unknown[]): Promise<unknown> {
    if (callPath === "itx.auth.gate") return { ok: true };
    throw new Error(`DummyControlPlane: no capability "${callPath}"`);
  }
}

// Bumped every deploy so a smoke test can wait for THIS build to propagate (workers.dev lags ~1-2min/colo).
const CODE_VERSION = "q4-1";

/** The context host DO for a request's `?ctx=` (defaults to `prj_demo`). The DO does the real work. */
function host(env: Env, url: URL) {
  return env.ITX_HOST.getByName(canonicalName(url.searchParams.get("ctx") ?? "prj_demo"));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/version") return new Response(CODE_VERSION + "\n");

    // THE ONE capnweb ENTRYPOINT (the hard rule): capnweb terminates HERE, in the stateless worker; the DO is
    // reached only over Workers RPC. A client dials `/api` and gets a `ProjectSession` (`get`/`connect` → itx).
    if (url.pathname === "/api")
      return newWorkersWebSocketRpcResponse(
        request,
        new ProjectSession(env.ITX_HOST, url.searchParams.get("ctx") ?? "prj_demo", ctx),
      );

    // THE FETCH LANE: reach a fetch-shaped capability (WS upgrades and all) by a serialized ItxExpression in
    // `?cap=`. Set `x-itx-cap` and forward to the context host — checked before the generic WS catch below.
    if (url.pathname === "/cap") {
      const headers = new Headers(request.headers);
      const cap = url.searchParams.get("cap");
      if (cap) headers.set("x-itx-cap", cap);
      return host(env, url).fetch(new Request(request, { headers }));
    }

    // /state (observability), /facet (the stateful WS lane), and any bare WS ingress forward straight to the DO.
    if (
      url.pathname === "/state" ||
      url.pathname === "/facet" ||
      url.pathname === "/ws" ||
      (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket"
    )
      return host(env, url).fetch(request);

    // /call — invoke a capability by callPath (POST `{ path, args }` or `?path=&args=`). Used by agents/harnesses.
    if (url.pathname === "/call") {
      const body =
        request.method === "POST"
          ? ((await request.json()) as { path?: string; args?: unknown[] })
          : {};
      const path = body.path ?? url.searchParams.get("path") ?? "itx.whoami";
      const argsRaw = url.searchParams.get("args"); // a JSON array, e.g. ?args=["k","v"]
      const args = body.args ?? (argsRaw ? (JSON.parse(argsRaw) as unknown[]) : []);
      try {
        return Response.json({
          ok: true,
          value: await host(env, url).invokeCapability(path, args),
        });
      } catch (e) {
        return Response.json({ ok: false, error: String((e as Error).message) });
      }
    }

    return new Response("project-worker — /api (capnweb), /call, /cap, /facet, /state\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
