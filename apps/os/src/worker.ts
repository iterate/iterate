// worker.ts — the one worker's fetch entry: the request is sorted top to bottom — a project host
// (the app it names, the files host, the config worker), the MCP origin, then the platform origin's
// own paths (`/version`, a preview's one-click `/.auth/test-link`, the secret-OAuth callback, Google
// identity, `/mcp`, the browser adapter's `/api` and `/.auth/*`) and, last, the OAuth provider with
// the issuer's pages as its catch-all.
// Cap’n Web terminates at `/api`; a project host's request rides into the context DO.

import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import { ITX_GRANT_HEADER, ITX_PRINCIPAL_HEADER, type Principal } from "iterate/next/principal";
import { forwardIssues } from "iterate/next/lib";
import { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import type { Env as WorkerEnv } from "./env.ts";
import { identityResponse } from "./identity.ts";
import { SECRET_OAUTH_CALLBACK_PATH } from "./secret-oauth.ts";
import { secretOAuthCallback } from "./secret-oauth-callback.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { oauthResponse } from "./api.ts";
import { issuerHandler } from "./issuer-pages.ts";
import { testLinkResponse } from "./issuer-session.ts";
import { TEST_LINK_PATH } from "./test-link.ts";
import {
  appConfigOf,
  platformAddressesOf,
  projectHostOf,
  sessionSigningSecretOf,
} from "./app-config.ts";
import { captureIssueInPosthog } from "./posthog.ts";
import { FILES_APP_LABEL, serveProjectFileRequest } from "./context/file-urls.ts";
import { appCookies, browserAuthorization, browserClient } from "./browser-client.ts";
import { ITX_EXPRESSION_FETCH_HEADER, ITX_PLATFORM_ORIGIN_HEADER } from "./context/rpc-stubs.ts";
import { DurableObjectNameCodec, resourceScope } from "./context/paths.ts";
import { authorizationForToken, recordGrantUse } from "./oauth.ts";

/** A project host's re-entry count — THE COUNT THE APP FORWARDS: an app that fetches its own host
 *  and forwards the headers it was handed re-enters with the count on them, each pass adds one, and
 *  the edge refuses past a few. A fresh Request starts at zero — an app looping its own project
 *  with fresh Requests is its own cost. */
const PROJECT_HOST_HOPS_HEADER = "x-itx-expression-hops";

/** THE BASE PATH an app is served under (paths ingress: `/projects/<project>/<app>`), alongside
 *  `x-iterate-app`: the edge strips it from the URL the app sees and says it here, so
 *  the app's own links and its browser adapter can compose absolute paths. Set or deleted by the
 *  edge on every project request, so a visitor's spelling never reaches an app. Empty under
 *  subdomains (the app owns its origin). */
const ITERATE_BASE_PATH_HEADER = "x-iterate-base-path";

/** THE SANDBOX every document served through paths ingress runs in: an opaque origin — no cookies,
 *  no storage, no scripting of other frames, `Origin: null` on every request it makes — so a
 *  project's app on the platform's own origin can neither spend the issuer's cookie nor read another
 *  project's. Set by the edge AFTER the app answers; an app cannot remove it. A WebSocket answer
 *  carries no document and is left alone. */
const PATHS_INGRESS_SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** The Request without its base path (paths ingress): the same method, body and upgrade, the URL
 *  starting at the app's root. */
function withoutBasePath(request: Request, basePath: string): Request {
  if (!basePath) return request;
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(basePath.length) || "/";
  return new Request(url, request);
}

/** An app's answer through paths ingress, sandboxed (PATHS_INGRESS_SANDBOX). */
function sandboxed(response: Response): Response {
  if (response.webSocket) return response;
  const answer = new Response(response.body, response);
  answer.headers.set("content-security-policy", PATHS_INGRESS_SANDBOX);
  return answer;
}

/** WHO a project host's request is, as the context DO's `fetch` reads it: `principal` is the
 *  verified stamp the context runs the call under (null: nobody) and `grant` the OAuth grant it
 *  acts through (absent for the admin secret); `platformBearer` says the `Authorization: Bearer`
 *  was the platform's own credential, which an app never sees. */
type ProjectHostIdentity = { principal: Principal | null; grant?: string; platformBearer: boolean };

/** The Request a project host hands the context DO — the same Request, its URL, method, body and a
 *  WebSocket upgrade intact, with the headers made the platform's: every inbound `x-itx-*` gone (a
 *  pager or fetch-upgrade header from outside would enter the DO's internal protocol), the cookie
 *  header replaced by `appCookies` (null ⇒ none — what the capability may see), a platform bearer
 *  (an OAuth access token, the admin secret) removed (an app's own bearer scheme passes through
 *  untouched), then the expression the host names — `itx.apps.<app>`, or the
 *  configured explicit ingress target for a host with no app label (an empty expression
 *  header selects the target stored on the root context) — the hop count and the principal's stamp.
 *  The app label the app sees (`x-iterate-app`) is not written here: the DO's `fetch` derives it from
 *  the expression, on every `x-itx-expression` Request (iterate-context-durable-object.ts). */
function projectHostRequestTo(
  request: Request,
  routing: {
    app: string | null;
    hops: number;
    appCookies: string | null;
    identity: ProjectHostIdentity;
    /** paths ingress: the prefix stripped from the URL and said in `x-iterate-base-path` */
    basePath: string;
    /** the platform origin this request reached the platform on (app-config.ts `platformAddressesOf`) */
    platformOrigin: string;
  },
): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-itx-")) headers.delete(name);
  if (routing.appCookies) headers.set("cookie", routing.appCookies);
  else headers.delete("cookie");
  if (routing.identity.platformBearer) headers.delete("authorization");
  headers.set(ITX_EXPRESSION_FETCH_HEADER, routing.app ? `itx.apps.${routing.app}` : "");
  headers.set(PROJECT_HOST_HOPS_HEADER, String(routing.hops));
  headers.set(ITX_PLATFORM_ORIGIN_HEADER, routing.platformOrigin);
  if (routing.basePath) headers.set(ITERATE_BASE_PATH_HEADER, routing.basePath);
  else headers.delete(ITERATE_BASE_PATH_HEADER);
  if (routing.identity.principal)
    headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(routing.identity.principal));
  if (routing.identity.grant) headers.set(ITX_GRANT_HEADER, routing.identity.grant);
  return new Request(withoutBasePath(request, routing.basePath), { headers });
}

// Every `reportIssue` in this script — edge and Durable Objects share the module graph — also goes
// to PostHog Error Tracking (posthog.ts).
forwardIssues(captureIssueInPosthog);

export { IterateContextDurableObject };
export { BrowserSession } from "iterate/next/app-session";
// THE FIRST-PARTY FACETS: exported Durable Object classes hosted as facets of a context through
// `ctx.exports` (first-party-facets.ts FIRST_PARTY_FACET_CLASSES) — ordinary bundled
// worker code with the worker's real env, never a loaded source.
export { AccountDurableObject } from "./account/durable-object.ts";
export { ControlPlaneDurableObject } from "./control-plane/durable-object.ts";
export { OrganizationDurableObject } from "./organization/durable-object.ts";
export { ProjectDurableObject } from "./project/durable-object.ts";
export { RepoDurableObject } from "./repo/durable-object.ts";
export { SecretDurableObject } from "./secret/durable-object.ts";
export { WorkspaceDurableObject } from "./workspace/durable-object.ts";
export { ItxEntrypoint } from "./iterate-context.ts";

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // THE HOP COUNT — what the app forwards: a request carrying the count it was handed re-enters
    // here with it, each pass adds one, more than four is a loop; a fresh Request carries none and
    // starts at zero. The edge writes digits; anything else (an app spelling "NaN" to defeat the
    // budget — `NaN > 4` is never true) is over budget by definition.
    const hopsHeader = request.headers.get(PROJECT_HOST_HOPS_HEADER) ?? "0";
    const hops = /^\d{1,3}$/.test(hopsHeader) ? Number(hopsHeader) + 1 : Infinity;
    if (hops > 4)
      return new Response(
        `the request re-entered itself ${Number.isFinite(hops) ? hops : `"${hopsHeader}"`} times (an app fetching its own host)\n`,
        { status: 508 },
      );

    const appConfig = appConfigOf(env);
    const { deployId } = appConfig;
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
    const controlPlane = new ControlPlane(env.CONTROL_PLANE);
    const routing = appConfig.urls.ingressRouting;
    // PROJECT-HOST INGRESS: a request on a project host IS the app it names — or, with no app label,
    // the project's config worker — the Request riding into the context DO's `fetch` with its URL,
    // the app's own cookies and a WebSocket upgrade intact. The browser adapter's `/api` and
    // `/.auth/*` are the app's own on a host of its own (subdomains) and the issuer's under paths,
    // where the app shares the platform's origin.
    const projectHost = projectHostOf(appConfig, url, platformOrigin);
    if (projectHost) {
      // ADMISSION, before any PROJECT Durable Object is dialled: a context is created on first
      // touch, so a hostname whose project the control plane does not know must never reach one —
      // else any label under the wildcard would mint durable storage from the public internet. One
      // catalog read (memoized per isolate: a slug's project never changes) — the row resolves the
      // host's label (a slug, an id would do too) to the project's id; an unknown label is 421.
      const project = await controlPlane.getProject(projectHost.project);
      if (!project)
        return new Response(
          `421: no project ${JSON.stringify(projectHost.project)} is served here\n`,
          { status: 421 },
        );
      const projectId = project.id;
      // THE FILES HOST (context/file-urls.ts): `files--<project>` serves a signed file URL straight
      // from the bucket, before any session or DO — the token in the URL is the authorization.
      if (projectHost.app === FILES_APP_LABEL) {
        const file = await serveProjectFileRequest({
          bucket: env.FILES,
          secret: await sessionSigningSecretOf(appConfig),
          project: projectId,
          keyPrefix: `${resourceScope(projectId, "/").id}/`,
          request: withoutBasePath(request, projectHost.basePath),
        });
        // Under paths a stored HTML or SVG file is a document on the platform's own origin: it runs
        // sandboxed exactly as an app's answer does (an opaque origin, no cookie to spend).
        return routing?.type === "paths" ? sandboxed(file) : file;
      }
      // The browser adapter's endpoints (`/api`, `/.auth/*`) are an app's OWN under subdomains — its
      // origin. Under paths the app shares the platform's origin, whose `/api` and `/.auth/*` are
      // the issuer's: an app there has no cookie sign-in of its own (it authenticates in-band).
      if (routing?.type !== "paths") {
        const browserResponse = await browserClient(request, env, ctx);
        if (browserResponse) return browserResponse;
      }
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const authorization = bearer
        ? await authorizationForToken(env, ctx, bearer, addresses)
        : await browserAuthorization(env, request, ctx);
      if (bearer && !authorization)
        return new Response("Invalid or revoked bearer", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        });
      if (authorization && !(await controlPlane.reachesProject(authorization.reach, projectId)))
        return new Response("This session cannot access this project", { status: 403 });
      if (authorization?.grant) ctx.waitUntil(recordGrantUse(env, authorization.grant));
      // the visitor's own cookies reach the app; the platform's cookie and bearer never do
      const answer = await env.ITERATE_CONTEXT.getByName(
        DurableObjectNameCodec.stringify({ projectId, path: "/" }),
      ).fetch(
        projectHostRequestTo(request, {
          app: projectHost.app,
          hops,
          appCookies: appCookies(request.headers.get("cookie")) || null,
          identity: {
            principal: authorization?.principal ?? null,
            grant: authorization?.grant?.grantId,
            platformBearer: Boolean(bearer && authorization),
          },
          basePath: projectHost.basePath,
          platformOrigin,
        }),
      );
      // Under paths the app answered on the platform's own origin: its document runs sandboxed.
      return routing?.type === "paths" ? sandboxed(answer) : answer;
    }
    // Under a subdomains wildcard there are project hosts and nothing else: a hostname there that
    // fails the grammar (`site--prj_1`, `a.b.c`, `--x`) names no project host and must not fall
    // through to the control plane — a working platform origin on a name the platform never chose. 421.
    if (
      routing?.type === "subdomains" &&
      url.hostname.toLowerCase().replace(/\.$/, "").endsWith(`.${routing.hostname}`)
    )
      return new Response(
        `421: ${url.hostname} is not a project host under ${routing.hostname}\n`,
        { status: 421 },
      );

    // A platform request, then — on the platform origin (a deployment with `urls.os` set answers there
    // and on its project hosts, nowhere else).
    if (url.origin !== platformOrigin)
      return new Response("Unknown platform origin", { status: 421 });

    // `<deployId> <platformOrigin>`: Cloudflare's version id of this deploy — the stamp a smoke
    // waits for (`wrangler deploy` prints it) — and the origin this deployment answers on.
    if (url.pathname === "/version") return new Response(`${deployId} ${platformOrigin}\n`);
    // A preview's one-click sign-in (test-link.ts): a 404 wherever `login.testLink` is off — prd,
    // and every deployment on its own domain, which app-config.ts refuses it on.
    if (url.pathname === TEST_LINK_PATH && request.method === "GET")
      return testLinkResponse(request, env);
    // posthog-js's `api_host` on the issuer's own pages (routes/__root.tsx): PostHog EU through
    // this origin.
    if (url.pathname.startsWith("/e/")) return proxyPosthogRequest({ request, proxyPrefix: "/e" });

    // A project secret's OAuth callback (secret-oauth.ts): the provider sends the human back here
    // with the code. Its own reserved path, `/.secrets/`, beside `/version`.
    if (url.pathname === SECRET_OAUTH_CALLBACK_PATH)
      return secretOAuthCallback(request, env, ctx, addresses);
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
    // on `/api/<anything>` would pass the provider's gate and be routed to the MCP handler (api.ts).
    if (url.pathname.startsWith("/api")) return new Response("Not found", { status: 404 });

    // Everything else on the platform origin is the OAuth provider (api.ts, oauth.ts: the
    // authorize, token and registration endpoints, discovery) with the issuer's pages as its
    // catch-all (issuer-pages.ts) — every one an open path, or a 404.
    return oauthResponse(request, env, ctx, issuerHandler);
  },
};
export const broken: = ;
