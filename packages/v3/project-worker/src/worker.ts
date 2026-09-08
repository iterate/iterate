// The PROJECT WORKER — the stateless edge AND the front door. capnweb terminates at `/api`; a project
// host forwards to the IterateContextDurableObject over Workers RPC (the DO does the real work and stays
// hibernatable); the control plane (OAuth AS + D1 directory + /mcp) runs IN-PROCESS here (src/control-plane)
// — one worker, no fallback. A project host resolves its slug → project id through the directory.

import * as cloudflareWorkers from "cloudflare:workers";
import {
  newWorkersRpcResponse,
  RpcPromise as CapnwebRpcPromise,
  RpcStub as CapnwebRpcStub,
} from "capnweb";
import { IterateContextDurableObject, type Env } from "./iterate-context-durable-object.ts";
import { directory } from "./control-plane/directory.ts";
import { ANONYMOUS } from "./control-plane/app.ts";
import { currentSession } from "./control-plane/session.ts";
import controlPlane from "./control-plane/index.ts";
import type { Env as ControlPlaneEnv } from "./control-plane/env.ts";

/** The one worker's env: the DO's bindings plus the in-process control plane's (D1, OAuth KV, …). */
type WorkerEnv = Env & ControlPlaneEnv;
import { registerPipelinedRpcBrand } from "./context/dispatch.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./fetch/rpc-stub-fetch.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import { UnauthenticatedSession } from "./session.ts";
import { appConfigOf } from "./app-config.ts";
import {
  PROJECT_SESSION_PATH,
  projectHostOf,
  projectSessionCookieOf,
  projectSessionSetCookie,
  sameOriginPath,
  withoutProjectSessionCookie,
} from "./project-host.ts";
import { ITX_PRINCIPAL_HEADER, verifyProjectToken } from "./principal.ts";

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

// Bumped every deploy so a smoke test can wait for THIS build to propagate (workers.dev lags ~1-2min/colo).
const CODE_VERSION = "live-57";

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // PROJECT-HOST INGRESS (project-host.ts): a request on `<label>--<projectId>.<base>` IS the app
    // `itx.apps.<label>` of that project's ROOT context, the Request riding VERBATIM into the fetch
    // lane below — the URL, host-scoped cookies and WebSocket upgrades all survive, so a served page's
    // relative links work. Inbound `x-itx-*` are stripped first: the lane's headers are the platform's,
    // never a visitor's. Everything on a project host is the app's; the platform's own doors (`/api`,
    // `/expression`, `/version`) live on the worker's hostname.
    const {
      projectHostnameBase,
      projectTokenSecret,
      loginMode,
      sessionSecret,
      environmentName,
      deployId,
    } = appConfigOf(env);
    const projectHost = projectHostOf(url.hostname, projectHostnameBase);
    if (projectHost) {
      // ADMISSION, before any Durable Object is dialled: a context is created on first touch, so a
      // hostname whose project the in-process directory does not know must never reach one — else
      // any label under the wildcard would mint durable storage from the public internet. One
      // directory read; an unknown project is 421.
      const { projectId } = projectHost;
      if (!(await directory(env.DB).getProject(projectId)))
        return new Response(`421: no project ${JSON.stringify(projectId)} is served here\n`, {
          status: 421,
        });
      // THE SESSION DOOR on a project host: a project token (src/principal.ts) for THIS project
      // becomes the host-scoped cookie, and the browser goes on to `next`; `?logout` clears it.
      if (url.pathname === PROJECT_SESSION_PATH) {
        const location = sameOriginPath(url.searchParams.get("next") ?? "/", url.origin);
        if (url.searchParams.has("logout"))
          return new Response(null, {
            status: 303,
            headers: { location, "set-cookie": projectSessionSetCookie("", 0) },
          });
        const token = url.searchParams.get("token") ?? "";
        const claims = await verifyProjectToken(token, projectTokenSecret);
        if (!claims || claims.projectId !== projectId)
          return new Response("the project token did not verify for this project\n", {
            status: 401,
          });
        return new Response(null, {
          status: 303,
          headers: {
            location,
            "set-cookie": projectSessionSetCookie(token, (claims.expiresAt - Date.now()) / 1000),
          },
        });
      }
      const headers = new Headers(request.headers);
      for (const name of [...headers.keys()]) if (name.startsWith("x-itx-")) headers.delete(name);
      headers.set(ITX_EXPRESSION_FETCH_HEADER, `itx.apps.${projectHost.app}`);
      headers.set(ITX_EXPRESSION_LANE_HOPS_HEADER, "1");
      // WHO: a valid project token for this project stamps the principal the app (and the lane's
      // call) sees — the host cookie (a browser), or `Authorization: Bearer <projectToken>` (THE
      // MACHINE LANE: an MCP client, a script), the bearer winning when both are present. The token
      // itself never reaches the app (loaded code): only its verified stamp does — the platform's
      // cookie is dropped, and so is a bearer that IS a project token (an app's own bearer scheme
      // passes through untouched, exactly as a visitor's other cookies do).
      const cookieHeader = request.headers.get("cookie");
      const appCookies = withoutProjectSessionCookie(cookieHeader);
      if (appCookies) headers.set("cookie", appCookies);
      else headers.delete("cookie");
      const bearerToken = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const token = bearerToken ?? projectSessionCookieOf(cookieHeader);
      const claims = token ? await verifyProjectToken(token, projectTokenSecret) : null;
      if (bearerToken && claims) headers.delete("authorization");
      if (claims && claims.projectId === projectId)
        headers.set(
          ITX_PRINCIPAL_HEADER,
          JSON.stringify({ actor: claims.actor, ...(claims.email && { email: claims.email }) }),
        );
      return env.ITERATE_CONTEXT.getByName(
        DurableObjectNameCodec.stringify({ projectId, path: "/" }),
      ).fetch(new Request(request, { headers }));
    }

    // `<label> <environmentName> <deployId>`: the hand-bumped label first (a smoke greps it), then the
    // configuration (app-config.ts) — which deployment, and Cloudflare's version id of this deploy.
    if (url.pathname === "/version")
      return new Response(`${CODE_VERSION} ${environmentName} ${deployId}\n`);

    // /demo — the hosted live-state demo — is a STATIC ASSET (public/demo.html, built by
    // build-sdk.mjs; wrangler.jsonc `assets`): the platform serves it before this handler runs.

    // THE ONE capnweb ENTRYPOINT (the hard rule): capnweb terminates HERE, in the stateless worker;
    // the DO is reached only over Workers RPC. A client dials `/api` and holds an
    // `UnauthenticatedSession`: `authenticate().projects.get(projectId)` → the project's root itx.
    // WHO dials (session.ts): in `open` login mode everyone is the anonymous user; in `email` mode the
    // control plane's session cookie on THIS request — a browser's same-origin socket carries it.
    if (url.pathname === "/api") {
      const user = loginMode === "open" ? ANONYMOUS : await currentSession(request, sessionSecret);
      // newWorkersRpcResponse serves BOTH a WebSocket upgrade AND a one-shot HTTP batch —
      // a CLI script or cron does one POST, no socket handshake. (Batch sessions cannot hold
      // live capabilities: a live provide needs the relay to outlive the response —
      // the relay's lend call simply fails there, which is the honest error.)
      return newWorkersRpcResponse(
        request,
        new UnauthenticatedSession({
          contextNamespace: env.ITERATE_CONTEXT,
          waitUntil: (p) => ctx.waitUntil(p),
          directory: directory(env.DB),
          loginMode,
          user: user && { id: user.sub, email: user.email },
          projectTokenSecret,
        }),
      );
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
      headers.delete(ITX_PRINCIPAL_HEADER); // the stamp is the edge's, never a caller's
      headers.set(ITX_EXPRESSION_FETCH_HEADER, itxExpression);
      headers.set(ITX_EXPRESSION_LANE_HOPS_HEADER, String(hops));
      return env.ITERATE_CONTEXT.getByName(DurableObjectNameCodec.parse(context).name).fetch(
        new Request(request, { headers }),
      );
    }

    // Everything else on the platform host is the CONTROL PLANE, in-process (src/control-plane): login
    // + session, the OAuth AS (/authorize, /token, /.well-known, /register), /mcp, project creation
    // (/projects), and the console at /. The project-worker's own doors (/api, /expression, /version,
    // /demo) took precedence above. One worker, one front door.
    return controlPlane.fetch(request, env, ctx);
  },
};
