// Public host routing: the console, MCP and project apps share OAuth grants.
// Cap’n Web terminates at /api; project application requests enter the context DO.

import * as cloudflareWorkers from "cloudflare:workers";
import {
  newWorkersRpcResponse,
  RpcPromise as CapnwebRpcPromise,
  RpcSession,
  RpcStub as CapnwebRpcStub,
  WebSocketTransport,
} from "capnweb";
import { auth } from "iterate/next/sdk";
import { verifyClaims } from "iterate/next/principal";
import { registerPipelinedRpcBrand } from "iterate/next/expression";
import { ITX_PRINCIPAL_HEADER, type Principal } from "iterate/next/principal";
import { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
// the one worker's env: the DO's bindings plus the in-process control plane's (control-plane.ts `Env`)
import type { Env as WorkerEnv } from "./control-plane.ts";
import { identityDoor } from "./identity.ts";
import { isSecretOAuthState, SECRET_OAUTH_CALLBACK_PATH } from "./secret-oauth.ts";
import type { Reach } from "./directory.ts";
import { oauthResponse } from "./api.ts";
import { issuerHandler, issuerPagePaths } from "./control-plane.ts";
import { appConfigOf } from "./app-config.ts";
import { customProjectHostOf, projectHostOf, hostnameLabelsUnderBase } from "./hosts.ts";
import { FILES_APP_LABEL, serveProjectFileRequest } from "./context/file-urls.ts";
import { appCookies, browserAuthorization, browserClient } from "./browser-client.ts";
import { directory } from "./directory.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./context/rpc-stubs.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID, resourceScope } from "./iterate-context.ts";
import { IterateRpcTarget, SessionTeardown, type SessionInput } from "./session.ts";
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
 *  (an OAuth access token, the admin secret) removed (an app's own bearer scheme passes through
 *  untouched), then the expression the host names — `itx.apps.<app>`, or the
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
  headers.set(ITX_EXPRESSION_FETCH_HEADER, lane.app ? `itx.apps.${lane.app}` : "itx.worker");
  headers.set(PROJECT_HOST_HOPS_HEADER, String(lane.hops));
  if (lane.identity.principal)
    headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(lane.identity.principal));
  return new Request(request, { headers });
}

/** A secret's OWNER (iterate-context.ts `resourceScope`), read back from its id: a project's id,
 *  or `global--users--<id>` / `global--organizations--<id>`; `root` is the owner's root context —
 *  the catalog, where `itx.secrets` runs. */
function secretOwnerOf(owner: string): {
  kind: "project" | "users" | "organizations";
  id: string;
  root: string;
} {
  const [, kind, id] = /^global--(users|organizations)--(.+)$/.exec(owner) ?? [];
  if (kind !== "users" && kind !== "organizations")
    return {
      kind: "project",
      id: owner,
      root: DurableObjectNameCodec.stringify({ projectId: owner, path: "/" }),
    };
  return {
    kind,
    id: id || "",
    root: DurableObjectNameCodec.stringify({
      projectId: GLOBAL_PROJECT_ID,
      path: `/${kind}/${id}`,
    }),
  };
}

/** WHO may complete a secret's OAuth: a session that reaches the secret's owner — for a project's
 *  secret, a session reaching that project; for a user's own, that user; for an organization's, a
 *  member; the admin reaches every one. A project-bound bearer reaches no user's or organization's
 *  own secrets; nothing but the admin reaches the global root's. */
async function reachesSecretOwner(
  directory: SessionInput["directory"],
  reach: Reach,
  owner: ReturnType<typeof secretOwnerOf>,
): Promise<boolean> {
  if (reach === "every") return true;
  if (owner.kind === "project")
    return owner.id !== GLOBAL_PROJECT_ID && directory.reachesProject(reach, owner.id);
  if (!("userId" in reach)) return false;
  if (owner.kind === "users") return reach.userId === owner.id;
  return (await directory.listOrgs(reach.userId)).some((org) => org.id === owner.id);
}

/** A secret's OAuth callback: the provider redirected the human here with `code` and the
 *  platform-signed `state` (secret-oauth.ts) naming the secret's owner, its name and the nonce. WHO
 *  completes it is admitted the way a project host admits a visitor — the same platform session (a
 *  browser cookie, or a bearer) — and must reach the owner (`reachesSecretOwner`): a stranger who saw
 *  the authorize URL cannot plant their own provider account into someone else's secret. The
 *  secret's Durable Object then exchanges the code; a failure is a plain-text 4xx with the reason,
 *  never a credential. */
async function secretOAuthCallback(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  sessionInput: SessionInput,
): Promise<Response> {
  const url = new URL(request.url);
  const answer = (status: number, text: string) =>
    new Response(`${text}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  const claims = await verifyClaims(
    url.searchParams.get("state") ?? "",
    sessionInput.appConfig.sessionSecret.exposeSecret(),
  );
  if (!isSecretOAuthState(claims) || claims.exp <= Date.now())
    return answer(400, "This link is not one the platform issued, or it has expired.");
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const authorization = bearer
    ? await authorizationForToken(env, ctx, bearer)
    : await browserAuthorization(env, request, ctx);
  if (!authorization)
    return answer(
      401,
      "Sign in to Iterate in this browser first, then open this link again — the tokens go into a project you must be a member of.",
    );
  const owner = secretOwnerOf(claims.owner);
  if (!(await reachesSecretOwner(sessionInput.directory, authorization.reach, owner)))
    return answer(403, `Your session cannot access the secrets of ${claims.owner}.`);
  const denied = url.searchParams.get("error");
  if (denied) return answer(400, `The provider declined: ${denied}`);
  const code = url.searchParams.get("code");
  if (!code) return answer(400, "The provider sent no authorization code.");
  // Through the owner's root context — `itx.secrets.completeOAuth` (built-ins.ts) runs the exchange
  // in the secret's object and appends the catalog fact, serialized with every other write to
  // that name; the platform's own call, no principal.
  try {
    await env.ITERATE_CONTEXT.getByName(owner.root).invoke(
      ["itx", "builtins", "secrets", ["completeOAuth", claims.name, { code, nonce: claims.nonce }]],
      [],
      { principal: null },
    );
  } catch (error) {
    return answer(
      400,
      `Storing the tokens for ${claims.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return answer(
    200,
    `Done: the secret "${claims.name}" of ${claims.owner} holds the tokens. You can close this tab.`,
  );
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
export { BrowserSession } from "iterate/next/app-session";
export { SecretDurableObject } from "./secret-durable-object.ts";
// THE FIRST-PARTY FACETS: exported Durable Object classes hosted as facets of a context through
// `ctx.exports` (first-party-facets.ts FIRST_PARTY_FACET_CLASSES) — ordinary bundled
// worker code with the worker's real env, never a loaded source.
export { AccountDurableObject } from "./account/durable-object.ts";
export { AgentDurableObject } from "./agent/durable-object.ts";
export { ProjectDurableObject } from "./project/durable-object.ts";
export { RepoDurableObject } from "./repo/durable-object.ts";
export { WorkspaceDurableObject } from "./workspace/durable-object.ts";
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
    };
    // A project host under the base, or one of the deployment's custom hostnames (a project's apex).
    const projectHost =
      projectHostOf(url.hostname, projectHostnameBase) ??
      customProjectHostOf(url.hostname, appConfig.projectCustomHostnames);
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
      // THE FILES HOST (context/file-urls.ts): `files--<project>` serves a signed file URL straight
      // from the bucket, before any session or DO — the token in the URL is the authorization.
      if (projectHost.app === FILES_APP_LABEL)
        return serveProjectFileRequest({
          bucket: env.FILES,
          secret: appConfig.sessionSecret.exposeSecret(),
          project: projectId,
          keyPrefix: `${resourceScope(projectId, "/").id}/`,
          request,
        });
      const browserResponse = await browserClient(request, env, ctx);
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
      const root = new IterateRpcTarget(sessionInput, new SessionTeardown(), null);
      // A one-shot HTTP batch — a CLI script or cron does one POST, no socket handshake. (Batch
      // sessions cannot hold live capabilities: a live provide needs the relay to outlive the
      // response — the relay's lend call simply fails there, which is the honest error.)
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return newWorkersRpcResponse(request, root);
      // The WebSocket session spelled out (what newWorkersRpcResponse does) so the transport is ours:
      // a peer's `["abort", …]` frame is its only word on WHY it left — the ESP32's C client says
      // CAPNWEB_E_TOKEN_LIMIT and kin there — and capnweb consumes it without a hook.
      const pair = new WebSocketPair();
      pair[0].accept();
      const transport = new WebSocketTransport(pair[0] as unknown as WebSocket);
      new RpcSession(
        {
          send: (message) => transport.send(message),
          receive: async () => {
            const message = await transport.receive();
            if (message.startsWith('["abort"'))
              console.warn({
                event: "rpc-session-aborted-by-peer",
                namespace: "worker",
                message: "the client aborted its capnweb session and said why",
                door: "internal-rpc",
                reason: (JSON.parse(message) as [string, unknown])[1],
              });
            return message;
          },
          abort: (reason) => transport.abort(reason),
        },
        root,
      );
      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    // A project secret's OAuth callback (secret-oauth.ts): the provider sends the human back here
    // with the code. Its own reserved path, `/.secrets/`, beside `/version` and `/internal/rpc`.
    if (url.pathname === SECRET_OAUTH_CALLBACK_PATH)
      return secretOAuthCallback(request, env, ctx, sessionInput);
    const identityResponse = await identityDoor(request, env);
    if (identityResponse) return identityResponse;
    if (!appConfig.mcpOrigin && url.pathname === "/mcp") return oauthResponse(request, env, ctx);
    const browserResponse = await browserClient(request, env, ctx);
    if (browserResponse) return browserResponse;
    if (url.pathname.startsWith("/api")) return new Response("Not found", { status: 404 });

    // The issuer's own doors are open to a browser that is not signed in yet: the pages and their
    // files (control-plane.ts `issuerPagePaths`), the token and registration endpoints, discovery.
    const issuerRoute =
      issuerPagePaths.includes(url.pathname) ||
      ["/oauth/token", "/oauth/register"].includes(url.pathname) ||
      url.pathname.startsWith("/.well-known/");
    if (!issuerRoute) {
      const authorization = await browserAuthorization(env, request, ctx);
      const headers = new Headers(request.headers);
      headers.delete(ITX_PRINCIPAL_HEADER);
      if (authorization) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(authorization.principal));
      const denied = auth.require(new Request(request, { headers }));
      if (denied) return denied;
    }

    // Everything else on the platform host is the CONTROL PLANE, in-process (src/control-plane.ts
    // lists its doors: the OAuth AS, /mcp, the issuer's pages). One worker, one front door.
    return oauthResponse(request, env, ctx, issuerHandler);
  },
};
