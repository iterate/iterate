// The PROJECT WORKER — the stateless edge. capnweb terminates at `/api`; everything else forwards to the
// IterateContextDurableObject over Workers RPC (the DO does the real work and stays hibernatable). `DummyControlPlane` is
// the solo-mode fallback entrypoint (the deployed config binds FALLBACK to the real control-plane shell instead).

import * as cloudflareWorkers from "cloudflare:workers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { RpcPromise as CapnwebRpcPromise, RpcStub as CapnwebRpcStub } from "capnweb";
import { IterateContextDurableObject, type Env } from "./iterate-context-durable-object.ts";
import { registerPipelinedRpcBrand } from "./context/dispatch.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./fetch/rpc-stub-fetch.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import { UnauthenticatedSession } from "./session.ts";
import { appConfigOf } from "./app-config.ts";
import { resolveProjectHost } from "./ingress.ts";
import { withOptionalDemoLogin, type BrowserPrincipal } from "./auth.ts";
import { handleMcpRequest } from "./mcp-server.ts";
import { policyErrorResponse } from "./lib/errors.ts";
import { newAdmittedWorkersRpcResponse } from "./context/rpc-admission.ts";

/** The fetch lane's re-entry count: `/expression?itx=itx.fetch` egresses to its own URL and lands
 *  here again with the same query; the header counts the passes and the lane refuses past a few. */
const ITX_EXPRESSION_LANE_HOPS_HEADER = "x-itx-expression-hops";
const ITX_EXPRESSION_LANE_MAX_HOPS = 4;

// Native workerd RPC promises pipeline exactly like capnweb ones — thread them unawaited through
// the step walk too (dispatch.ts can't import cloudflare:workers itself: the unit lane runs it in
// Node). A call step yields an RpcPromise; a PROPERTY step on one yields an RpcProperty — both
// pipeline, so both register. Done once at module load, before any request can dispatch. The cast
// bridges a workers-types gap: the runtime exports both (verified by probe) but the .d.ts doesn't.
const { RpcPromise: NativeRpcPromise, RpcProperty: NativeRpcProperty } =
  cloudflareWorkers as unknown as Record<"RpcPromise" | "RpcProperty", abstract new () => unknown>;
registerPipelinedRpcBrand(NativeRpcPromise);
registerPipelinedRpcBrand(NativeRpcProperty);
// capnweb's own promises pipeline the same way, and the library's `itx.connectToCapnweb` puts them
// in the walk (library/capnweb.ts): a remote chain `.a().b(x)` must stay unawaited between steps or
// a one-shot batch session dies after its first message. A capnweb RpcStub is not a promise; it
// registers so a stub-valued step is never awaited either (awaiting one is a no-op anyway).
registerPipelinedRpcBrand(CapnwebRpcPromise as unknown as abstract new () => unknown);
registerPipelinedRpcBrand(CapnwebRpcStub as unknown as abstract new () => unknown);

export { IterateContextDurableObject };
export { ItxEntrypoint } from "./itx-entrypoint.ts";

// The SOLO fallback: the egress terminal, trivially — platform-secret substitution (none in solo)
// then a bare fetch. Bound as FALLBACK only in solo config (the deployed config binds the real
// control-plane shell instead).
export class DummyControlPlane extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}

// Bumped every deploy so a smoke test can wait for THIS build to propagate (workers.dev lags ~1-2min/colo).
const CODE_VERSION = "live-47";

const dashboard = withOptionalDemoLogin({
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    principal?: BrowserPrincipal,
  ): Promise<Response> {
    const url = new URL(request.url);

    // `<label> <environmentName> <deployId>`: the hand-bumped label first (a smoke greps it), then the
    // configuration (app-config.ts) — which deployment, and Cloudflare's version id of this deploy.
    if (url.pathname === "/version") {
      const { environmentName, deployId } = appConfigOf(env);
      return new Response(`${CODE_VERSION} ${environmentName} ${deployId}\n`);
    }

    // Secrets have separate deployment-admin authority, never the unverified demo identity.
    if (url.pathname === "/secrets") {
      if (!env.EXPERIMENT_ADMIN_TOKEN)
        return new Response("Secret administration is not configured", { status: 503 });
      if (request.headers.get("authorization") !== `Bearer ${env.EXPERIMENT_ADMIN_TOKEN}`)
        return new Response("Deployment-admin credential required", { status: 401 });
      if (request.method !== "POST") return new Response("POST required", { status: 405 });
      const contextName = url.searchParams.get("context");
      if (!contextName) return new Response("Missing context", { status: 400 });
      try {
        const address = DurableObjectNameCodec.parse(contextName);
        const context = env.ITERATE_CONTEXT.getByName(address.name);
        return Response.json(await context.putSecret(await request.json()));
      } catch (error) {
        const refusal = policyErrorResponse(error);
        if (refusal) return refusal;
        throw error;
      }
    }

    // /demo — the hosted live-state demo — is a STATIC ASSET (public/demo.html, built by
    // build-sdk.mjs; wrangler.jsonc `assets`): the platform serves it before this handler runs.

    // THE ONE capnweb ENTRYPOINT (the hard rule): capnweb terminates HERE, in the stateless worker;
    // the DO is reached only over Workers RPC. A client dials `/api` and holds an
    // `UnauthenticatedSession`: `authenticate().projects.get(projectId)` → the project's root itx.
    if (url.pathname === "/api")
      // newWorkersRpcResponse serves BOTH a WebSocket upgrade AND a one-shot HTTP batch —
      // a CLI script or cron does one POST, no socket handshake. (Batch sessions cannot hold
      // live capabilities: a live provide needs the relay to outlive the response —
      // the relay's lend call simply fails there, which is the honest error.)
      return newAdmittedWorkersRpcResponse(
        request,
        new UnauthenticatedSession(env.ITERATE_CONTEXT, ctx, principal),
      );

    // OAuth selected the project before this handler was reached (auth.ts checks its grant against
    // `?project=`). MCP has no parallel capability API: its standard Streamable HTTP tool calls the
    // exact same root-context invoke door as capnweb, preserving dynamic dotted members.
    if (url.pathname === "/mcp") {
      const projectId = url.searchParams.get("project");
      if (!projectId) return new Response("MCP needs ?project=<project id>", { status: 400 });
      const address = DurableObjectNameCodec.stringify({ projectId, path: "/" });
      const context = env.ITERATE_CONTEXT.getByName(address);
      return handleMcpRequest(request, (expression, args) => context.invoke(expression, ...args));
    }

    // THE FETCH LANE — the plain-HTTP door onto fetch-shaped capabilities (WS upgrades and all), for
    // callers with no capnweb session (curl, a browser tab, a webhook): `?context=` names the
    // context (a project id = its root, or a full context name), `?itx=` the itx expression. The
    // expression rides to the context DO in `x-itx-expression`. capnweb clients need no door: a
    // terminal `itx.x.fetch(request)` takes the same lane from inside the session.
    // `/expression/<path>` too: the Request rides to the target verbatim, so a server behind the lane
    // (an OpenAPI service loaded as a worker) sees a real path.
    if (url.pathname === "/expression" || url.pathname.startsWith("/expression/")) {
      const context = url.searchParams.get("context");
      const itxExpression = url.searchParams.get("itx");
      if (!context || !itxExpression)
        return new Response(
          "/expression needs ?context=<project id | context name>&itx=<itx expression>\n",
          { status: 400 },
        );
      // THE HOP COUNT: an expression that fetches THIS lane's own URL (`?itx=itx.fetch`) re-enters
      // here through egress with the same query, unbounded; each pass counts, a few is a loop.
      const hops = Number(request.headers.get(ITX_EXPRESSION_LANE_HOPS_HEADER) ?? "0") + 1;
      if (hops > ITX_EXPRESSION_LANE_MAX_HOPS)
        return new Response(
          `/expression: the lane re-entered itself ${hops} times (an expression fetching its own lane)\n`,
          { status: 508 },
        );
      const headers = new Headers(request.headers);
      headers.set(ITX_EXPRESSION_FETCH_HEADER, itxExpression);
      headers.set(ITX_EXPRESSION_LANE_HOPS_HEADER, String(hops));
      try {
        const address = DurableObjectNameCodec.parse(context);
        return env.ITERATE_CONTEXT.getByName(address.name).fetch(new Request(request, { headers }));
      } catch (error) {
        const refusal = policyErrorResponse(error);
        if (refusal) return refusal;
        throw error;
      }
    }

    return new Response("project-worker — /api (capnweb), /expression, /demo, /version\n", {
      headers: { "content-type": "text/plain" },
    });
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The local harness carries HTTP authority in Host while the URL uses its
    // listener address. Normalize once so routing and policy see one destination.
    url.host = request.headers.get("host") ?? url.host;
    if (url.href !== request.url) request = new Request(url, request);
    // The deployment-owned dashboard origin is reserved, even when it sits under
    // the project-host suffix. A project slug must not intercept its login/API.
    if (env.PUBLIC_ORIGIN && url.origin === new URL(env.PUBLIC_ORIGIN).origin)
      return dashboard.fetch(request, env, ctx);
    const projectHost = resolveProjectHost(url, appConfigOf(env));
    if (projectHost?.kind === "unknown")
      return new Response("Unknown project hostname", { status: 421 });
    if (projectHost?.kind === "project") {
      const headers = new Headers(request.headers);
      // Private platform transport headers cannot choose an ingress capability.
      for (const name of [...headers.keys()]) if (name.startsWith("x-itx-")) headers.delete(name);
      const name = DurableObjectNameCodec.stringify({
        projectId: projectHost.projectId,
        path: "/",
      });
      return env.ITERATE_CONTEXT.getByName(name).fetch(new Request(request, { headers }));
    }
    return dashboard.fetch(request, env, ctx);
  },
};
