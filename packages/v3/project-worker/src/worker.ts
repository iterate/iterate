// The PROJECT WORKER — the stateless edge AND the front door. capnweb terminates at `/api`; a project
// host forwards to the IterateContextDurableObject over Workers RPC (the DO does the real work and stays
// hibernatable); the control plane (OAuth AS + D1 directory + /mcp) runs IN-PROCESS here (src/control-plane)
// — one worker, one front door. A project host names its project; the directory confirms it exists.

import * as cloudflareWorkers from "cloudflare:workers";
import {
  newWorkersRpcResponse,
  RpcPromise as CapnwebRpcPromise,
  RpcStub as CapnwebRpcStub,
} from "capnweb";
import { IterateContextDurableObject, type Env } from "./iterate-context-durable-object.ts";
import { directory } from "./control-plane/directory.ts";
import {
  currentSession,
  identity,
  type Session as ControlPlaneSession,
} from "./control-plane/session.ts";
import controlPlane from "./control-plane/index.ts";
import type { Env as ControlPlaneEnv } from "./control-plane/env.ts";

/** The one worker's env: the DO's bindings plus the in-process control plane's (D1, OAuth KV, …). */
type WorkerEnv = Env & ControlPlaneEnv;
import { registerPipelinedRpcBrand } from "./context/dispatch.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./fetch/rpc-stub-fetch.ts";
import {
  DurableObjectNameCodec,
  type DurableObjectAddress,
} from "./context/durable-object-names.ts";
import { UnauthenticatedSession } from "./session.ts";
import { appConfigOf, type AppConfig } from "./app-config.ts";
import {
  PROJECT_SESSION_PATH,
  projectHostOf,
  projectSessionCookieOf,
  projectSessionSetCookie,
  sameOriginPath,
  withoutProjectSessionCookie,
} from "./project-host.ts";
import {
  ITX_PRINCIPAL_HEADER,
  verifyProjectToken,
  type Principal,
  type ProjectTokenClaims,
} from "./principal.ts";

/** The fetch lane's re-entry count: `/expression?itx=itx.fetch` egresses to its own URL and lands
 *  here again with the same query; the header counts the passes and the lane refuses past a few. */
const ITX_EXPRESSION_LANE_HOPS_HEADER = "x-itx-expression-hops";
const ITX_EXPRESSION_LANE_MAX_HOPS = 4;

/** WHO a lane's request is, as both lanes into a context read it. `principal` is the verified stamp
 *  the context runs the call under: a project token for THIS project as `Authorization: Bearer`
 *  (the machine lane — an MCP client, a script) or as the host cookie (a browser), the bearer
 *  winning when both are present; else, in `email` login mode, the control plane's session user,
 *  stamped as `/api` stamps it (session.ts). `bearerClaims` is the project token the bearer
 *  carried, for ANY project — the platform's credential, which an app never sees (a token for
 *  another project stamps nothing, and the cookie still may). `user` is the control plane's session
 *  user in `email` mode, or null — what the `/expression` lane's membership check reads. */
type LaneIdentity = {
  principal: Principal | null;
  bearerClaims: ProjectTokenClaims | null;
  user: ControlPlaneSession | null;
};

async function laneIdentityOf(
  request: Request,
  projectId: string,
  { projectTokenSecret, loginMode, sessionSecret }: AppConfig,
): Promise<LaneIdentity> {
  const bearerToken = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const bearerClaims = bearerToken
    ? await verifyProjectToken(bearerToken, projectTokenSecret)
    : null;
  const cookieToken = projectSessionCookieOf(request.headers.get("cookie"));
  const tokenClaims =
    bearerClaims?.projectId === projectId
      ? bearerClaims
      : cookieToken
        ? await verifyProjectToken(cookieToken, projectTokenSecret)
        : null;
  const user = loginMode === "email" ? await currentSession(request, sessionSecret) : null;
  const principal =
    tokenClaims?.projectId === projectId
      ? { actor: tokenClaims.actor, ...(tokenClaims.email && { email: tokenClaims.email }) }
      : user
        ? { actor: user.sub, email: user.email }
        : null;
  return { principal, bearerClaims, user };
}

/** The Request a lane hands the context DO — the same Request, its URL, method, body and a
 *  WebSocket upgrade intact, with the headers made the platform's: every inbound `x-itx-*` gone (a
 *  pager or fetch-upgrade header from outside would enter the DO's internal protocol), the cookie
 *  header replaced by `appCookies` (null ⇒ none — what the capability may see), a project-token
 *  bearer removed (an app's own bearer scheme passes through untouched), then the expression, the
 *  hop count and the principal's stamp. */
function laneRequestTo(
  request: Request,
  lane: { itxExpression: string; hops: number; appCookies: string | null; identity: LaneIdentity },
): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-itx-")) headers.delete(name);
  if (lane.appCookies) headers.set("cookie", lane.appCookies);
  else headers.delete("cookie");
  if (lane.identity.bearerClaims) headers.delete("authorization");
  headers.set(ITX_EXPRESSION_FETCH_HEADER, lane.itxExpression);
  headers.set(ITX_EXPRESSION_LANE_HOPS_HEADER, String(lane.hops));
  if (lane.identity.principal)
    headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(lane.identity.principal));
  return new Request(request, { headers });
}

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

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // THE HOP COUNT, for both lanes into a context: an app or an expression that fetches its own
    // host or the fetch lane's URL re-enters here through egress; each pass counts, a few is a loop.
    // The platform writes the count as digits; anything else (an app spelling "NaN" to defeat the
    // budget — `NaN > max` is never true) is over budget by definition.
    const hopsHeader = request.headers.get(ITX_EXPRESSION_LANE_HOPS_HEADER) ?? "0";
    const hops = /^\d{1,3}$/.test(hopsHeader) ? Number(hopsHeader) + 1 : Infinity;
    if (hops > ITX_EXPRESSION_LANE_MAX_HOPS)
      return new Response(
        `the request re-entered itself ${Number.isFinite(hops) ? hops : `"${hopsHeader}"`} times (an app or an expression fetching its own lane)\n`,
        { status: 508 },
      );

    // PROJECT-HOST INGRESS (project-host.ts): a request on `<label>--<projectId>.<base>` IS the app
    // `itx.apps.<label>` of that project's ROOT context, the Request riding into the fetch lane
    // below with its URL, the app's own cookies and a WebSocket upgrade intact (laneRequestTo), so
    // a served page's relative links work. Everything on a project host is the app's; the
    // platform's own doors (`/api`, `/expression`, `/version`) live on the worker's hostname.
    const appConfig = appConfigOf(env);
    const { projectHostnameBase, projectTokenSecret, loginMode, environmentName, deployId } =
      appConfig;
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
      // WHO (laneIdentityOf) and WHAT THE APP SEES (laneRequestTo): the visitor's own cookies reach
      // the app; the platform's project-session cookie and a project-token bearer never do — only
      // the verified stamp.
      return env.ITERATE_CONTEXT.getByName(
        DurableObjectNameCodec.stringify({ projectId, path: "/" }),
      ).fetch(
        laneRequestTo(request, {
          itxExpression: `itx.apps.${projectHost.app}`,
          hops,
          appCookies: withoutProjectSessionCookie(request.headers.get("cookie")) || null,
          identity: await laneIdentityOf(request, projectId, appConfig),
        }),
      );
    }

    // `<deployId> <environmentName>`: Cloudflare's version id of this deploy — the stamp a smoke
    // waits for (`wrangler deploy` prints it) — and which deployment this is (app-config.ts).
    if (url.pathname === "/version") return new Response(`${deployId} ${environmentName}\n`);

    // /demo — the hosted live-state demo — is a STATIC ASSET (public/demo.html, built by
    // build-sdk.mjs; wrangler.jsonc `assets`): the platform serves it before this handler runs.

    // THE ONE capnweb ENTRYPOINT (the hard rule): capnweb terminates HERE, in the stateless worker;
    // the DO is reached only over Workers RPC. A client dials `/api` and holds an
    // `UnauthenticatedSession`: `authenticate().projects.get(projectId)` → the project's root itx.
    // WHO dials (session.ts): in `open` login mode everyone is the anonymous user; in `email` mode the
    // control plane's session cookie on THIS request — a browser's same-origin socket carries it.
    if (url.pathname === "/api") {
      const user = await identity(request, env);
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
          user,
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
      let address: DurableObjectAddress;
      try {
        address = DurableObjectNameCodec.parse(context);
      } catch (error) {
        return new Response(`${(error as Error).message}\n`, { status: 400 });
      }
      const identity = await laneIdentityOf(request, address.projectId, appConfig);
      // ADMISSION: in `email` login mode the caller must be a member of the project — the control
      // plane's cookie (this IS the platform host) or a project-token bearer for it; `open` mode is
      // open here exactly as `/api` is (the trusted-client doctrine every local proof relies on).
      if (loginMode === "email") {
        const admitted =
          identity.bearerClaims?.projectId === address.projectId ||
          (identity.user !== null &&
            (await directory(env.DB).listProjects(identity.user.sub)).some(
              (project) => project.id === address.projectId,
            ));
        if (!admitted)
          return new Response("401: sign in as a member of this project, or bear its token\n", {
            status: 401,
          });
      }
      // No cookie reaches the capability: every cookie on the platform host is the platform's own.
      const response = await env.ITERATE_CONTEXT.getByName(address.name).fetch(
        laneRequestTo(request, { itxExpression, hops, appCookies: null, identity }),
      );
      if (response.status === 101) return response;
      // The answer is LOADED code's, served on the PLATFORM's origin: a document it returns must not
      // run as this origin (its script would reach `/api` with the visitor's session cookie — every
      // project the visitor can reach). A CSP sandbox gives it an opaque origin: scripts and forms
      // run, cookies and same-origin authority do not. An app that needs an origin is a project host.
      const headers = new Headers(response.headers);
      headers.set("content-security-policy", "sandbox allow-scripts allow-forms");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // Everything else on the platform host is the CONTROL PLANE, in-process (src/control-plane): login
    // + session, the OAuth AS (/authorize, /token, /.well-known, /register), /mcp, project creation
    // (/projects), and the console at /. The project-worker's own doors (/api, /expression, /version,
    // /demo) took precedence above. One worker, one front door.
    return controlPlane.fetch(request, env, ctx);
  },
};
