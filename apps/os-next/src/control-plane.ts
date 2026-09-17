// The fixed issuer shell: the OAuth AS's bindings, the sign-in POST, and THE ISSUER'S TWO PAGES —
// /login and the /authorize consent. The pages are FILES — public/login.html and public/authorize.html,
// with the stylesheet and a script each beside them — served through the assets binding: no
// framework, no build. What a page shows it asks its JSON sibling for (/login.json, /authorize.json)
// and what it decides it posts back (POST /authorize); the session that answers is built here the
// way /api builds one. Everything else a person does with Iterate is an app's — an ordinary OAuth
// client of this issuer (the dash, on its own origin, first among them).
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import {
  codedError,
  errorCode,
  isSameOriginBrowserRequest,
  sameOriginPath,
} from "iterate/next/lib";
import { verifyAdminSecret } from "iterate/next/principal";
import type { BrowserSession } from "iterate/next/app-session";
import { startIssuerSession } from "./issuer-session.ts";
import { directory } from "./directory.ts";
import { appConfigOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import { Consent } from "./consent.ts";
import { Grants } from "./grants.ts";
import { IterateRpcTarget, SessionTeardown, type SessionRpcTarget } from "./session.ts";
import type { Env as DurableObjectEnv } from "./iterate-context-durable-object.ts";

/** Platform bindings for the issuer, public APIs and project ingress. */
export interface Env extends DurableObjectEnv {
  BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The directory: users, orgs, org_members, projects (control-plane.sql). Strongly consistent (D1). */
  DB: D1Database;
  /** Injected by the provider — the OAuth helper surface (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
  /** The issuer's pages and their files — public/ (wrangler.jsonc `assets`, `run_worker_first`: this
   *  worker sees every request first and asks the binding only for `issuerPagePaths`). */
  ASSETS: Fetcher;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

/** Email-only sign-in for explicitly enabled test deployments and localhost,
 * or the administrator fixture. Other deployments require verified Google identity. */
export async function signIn(
  env: Env,
  request: Request,
  input: { email: string; next: string },
): Promise<{ setCookie: string; location: string }> {
  const config = appConfigOf(env);
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (
    !config.testEmailLogin &&
    !(bearer && (await verifyAdminSecret(bearer, config.adminApiSecret.exposeSecret())))
  )
    throw codedError("UNAUTHENTICATED", "Sign in with Google.");
  const email = input.email.trim();
  if (!email) throw codedError("INVALID_INPUT", "Enter an email.");
  const user = await directory(env.DB).upsertUser(email);
  return startIssuerSession(env, user, input.next);
}

// ── the issuer's pages ──

/** The paths the issuer's pages own on the platform origin, open to a browser that is not signed in
 *  (worker.ts lets them through without a bearer): the two pages, their JSON, their files. */
export const issuerPagePaths = [
  "/login",
  "/login.json",
  "/login.js",
  "/authorize",
  "/authorize.json",
  "/authorize.js",
  "/issuer.css",
];

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** /login.json — what the sign-in page (public/login.js) shows: who is signed in (continue, or switch
 *  account), or the sign-ins this deployment offers — the email form for test deployments, Google —
 *  and where to continue to. Signing in is the form's POST to `loginFormPost` or the Google link
 *  (identity.ts); "switch account" ends the browser's session and returns here. Without a `next`
 *  the page is its own destination (the issuer has no home page): signed in, it says so. */
async function loginState(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = appConfigOf(env);
  const next = sameOriginPath(
    new URL(request.url).searchParams.get("next") || "/login",
    config.platformOrigin,
  );
  const session = await browserAuthorization(env, request, ctx);
  const google = Boolean(config.googleClientId && config.googleClientSecret.exposeSecret());
  return json({
    next,
    signedInAs: session ? session.principal.email || session.principal.actor : null,
    switchAccount: `/.auth/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`,
    emailSignIn: config.testEmailLogin,
    google: google ? `/.auth/identity?next=${encodeURIComponent(next)}` : null,
  });
}

/** The sign-in form's POST — a plain form, no script needed to sign in. */
async function loginFormPost(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/login") return null;
  const form = await request.formData();
  try {
    const { setCookie, location } = await signIn(env, request, {
      email: String(form.get("email") ?? ""),
      next: String(form.get("next") || "/login"),
    });
    return new Response(null, { status: 302, headers: { location, "set-cookie": setCookie } });
  } catch (error) {
    const code = errorCode(error);
    if (!["UNAUTHENTICATED", "INVALID_INPUT"].includes(code || "")) throw error;
    return new Response(error instanceof Error ? error.message : String(error), {
      status: code === "UNAUTHENTICATED" ? 401 : 400,
    });
  }
}

/** The signed-in browser's session, built the way rpc.ts builds one for `/api` — the same
 *  IterateRpcTarget, the same `authenticate({ type: "from-server-cookie" })` — for `authorizeHandler`
 *  to call in-process. Null when the browser holds no session. */
async function browserSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<{ session: SessionRpcTarget; teardown: SessionTeardown } | null> {
  const authorization = await browserAuthorization(env, request, ctx);
  if (!authorization) return null;
  const teardown = new SessionTeardown();
  const root = new IterateRpcTarget(
    {
      contextNamespace: env.ITERATE_CONTEXT,
      waitUntil: (promise) => ctx.waitUntil(promise),
      directory: directory(env.DB),
      appConfig: appConfigOf(env),
    },
    teardown,
    {
      principal: authorization.principal,
      reach: authorization.reach,
      grants: new Grants(env, ctx, authorization),
      scopes: authorization.grant?.scope,
      ...(authorization.grant?.kind === "issuer" && {
        consent: new Consent(env, authorization.grant),
      }),
    },
  );
  return { session: await root.authenticate({ type: "from-server-cookie" }), teardown };
}

/** What the consent page posts (public/authorize.js): approve with the projects ticked (`["*"]` =
 *  every current and future project) and the scopes left ticked, or create an organization or a
 *  project first. */
const ConsentAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    projects: z.array(z.string()),
    scopes: z.array(z.string()),
  }),
  z.object({ action: z.literal("create-org"), name: z.string() }),
  z.object({ action: z.literal("create-project"), org: z.string(), project: z.string() }),
]);

/** GET /authorize is the consent page (public/authorize.html) for a signed-in browser — no session ⇒
 *  sign in first, and come back to this very URL. GET /authorize.json describes the request for the
 *  page (`consent.describe`: the client, the person's projects and organizations, the scopes asked
 *  for). POST /authorize is one of the page's three actions: approve, which answers the client's
 *  redirect, or create an organization or a project, which answer the refreshed description. */
async function authorizeHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const query = url.search;
  const page = url.pathname === "/authorize" && request.method !== "POST";
  const browser = await browserSession(request, env, ctx);
  if (!browser) {
    const login = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;
    return page
      ? new Response(null, {
          status: 303,
          headers: { Location: login, "Cache-Control": "no-store" },
        })
      : json({ error: "This session has ended. Sign in again.", login }, 401);
  }
  const { session, teardown } = browser;
  try {
    if (page) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ view: await session.consent.describe(query) });
    const posted = ConsentAction.safeParse(await request.json().catch(() => null));
    if (!posted.success) return json({ error: "Choose an action." }, 400);
    const action = posted.data;
    let orgId: string | undefined;
    try {
      if (action.action === "approve") {
        const result = await session.consent.approve({
          query,
          projects: action.projects,
          scopes: action.scopes,
        });
        return "error" in result
          ? json({ error: result.error }, 400)
          : json({ redirectTo: result.redirectTo });
      }
      if (action.action === "create-org") orgId = (await session.createOrg(action.name)).id;
      else {
        // the new project's context is the session's to hold; the teardown below lets it go
        await session.projects.create({ project: action.project, orgId: action.org });
        orgId = action.org;
      }
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    return json({ view: await session.consent.describe(query), orgId });
  } finally {
    teardown.disposeAll();
  }
}

/** The issuer's pages: the sign-in POST, the two pages and their JSON, their files — with same-origin
 *  POST checks. Anything else on the platform origin is not a page — the dash lives on its own origin. */
export const issuerHandler: Handler = {
  async fetch(request, env, ctx) {
    if (request.method === "POST" && !isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot act on this session\n", {
        status: 403,
      });
    const signedIn = await loginFormPost(request, env);
    if (signedIn) return signedIn;
    const { pathname } = new URL(request.url);
    if (!["GET", "HEAD", "POST"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    if (pathname === "/authorize" || (pathname === "/authorize.json" && request.method !== "POST"))
      return authorizeHandler(request, env, ctx);
    if (request.method === "POST") return new Response("Not found", { status: 404 });
    if (pathname === "/login.json") return loginState(request, env, ctx);
    // the pages and their files, as they are in public/
    if (issuerPagePaths.includes(pathname)) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
