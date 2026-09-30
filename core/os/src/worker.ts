// worker.ts — the one worker's fetch entry: the request is sorted top to bottom — a project host
// (the files host, else its fetch routes and the project's config worker, served here from the
// root's snapshot: `serveProjectHost`), the MCP origin, then the platform origin's
// own paths (`/version`, a preview's admin sign-in through prd, local dev's one click, the secret-OAuth callback, the
// integrations' callbacks and webhooks, Google identity, `/mcp`, the browser adapter's `/api` and `/.auth/*`) and, last, the OAuth provider with
// the issuer's pages as its catch-all.
// Cap’n Web terminates at `/api`; a project host's request is served where it arrived.

import { failureKind, isPlatformFailureKind, logPlatformFailure } from "iterate/platform-retry";
import { ITX_PRINCIPAL_HEADER, type Principal } from "iterate/principal";
import { forwardIssues, ITERATE_CAUSE_HEADER } from "iterate/lib";
import {
  ITERATE_BASE_PATH_HEADER,
  ITERATE_ROUTING_SLUG_HEADER,
  primaryHostnameUrlOf,
} from "iterate/project-ingress";
import { proxyPosthogRequest } from "./posthog-proxy.ts";
import { parseCause, crossingOneMore, newChain, requestCausedBy, type Cause } from "./cause.ts";
import { primaryHostnameRedirectOf } from "./primary-hostname-redirect.ts";
import { ITX_GRANT_HEADER, type Caller } from "./caller.ts";
import { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import type { Env as WorkerEnv } from "./env.ts";
import { identityResponse } from "./identity.ts";
import { OAUTH_INTEGRATION_PROVIDERS } from "./integrations/contract.ts";
import { SECRET_OAUTH_CALLBACK_PATH, secretOAuthCallbackPathOf } from "./secret-oauth.ts";
import { secretOAuthCallback } from "./secret-oauth-callback.ts";
import { receiveEmail } from "./integrations/email.ts";
import { slackWebhookRoute } from "./integrations/slack.ts";
import { githubCallbackRoute, githubWebhookRoute } from "./integrations/github.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { unavailableAnswer } from "./unavailable.ts";
import { oauthResponse } from "./api.ts";
import { issuerHandler } from "./issuer-pages.ts";
import {
  ADMIN_SIGN_IN_CALLBACK_PATH,
  ADMIN_SIGN_IN_CLIENT_PATH,
  ADMIN_SIGN_IN_PATH,
  adminSignInCallbackResponse,
  adminSignInClientMetadata,
  adminSignInResponse,
} from "./admin-sign-in.ts";
import { localSignInResponse } from "./local-sign-in.ts";
import { appConfigOf, platformAddressesOf, sessionSigningSecretOf } from "./app-config.ts";
import { captureIssueInPosthog } from "./posthog.ts";
import { serveProjectFileRequest } from "./context/file-urls.ts";
import { FILES_ROUTING_SLUG } from "./fetch-routes.ts";
import { appCookies, browserAuthorization, browserClient } from "./browser-client.ts";
import { itxExpressionEndingInFetch } from "./context/rpc-stubs.ts";
import { implicitRootsAt, resolveItxExpression } from "./context/itx-expression-rewriting.ts";
import { contextReach, statelessResolverFor } from "./context/stateless-context.ts";
import { matchFetchRoute } from "./fetch-routes.ts";
import { statelessExpressionFetch } from "./iterate-context.ts";
import { expressionFetchErrorAnswer } from "./unavailable.ts";
import { FETCH_UPGRADE_RESUMABLE_HEADER, spliceEyeballAnswer } from "./context/fetch-upgrade.ts";
import { DurableObjectNameCodec, resourceScope } from "./context/paths.ts";
import { authorizationForToken, recordGrantUse } from "./oauth.ts";
import { leasedProjectHostAnswer } from "./project-host-lease.ts";
import { projectHostCallerOf, projectHostSignInAnswerOf } from "./project-host-sign-in.ts";

/** The Request without its base path (paths ingress): the same method, body and upgrade, the URL
 *  starting at the app's root. */
function withoutBasePath(request: Request, basePath: string): Request {
  if (!basePath) return request;
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(basePath.length) || "/";
  return new Request(url, request);
}

/** THE EDGE'S LAST ANSWER, to a failure no route answered (a project host's admission or bearer,
 *  the files host, `/api`, the issuer's pages): the edge's one answer to it (`unavailableAnswer`).
 *  A platform failure is a 503 whose Retry-After its kind sets, logged
 *  `worker.platform-failure-answered`; the prd fault alarm pages on the 503 as on any 5xx a visitor
 *  is answered. Anything else, our own defect, is rethrown: the runtime's 500. A project's own error
 *  never gets here: `serveProjectHost` answers it. */
function platformFailureAnswer(error: unknown, request: Request): Response {
  const answer = unavailableAnswer(error);
  if (!answer) throw error;
  const kind = failureKind(error);
  if (isPlatformFailureKind(kind))
    logPlatformFailure("worker", "answered", kind, { name: "worker", message: String(error) });
  const { hostname } = new URL(request.url);
  return new Response(
    `${answer.status}: the platform could not answer ${hostname} just now; try again shortly\n`,
    answer,
  );
}

/** An app's answer without what only the platform may say on its origin: `Service-Worker-Allowed`
 *  (a service worker scoped to `/` would control the sign-in pages and `/api`) and a `Set-Cookie`
 *  for the platform's own `__Host-itx-*` cookies. A WebSocket's 101 carries neither. */
function withoutPlatformHeaders(answer: Response): Response {
  if (answer.webSocket) return answer;
  const setCookies = answer.headers.getSetCookie();
  const kept = setCookies.filter((cookie) => !cookie.trimStart().startsWith("__Host-itx-"));
  if (!answer.headers.has("service-worker-allowed") && kept.length === setCookies.length)
    return answer;
  const response = new Response(answer.body, answer);
  response.headers.delete("service-worker-allowed");
  response.headers.delete("set-cookie");
  for (const cookie of kept) response.headers.append("set-cookie", cookie);
  return response;
}

/** WHO a project host's request is, as the context DO's `fetch` reads it: `principal` is the
 *  verified stamp the context runs the call under (null: nobody) and `grant` the OAuth grant or
 *  personal access token it acts through; `platformBearer` says the `Authorization: Bearer` was the
 *  platform's own credential, which an app never sees. The operator's bearer is refused here
 *  (oauth.ts `authorizationForToken`). */
type ProjectHostIdentity = { principal: Principal | null; grant?: string; platformBearer: boolean };

/** The Request a project host serves (`serveProjectHost`) — the same Request, its URL, method, body
 *  and a WebSocket upgrade intact, with the headers made the platform's: every inbound `x-itx-*`
 *  gone (a pager or fetch-upgrade header from outside would enter a context's internal protocol),
 *  the cookie header replaced by `appCookies` (null ⇒ none — what the capability may see), a
 *  platform bearer (an OAuth access token, a personal access token) removed (a site's own bearer
 *  scheme passes through untouched), then the routing slug the host names in
 *  `x-iterate-routing-slug` (deleted for the apex, so a visitor's copy never survives) and the
 *  principal's stamp; our mark (cause.ts) is the app's to receive with its call. The edge picks the project only; the config worker's `fetch`
 *  routes on the routing slug in plain code. */
function projectHostRequestTo(
  request: Request,
  routing: {
    routingSlug: string | null;
    appCookies: string | null;
    identity: ProjectHostIdentity;
    /** paths ingress: the prefix stripped from the URL and said in `x-iterate-base-path` */
    basePath: string;
  },
): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-itx-")) headers.delete(name);
  if (routing.appCookies) headers.set("cookie", routing.appCookies);
  else headers.delete("cookie");
  if (routing.identity.platformBearer) headers.delete("authorization");
  if (routing.routingSlug) headers.set(ITERATE_ROUTING_SLUG_HEADER, routing.routingSlug);
  else headers.delete(ITERATE_ROUTING_SLUG_HEADER);
  if (routing.basePath) headers.set(ITERATE_BASE_PATH_HEADER, routing.basePath);
  else headers.delete(ITERATE_BASE_PATH_HEADER);
  if (routing.identity.principal)
    headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(routing.identity.principal));
  if (routing.identity.grant) headers.set(ITX_GRANT_HEADER, routing.identity.grant);
  // A WebSocket the edge will hold: a lent stub's upgrade answers resumable (spliceEyeballAnswer).
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
    headers.set(FETCH_UPGRADE_RESUMABLE_HEADER, "1");
  return new Request(withoutBasePath(request, routing.basePath), { headers });
}

/** A PROJECT HOST'S REQUEST, SERVED WHERE IT ARRIVED, never through the root's Durable Object: the
 *  root's snapshot (context/rule-snapshots.ts — at most one read per isolate per SNAPSHOT_TTL_MS)
 *  says where it goes. A fetch route that matches runs its target as a config worker's forward of
 *  it ran, loaded code at `/` with the request's caller stamps stripped (iterate-context.ts
 *  `statelessExpressionFetch`), behind the route's sign-in; any other request goes to the project's
 *  ingress under the visitor's caller — its published config, `itx.config`, loaded HERE with the
 *  root's authority. A target that lives in a context (a tunnel's lent stub) is one call there. A
 *  routing change answers its writer once no snapshot of the old routing can still be served
 *  (iterate-context-durable-object.ts `#snapshotChangeNeedsCommitWait`). */
async function serveProjectHost(args: {
  env: WorkerEnv;
  ctx: ExecutionContext;
  projectId: string;
  request: Request;
  caller: Caller;
}): Promise<Response> {
  const { env, ctx, projectId, request, caller } = args;
  const resolverUnder = (callerThere: Caller) =>
    statelessResolverFor({
      env,
      namespace: env.ITERATE_CONTEXT,
      address: DurableObjectNameCodec.address({ projectId, path: "/" }),
      caller: callerThere,
      ctx,
    });
  let label = "";
  try {
    const { routing, rules } = await contextReach({
      env,
      namespace: env.ITERATE_CONTEXT,
      projectId,
      platformOrigin: () => caller.platformOrigin || null,
      ctx,
    }).snapshotOf("/");
    const route = matchFetchRoute(routing.fetchRoutes, request);
    if (route?.authRequirement && !caller.principal)
      return new Response("Sign in\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
      });
    if (route)
      return await statelessExpressionFetch(
        resolverUnder({
          principal: null,
          app: true,
          platformOrigin: caller.platformOrigin,
          cause: caller.cause,
        }),
        () => route.target,
        request,
        JSON.stringify(route.target),
      );
    if (!routing.ingressTarget)
      return new Response(
        "This project has no site yet: its config worker's fetch serves this page once the project defines one\n",
        { status: 404 },
      );
    label = JSON.stringify(routing.ingressTarget);
    const ingress = itxExpressionEndingInFetch(routing.ingressTarget);
    // AN INGRESS THE SNAPSHOT DOES NOT RESOLVE IS ANSWERED HERE, never by a call to the root: a
    // project before its first publication would otherwise cost the root a call a request. A rule
    // the platform lands answers its writer only once no older snapshot is in use
    // (iterate-context-durable-object.ts `#snapshotChangeNeedsCommitWait`).
    resolveItxExpression(() => rules, ingress, implicitRootsAt(projectId, "/"));
    const answer = await resolverUnder(caller).invoke(ingress, request);
    return answer instanceof Response
      ? answer
      : new Response(`expression fetch: ${JSON.stringify(answer)}\n`);
  } catch (error) {
    return expressionFetchErrorAnswer(error, label);
  }
}

// Every `reportIssue` in this script — edge and Durable Objects share the module graph — also goes
// to PostHog Error Tracking (posthog.ts).
forwardIssues(captureIssueInPosthog);

export { IterateContextDurableObject };
export { BrowserSession } from "iterate/app-session";
// THE FIRST-PARTY FACETS: exported Durable Object classes hosted as facets of a context through
// `ctx.exports` (first-party-facets.ts FIRST_PARTY_FACET_CLASSES) — ordinary bundled
// worker code with the worker's real env, never a loaded source.
export { AccountDurableObject } from "./account/durable-object.ts";
export { EmailDurableObject } from "./email/durable-object.ts";
export { InstanceDurableObject } from "./instance/durable-object.ts";
export { OrganizationDurableObject } from "./organization/durable-object.ts";
export { ProjectDurableObject } from "./project/durable-object.ts";
export { RepoDurableObject } from "./repo/durable-object.ts";
export { SecretDurableObject } from "./secret/durable-object.ts";
export { WorkspaceDurableObject } from "./workspace/durable-object.ts";
export { ItxEntrypoint } from "./iterate-context.ts";
// Workers AI for a context's `itx.ai`, minted per project with the project as props.
export { ItxAi } from "./itx-ai.ts";
// A secret's exchange code's only egress, minted per jail with the pin as props.
export { PinnedOutbound } from "./secret/exchange-jail.ts";

/** The request, sorted as the header says; what it throws is `platformFailureAnswer`'s. */
async function routeRequest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  // OUR MARK (cause.ts): a request our own code sent resumes its chain, one context further.
  const mark = parseCause(request.headers.get(ITERATE_CAUSE_HEADER));
  const ray = request.headers.get("cf-ray");
  let cause: Cause;
  try {
    cause = mark
      ? crossingOneMore(mark, `a request to ${url.host}`)
      : newChain(`a request to ${url.host}${ray ? ` (ray ${ray})` : ""}`);
  } catch (error) {
    return new Response(`508: ${error instanceof Error ? error.message : String(error)}\n`, {
      status: 508,
    });
  }
  // what reads the mark from here on (/api, /mcp) reads it one context further
  if (mark) request = requestCausedBy(request, cause);

  const appConfig = appConfigOf(env);
  const { deployId } = appConfig;
  // A blank `urls.os` (a self-host, SELF-HOSTING.md) makes each request's own origin the
  // platform's, and OAuth takes no plain-http issuer or resource but a loopback one (the library
  // throws building them): a plain-http request goes to its HTTPS origin first.
  if (
    !appConfig.urls.os &&
    url.protocol === "http:" &&
    !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(url.hostname)
  )
    return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 308);
  if (appConfig.urls.mcp && url.origin === appConfig.urls.mcp) {
    // MCP's public root is its protocol endpoint; /api remains Cap'n Web.
    if (url.pathname !== "/" && !url.pathname.startsWith("/.well-known/"))
      return new Response("Not found", { status: 404 });
    return oauthResponse(request, env, ctx);
  }
  // THE PLATFORM ADDRESSES (app-config.ts `platformAddressesOf`): the origin — `urls.os`, else
  // this request's own — stamped on every caller from here on, and the two resource identifiers.
  const addresses = platformAddressesOf(env, request);
  const { platformOrigin } = addresses;
  const controlPlane = new ControlPlane(env);
  const routing = appConfig.urls.ingressRouting;
  // PROJECT-HOST INGRESS: a request on any host of a project reaches the project's config worker —
  // the Request riding into the context DO's `fetch` with its URL, the visitor's own cookies and a
  // WebSocket upgrade intact, the routing slug the host names said in `x-iterate-routing-slug`. The
  // browser adapter's `/api` and `/.auth/*` are the site's own on a host of its own (subdomains)
  // and the issuer's under paths, where the site shares the platform's origin.
  // ADMISSION, before any PROJECT Durable Object is dialled: a context is created on first
  // touch, so a hostname whose project the control plane does not know must never reach one —
  // else any label under the wildcard would mint durable storage from the public internet. The
  // host's address (a static rule, else a hostname a project added: one catalog read), then one
  // catalog read (a row kept five seconds per isolate, an unknown label never: edge.ts) — the row
  // resolves the host's label (a slug, an id would do too) to the project's id; an unknown label
  // is 421. A slow read is waited for; one that fails on the platform's side is a 503
  // (`platformFailureAnswer`).
  const projectHost = await controlPlane.projectHostOf(appConfig, url, platformOrigin);
  if (projectHost) {
    const project = await controlPlane.getProject(projectHost.project);
    if (!project)
      return new Response(
        `421: no project ${JSON.stringify(projectHost.project)} is served here\n`,
        { status: 421 },
      );
    const projectId = project.id;
    // THE FILES HOST (context/file-urls.ts): `files--<project>` serves a signed file URL straight
    // from the bucket, before any session or DO — the token in the URL is the authorization.
    if (projectHost.routingSlug === FILES_ROUTING_SLUG) {
      const file = await serveProjectFileRequest({
        bucket: env.FILES,
        secret: await sessionSigningSecretOf(appConfig),
        project: projectId,
        keyPrefix: `${resourceScope(projectId, "/").id}/`,
        request: withoutBasePath(request, projectHost.basePath),
      });
      // Under paths a stored HTML or SVG file is a document on the platform's own origin that anyone
      // holding the URL opens: it runs sandboxed (an opaque origin, no cookie to spend).
      if (routing?.type === "paths")
        file.headers.set(
          "content-security-policy",
          "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
        );
      return file;
    }
    // The browser adapter's endpoints (`/api`, `/.auth/*`) are an app's OWN under subdomains — its
    // origin. Under paths the app shares the platform's origin, whose `/api` and `/.auth/*` are the
    // platform's; same-origin app scripts can make authenticated platform requests.
    if (routing?.type !== "paths") {
      const browserResponse = await browserClient(request, env, ctx);
      if (browserResponse) return browserResponse;
    }
    // THE PRIMARY HOSTNAME (primary-hostname-redirect.ts): a navigation on the ingress base goes
    // to the project's own hostname, which the admission's row carries (edge.ts `getProject`),
    // after the browser adapter so a sign-in under way finishes where it started.
    const redirect = primaryHostnameRedirectOf(request, { routing, platformOrigin });
    const location =
      redirect &&
      project.primaryHostname &&
      primaryHostnameUrlOf(project.primaryHostname, {
        routingSlug: redirect.routingSlug,
        path: `${url.pathname}${url.search}`,
      });
    // no-store: a browser keeps a 308 it may cache, and the primary can change
    if (location)
      return new Response(null, {
        status: 308,
        headers: { location: location.href, "cache-control": "no-store" },
      });
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const authorization = bearer
      ? await authorizationForToken(env, bearer, addresses, "project-host")
      : await browserAuthorization(env, request);
    if (bearer && !authorization)
      return new Response("Invalid or revoked bearer", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      });
    const reachesProject = authorization
      ? await controlPlane.reachesProject(authorization.reach, projectId)
      : false;
    // WHO ARRIVES (project-host-sign-in.ts): a member is stamped; a non-member, or a session
    // cookie on a cross-site write or upgrade, goes on anonymous — the app decides what that sees
    const caller = projectHostCallerOf({
      authorization: authorization && { via: bearer ? "bearer" : "cookie", reachesProject },
      request,
    });
    const stamped = caller === "member" ? authorization : null;
    if (stamped?.grant) ctx.waitUntil(recordGrantUse(env, stamped.grant));
    // the visitor's own cookies reach the app; the platform's cookie and bearer never do
    const identity = {
      principal: stamped?.principal || null,
      grant: stamped?.grant?.grantId,
      platformBearer: Boolean(bearer && authorization),
    };
    // A lent stub's WebSocket (a tunnel's) is held HERE, not by the context: it survives the
    // context's sockets dropping — every deploy resets them (context/fetch-upgrade-splice.ts).
    const served = await serveProjectHost({
      env,
      ctx,
      projectId,
      request: projectHostRequestTo(request, {
        routingSlug: projectHost.routingSlug,
        appCookies: appCookies(request.headers.get("cookie")) || null,
        identity,
        basePath: projectHost.basePath,
      }),
      caller: { principal: identity.principal, grant: identity.grant, platformOrigin, cause },
    });
    const answer = withoutPlatformHeaders(
      spliceEyeballAnswer(served, (path) =>
        env.ITERATE_CONTEXT.getByName(DurableObjectNameCodec.stringify({ projectId, path })),
      ),
    );
    // The app's `401 Bearer realm="iterate"` becomes the sign-in (project-host-sign-in.ts), at the
    // browser adapter serving this host: the host's own under subdomains, the platform's under paths.
    const signIn = projectHostSignInAnswerOf({
      answer,
      request,
      caller,
      projectSlug: project.slug,
      loginUrl: `${routing?.type === "paths" ? platformOrigin : url.origin}/.auth/login`,
    });
    if (signIn && answer.body) ctx.waitUntil(answer.body.cancel());
    // A MEMBER'S BEARER GRANT holds what stays open (a WebSocket, a streamed body) to its lease:
    // ended, expired or out of the project, the connection closes within a minute
    // (project-host-lease.ts).
    return (
      signIn ||
      (bearer && stamped?.grant
        ? leasedProjectHostAnswer(env, stamped.grant, stamped.reach, projectId, answer)
        : answer)
    );
  }
  // Under a subdomains wildcard there are project hosts and nothing else: a hostname there that
  // fails the grammar (`site--prj_1`, `a.b.c`, `--x`) names no project host and must not fall
  // through to the control plane — a working platform origin on a name the platform never chose. 421.
  if (
    routing?.type === "subdomains" &&
    url.hostname.toLowerCase().replace(/\.$/, "").endsWith(`.${routing.hostname}`)
  )
    return new Response(`421: ${url.hostname} is not a project host under ${routing.hostname}\n`, {
      status: 421,
    });

  // A platform request, then — on the platform origin (a deployment with `urls.os` set answers there
  // and on its project hosts, nowhere else).
  if (url.origin !== platformOrigin)
    return new Response("Unknown platform origin", { status: 421 });

  // `<deployId> <platformOrigin>`: Cloudflare's version id of this deploy — the stamp a smoke
  // waits for (`wrangler deploy` prints it) — and the origin this deployment answers on.
  if (url.pathname === "/version") return new Response(`${deployId} ${platformOrigin}\n`);
  // An admin's sign-in through another issuer (admin-sign-in.ts), prd's for a preview: its start,
  // that issuer's answer, and this deployment's client metadata document, which the issuer
  // fetches. None of them exists where `login.adminIssuer` is unset — prd, and every deployment
  // on its own domain, which app-config.ts refuses it on.
  const adminIssuer = appConfig.login.adminIssuer;
  if (adminIssuer && request.method === "GET") {
    if (url.pathname === ADMIN_SIGN_IN_PATH) return adminSignInResponse(request, env, adminIssuer);
    if (url.pathname === ADMIN_SIGN_IN_CALLBACK_PATH)
      return adminSignInCallbackResponse(request, env, adminIssuer);
    if (url.pathname === ADMIN_SIGN_IN_CLIENT_PATH)
      return Response.json(adminSignInClientMetadata(platformOrigin), {
        headers: { "cache-control": "public, max-age=300" },
      });
  }
  // Local dev's one click (local-sign-in.ts, `pnpm getin`): on a laptop's platform alone.
  const localSignIn = await localSignInResponse(request, env);
  if (localSignIn) return localSignIn;
  // posthog-js's `api_host` on the issuer's own pages (routes/__root.tsx): PostHog EU through
  // this origin.
  if (url.pathname.startsWith("/e/")) return proxyPosthogRequest({ request, proxyPrefix: "/e" });

  // A project secret's OAuth callback (secret-oauth.ts): the provider sends the human back here
  // with the code. Its own reserved path, `/.secrets/`, beside `/version` — and an integration's,
  // the URL iterate's Slack app and Google client are registered with.
  if (
    url.pathname === SECRET_OAUTH_CALLBACK_PATH ||
    OAUTH_INTEGRATION_PROVIDERS.some(
      (platform) => url.pathname === secretOAuthCallbackPathOf({ platform }),
    )
  )
    return secretOAuthCallback(request, env, addresses);
  // Slack's and GitHub's webhooks and GitHub's connect callback (src/integrations/).
  const integrationResponse =
    (await slackWebhookRoute(request, env)) ||
    (await githubWebhookRoute(request, env)) ||
    (await githubCallbackRoute(request, env, addresses));
  if (integrationResponse) return integrationResponse;
  const identity = await identityResponse(request, env);
  if (identity) return identity;
  if (url.pathname === "/mcp") {
    // With its own origin configured, MCP lives THERE: a client (or a person) pointed at the
    // platform's /mcp is sent to it, method and body kept (308), instead of falling through to the
    // issuer's pages and a bare "Sign in first".
    if (appConfig.urls.mcp) return Response.redirect(`${appConfig.urls.mcp}/`, 308);
    return oauthResponse(request, env, ctx);
  }
  const browserResponse = await browserClient(request, env, ctx);
  if (browserResponse) return browserResponse;
  // `/api` itself was answered above; anything under it is nothing — without this line a bearer
  // on `/api/<anything>` would pass the `/api` resource's gate (its paths are the resource's,
  // api.ts) and reach Cap'n Web.
  if (url.pathname.startsWith("/api")) return new Response("Not found", { status: 404 });

  // Everything else on the platform origin is OAuth (api.ts, oauth.ts: the authorization
  // server's token and registration endpoints and metadata, each resource's metadata) with the
  // issuer's pages — the authorize endpoint's consent page among them — as its catch-all
  // (issuer-pages.ts): every one an open path, or a 404.
  return oauthResponse(request, env, ctx, issuerHandler);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      return platformFailureAnswer(error, request);
    }
  },

  // Cloudflare Email Routing's catch-all on the project email domain (integrations/email.ts).
  async email(message: ForwardableEmailMessage, env: WorkerEnv) {
    await receiveEmail(message, env);
  },
};
