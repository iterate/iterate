// Public host routing: the console, MCP and project apps share OAuth grants.
// Cap’n Web terminates at /api; project application requests enter the context DO.

import * as cloudflareWorkers from "cloudflare:workers";
import {
  newWorkersRpcResponse,
  RpcPromise as CapnwebRpcPromise,
  RpcStub as CapnwebRpcStub,
} from "capnweb";
import { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
// the one worker's env: the DO's bindings plus the in-process control plane's (control-plane.ts `Env`)
import type { Env as WorkerEnv } from "./control-plane.ts";
import { auth } from "./sdk/auth.ts";
import { identityDoor } from "./identity.ts";
import { oauthResponse } from "./api.ts";
import { consoleHandler } from "./control-plane.ts";
import { appConfigOf } from "./app-config.ts";
import { projectHostOf, hostnameLabelsUnderBase } from "./hosts.ts";
import { appCookies, browserAuthorization, browserClient } from "./browser-client.ts";
import { directory } from "./directory.ts";
import { registerPipelinedRpcBrand } from "./context/expression.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./context/rpc-stubs.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import { UnauthenticatedSession, type SessionInput } from "./session.ts";
import { ITX_PRINCIPAL_HEADER, type Principal } from "./principal.ts";
import { authorizationForToken, recordGrantUse, cleanGrantActivity } from "./oauth.ts";

/** A project host's re-entry count — THE COUNT THE APP FORWARDS: an app that fetches its own host
 *  and forwards the headers it was handed re-enters with the count on them, each pass adds one, and
 *  the edge refuses past a few. A fresh Request starts at zero — an app looping its own project
 *  with fresh Requests is its own cost. */
const PROJECT_HOST_HOPS_HEADER = "x-itx-expression-hops";
const PROJECT_HOST_MAX_HOPS = 4;

/** WHO a project host's request is, as the lane into a context reads it: `principal` is the
 *  verified stamp the context runs the call under (null: nobody); `platformBearer` says the
 *  `Authorization: Bearer` was the platform's own credential, which an app never sees. */
type ProjectHostIdentity = { principal: Principal | null; platformBearer: boolean };

/** The Request a project host hands the context DO — the same Request, its URL, method, body and a
 *  WebSocket upgrade intact, with the headers made the platform's: every inbound `x-itx-*` gone (a
 *  pager or fetch-upgrade header from outside would enter the DO's internal protocol), the cookie
 *  header replaced by `appCookies` (null ⇒ none — what the capability may see), a platform bearer
 *  (this project's token, the admin secret, this project's secret) removed (an app's own bearer
 *  scheme passes through untouched), then the expression the host names — `itx.apps.<app>`, or the
 *  config worker `itx.worker` for a host with no app label (its `fetch` routes by hostname,
 *  sdk/index.ts `ConfigWorker`) — the hop count and the principal's stamp. The app label the app
 *  sees (`x-iterate-app`) is not written here: the DO's fetch lane derives it from the expression,
 *  the one door every fetch-lane Request passes (iterate-context-durable-object.ts). */
function projectHostRequestTo(
  request: Request,
  lane: {
    app: string | null;
    hops: number;
    appCookies: string | null;
    identity: ProjectHostIdentity;
  },
): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-itx-")) headers.delete(name);
  if (lane.appCookies) headers.set("cookie", lane.appCookies);
  else headers.delete("cookie");
  if (lane.identity.platformBearer) headers.delete("authorization");
  headers.set(
    ITX_EXPRESSION_FETCH_HEADER,
    lane.app === null ? "itx.worker" : `itx.apps.${lane.app}`,
  );
  headers.set(PROJECT_HOST_HOPS_HEADER, String(lane.hops));
  if (lane.identity.principal)
    headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(lane.identity.principal));
  return new Request(request, { headers });
}

// The native workerd brands the step walk threads unawaited (expression.ts `PIPELINED_RPC_BRANDS` —
// it cannot import cloudflare:workers itself). A call step yields an RpcPromise; a PROPERTY step on
// one yields an RpcProperty — both pipeline, so both register. The cast bridges a workers-types gap:
// the runtime exports both (verified by probe) but the .d.ts doesn't.
const { RpcPromise: NativeRpcPromise, RpcProperty: NativeRpcProperty } =
  cloudflareWorkers as unknown as Record<"RpcPromise" | "RpcProperty", abstract new () => unknown>;
registerPipelinedRpcBrand(NativeRpcPromise);
registerPipelinedRpcBrand(NativeRpcProperty);
// capnweb's own promises pipeline the same way, and the library's `itx.connectToCapnweb` puts them
// in the walk (library.ts): a remote chain `.a().b(x)` must stay unawaited between steps or
// a one-shot batch session dies after its first message. A capnweb RpcStub is not a promise; it
// registers so a stub-valued step is never awaited either (awaiting one is a no-op anyway).
registerPipelinedRpcBrand(CapnwebRpcPromise as unknown as abstract new () => unknown);
registerPipelinedRpcBrand(CapnwebRpcStub as unknown as abstract new () => unknown);

export { IterateContextDurableObject };
export { BrowserSession } from "./browser-session.ts";
export { ItxEntrypoint } from "./iterate-context.ts";

export default {
  async scheduled(_event: ScheduledController, env: WorkerEnv) {
    await cleanGrantActivity(env);
  },
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // THE HOP COUNT — what the app forwards: a request carrying the count it was handed re-enters
    // here with it, each pass adds one, a few is a loop; a fresh Request carries none and starts at
    // zero. The edge writes digits; anything else (an app spelling "NaN" to defeat the budget —
    // `NaN > max` is never true) is over budget by definition.
    const hopsHeader = request.headers.get(PROJECT_HOST_HOPS_HEADER) ?? "0";
    const hops = /^\d{1,3}$/.test(hopsHeader) ? Number(hopsHeader) + 1 : Infinity;
    if (hops > PROJECT_HOST_MAX_HOPS)
      return new Response(
        `the request re-entered itself ${Number.isFinite(hops) ? hops : `"${hopsHeader}"`} times (an app fetching its own host)\n`,
        { status: 508 },
      );

    // PROJECT-HOST INGRESS (the project host section below): a request on a project host IS the app
    // it names — or, with no app label, the project's config worker — the Request riding into the
    // DO's fetch lane with its URL, the app's own cookies and a WebSocket upgrade intact. The browser adapter reserves /api and /.auth/* on every host.
    const appConfig = appConfigOf(env);
    const { projectHostnameBase, environmentName, deployId } = appConfig;
    if (appConfig.mcpOrigin && url.origin === appConfig.mcpOrigin) {
      // MCP's public root is its protocol endpoint; /api remains Cap'n Web.
      if (url.pathname !== "/" && !url.pathname.startsWith("/.well-known/"))
        return new Response("Not found", { status: 404 });
      return oauthResponse(request, env, ctx);
    }
    /** What every session and every lane's identity is built from — ONE object per request. */
    const sessionInput: SessionInput = {
      contextNamespace: env.ITERATE_CONTEXT,
      waitUntil: (promise) => ctx.waitUntil(promise),
      directory: directory(env.DB),
      appConfig,
      secretsKv: env.SECRETS_KV,
    };
    const projectHost = projectHostOf(url.hostname, projectHostnameBase);
    if (projectHost) {
      // ADMISSION, before any Durable Object is dialled: a context is created on first touch, so a
      // hostname whose project the in-process directory does not know must never reach one — else
      // any label under the wildcard would mint durable storage from the public internet. One
      // directory read — the row resolves the host's label (an id or a slug) to the project's id;
      // an unknown project is 421.
      const project = await sessionInput.directory.getProject(projectHost.project);
      if (!project)
        return new Response(
          `421: no project ${JSON.stringify(projectHost.project)} is served here\n`,
          { status: 421 },
        );
      const projectId = project.id;
      const browserResponse = await browserClient(request, env, ctx, projectId);
      if (browserResponse) return browserResponse;
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const authorization = bearer
        ? await authorizationForToken(env, ctx, bearer)
        : await browserAuthorization(env, request, ctx);
      if (bearer && !authorization)
        return new Response("Invalid or revoked bearer", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        });
      if (
        authorization &&
        !(await sessionInput.directory.reachesProject(authorization.reach, projectId))
      )
        return new Response("This session cannot access this project", { status: 403 });
      if (authorization?.grant) ctx.waitUntil(recordGrantUse(env, authorization.grant));
      // the visitor's own cookies reach the app; the platform's cookie and bearer never do
      return env.ITERATE_CONTEXT.getByName(
        DurableObjectNameCodec.stringify({ projectId, path: "/" }),
      ).fetch(
        projectHostRequestTo(request, {
          app: projectHost.app,
          hops,
          appCookies: appCookies(request.headers.get("cookie")) || null,
          identity: {
            principal: authorization?.principal ?? null,
            platformBearer: Boolean(bearer && authorization),
          },
        }),
      );
    }
    // Under the base there are project hosts and nothing else: a hostname there that fails the
    // grammar (`site--prj_1`, `a.b.c`, `--x`) names no project host and must not fall through to the
    // control plane — a working platform origin on a name the platform never chose. 421.
    if (hostnameLabelsUnderBase(url.hostname, projectHostnameBase))
      return new Response(
        `421: ${url.hostname} is not a project host under ${projectHostnameBase}\n`,
        { status: 421 },
      );

    if (url.origin !== appConfig.platformOrigin)
      return new Response("Unknown platform origin", { status: 421 });

    // `<deployId> <environmentName>`: Cloudflare's version id of this deploy — the stamp a smoke
    // waits for (`wrangler deploy` prints it) — and which deployment this is (the app config section below).
    if (url.pathname === "/version") return new Response(`${deployId} ${environmentName}\n`);

    // Explicit operator fixtures. Public clients authenticate at the HTTP boundary.
    if (url.pathname === "/internal/rpc") {
      // newWorkersRpcResponse serves BOTH a WebSocket upgrade AND a one-shot HTTP batch —
      // a CLI script or cron does one POST, no socket handshake. (Batch sessions cannot hold
      // live capabilities: a live provide needs the relay to outlive the response —
      // the relay's lend call simply fails there, which is the honest error.)
      return newWorkersRpcResponse(request, new UnauthenticatedSession(sessionInput));
    }

    const identityResponse = await identityDoor(request, env);
    if (identityResponse) return identityResponse;
    if (!appConfig.mcpOrigin && url.pathname === "/mcp") return oauthResponse(request, env, ctx);
    const browserResponse = await browserClient(request, env, ctx, null);
    if (browserResponse) return browserResponse;
    if (url.pathname.startsWith("/api")) return new Response("Not found", { status: 404 });

    // THE STATIC ASSETS — the console's client bundle (dist/client, `vite build`) and the hosted /demo
    // page (public/demo.html, build-sdk.mjs) — are the PLATFORM HOST's. Every request runs
    // worker-first (wrangler.jsonc `run_worker_first: true` — the patterns are paths, never hostnames,
    // so "every host but a project host" is spelled by asking the binding HERE, after the project
    // hosts and the platform's own doors): no asset ever answers on a project host, and a miss falls
    // through to the control plane — the console's SSR. Absent in the workers lane.
    if ((request.method === "GET" || request.method === "HEAD") && env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    const issuerRoute =
      ["/login", "/logout", "/authorize", "/oauth/token", "/oauth/register"].includes(
        url.pathname,
      ) ||
      url.pathname.startsWith("/.well-known/") ||
      url.pathname.startsWith("/_serverFn/");
    if (!issuerRoute) {
      const authorization = await browserAuthorization(env, request, ctx);
      const headers = new Headers(request.headers);
      headers.delete(ITX_PRINCIPAL_HEADER);
      if (authorization) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(authorization.principal));
      const denied = auth.require(new Request(request, { headers }));
      if (denied) return denied;
    }

    // Everything else on the platform host is the CONTROL PLANE, in-process (src/control-plane.ts
    // lists its doors: the OAuth AS, /mcp, the console). One worker, one front door.
    return oauthResponse(request, env, ctx, consoleHandler);
  },
};
