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
import {
  clearLoginCookie,
  emailSignInOffered,
  finishLoginCode,
  loginCodePending,
  startLoginCode,
} from "./login-code.ts";
import { directory } from "./directory.ts";
import { appConfigOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import { Consent } from "./consent.ts";
import { Grants } from "./grants.ts";
import { oauthHelpers } from "./oauth.ts";
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
  /** Email Sending (wrangler `send_email`) — how the sign-in code reaches the person (login-code.ts).
   *  Simulated by wrangler dev and the test configs; absent where a deployment has no mailbox. */
  EMAIL?: SendEmail;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

/** The administrator's identity fixture: with the admin bearer, any email is signed in at once —
 *  the deployed specs' way in. A person signs in with a code (login-code.ts) or with Google. */
export async function signIn(
  env: Env,
  request: Request,
  input: { email: string; next: string },
): Promise<{ setCookie: string; location: string }> {
  const config = appConfigOf(env);
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!(bearer && (await verifyAdminSecret(bearer, config.adminApiSecret.exposeSecret()))))
    throw codedError("UNAUTHENTICATED", "Sign in with Google.");
  const email = input.email.trim();
  if (!email) throw codedError("INVALID_INPUT", "Enter an email.");
  const user = await directory(env.DB).upsertUser(email);
  return startIssuerSession(env, user, input.next);
}

// ── the issuer's pages ──

/** The paths the issuer's pages own on the platform origin, open to a browser that is not signed in
 *  (worker.ts lets them through without a bearer): the two pages, their JSON, their files, the OAuth
 *  client's picture (`clientIcon`) — and `/`, one static page (public/index.html) telling a browser
 *  this origin is deliberately headless and where the dash is. */
export const issuerPagePaths = [
  "/",
  "/login",
  "/login.json",
  "/login.js",
  "/authorize",
  "/authorize.json",
  "/authorize.js",
  "/issuer.css",
  "/iterate-logo.svg",
  "/client-icon",
];

/** The tools people connect, whose marks we ship (public/brands/, from @lobehub/icons-static-svg,
 *  MIT; chrome.svg from simple-icons, CC0): crisper than a favicon, and there for a client whose
 *  registration names no picture at all (Codex registers dynamically, with a name). Matched on the
 *  client's name, home and id. Our own apps get no mark here: the hero already shows the platform's,
 *  so the client tile shows their initials (or their favicon, once they have one) — except the
 *  Chrome extension (apps/browser-extension), whose tile is the person's browser: iterate ⇄ Chrome. */
const brandMarks: [RegExp, string][] = [
  [/claude|anthropic/i, "/brands/claude.svg"],
  [/codex|openai|chatgpt/i, "/brands/openai.svg"],
  [/cursor/i, "/brands/cursor.svg"],
  [/chrome/i, "/brands/chrome.svg"],
];

/** GET /client-icon?client_id=… — the client's picture for the consent page's hero: its `logo_uri`,
 *  else the mark we ship for it, else the favicon of its `client_uri` (else of the client id's
 *  origin — a CIMD client's id is a URL). Fetched here rather than by the browser: a client's origin
 *  may forbid embedding across origins (claude.ai's favicon answers with
 *  `Cross-Origin-Resource-Policy: same-origin`), and the pages' CSP stays `img-src 'self'`. Only a
 *  client the provider knows, and only a RASTER image — a client's SVG could carry script, and this
 *  answer is on the issuer's origin — served with no script allowed and sandboxed besides; anything
 *  else is a 404, on which the page keeps the client's initials. */
const rasterImageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
];
async function clientIcon(request: Request, env: Env): Promise<Response> {
  const clientId = new URL(request.url).searchParams.get("client_id") || "";
  const client = await oauthHelpers(env)
    .lookupClient(clientId)
    .catch(() => null);
  if (!client) return new Response("Not found", { status: 404 });
  const about = [client.clientName, client.clientUri, clientId].join(" ");
  const mark = brandMarks.find(([pattern]) => pattern.test(about))?.[1];
  if (!client.logoUri && mark) return env.ASSETS.fetch(new URL(mark, request.url));
  const home = client.clientUri || clientId;
  const source = client.logoUri || (URL.canParse(home) ? new URL("/favicon.ico", home).href : null);
  if (!source) return new Response("Not found", { status: 404 });
  const upstream = await fetch(source, {
    headers: { accept: "image/*" },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  const type = (upstream?.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
  if (!upstream?.ok || !rasterImageTypes.includes(type))
    return new Response("Not found", { status: 404 });
  return new Response(upstream.body, {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=86400",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** /login.json — what the sign-in page (public/login.js) shows: who is signed in (continue, or switch
 *  account); or that a code is on its way and to whom (the code step); or the sign-ins this
 *  deployment offers — email (a code), Google — and where to continue to; and what went wrong with
 *  the last post (`?error=`, the message `loginFormPost` bounced back with). Signing in is the
 *  form's POSTs to `loginFormPost` or the Google link (identity.ts); "switch account" ends the
 *  browser's session and returns here. Without a `next` the page is its own destination (the
 *  issuer has no home page): signed in, it says so. */
async function loginState(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = appConfigOf(env);
  const url = new URL(request.url);
  const next = sameOriginPath(url.searchParams.get("next") || "/login", config.platformOrigin);
  const session = await browserAuthorization(env, request, ctx);
  const google = Boolean(config.googleClientId && config.googleClientSecret.exposeSecret());
  return json({
    next,
    signedInAs: session ? session.principal.email || session.principal.actor : null,
    switchAccount: `/.auth/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`,
    codeSentTo: session ? null : await loginCodePending(env, request),
    error: url.searchParams.get("error"),
    emailSignIn: emailSignInOffered(env),
    google: google ? `/.auth/identity?next=${encodeURIComponent(next)}` : null,
  });
}

/** The sign-in page's POSTs — plain forms, no script in the loop. An `email` starts the code
 *  sign-in (or, with the administrator bearer, signs the fixture straight in); a `code` finishes
 *  it; `restart` drops a pending code for another email. What goes wrong comes back to the page as
 *  `?error=` (303), so the person reads it where they typed. */
async function loginFormPost(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/login") return null;
  const form = await request.formData();
  const next = String(form.get("next") || "/login");
  const back = (error?: string, ...cookies: string[]) => {
    const query = new URLSearchParams({ next });
    if (error) query.set("error", error);
    const headers = new Headers({ location: `/login?${query}` });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  };
  try {
    if (form.has("restart")) return back(undefined, clearLoginCookie);
    if (form.has("code")) {
      const finished = await finishLoginCode(env, request, String(form.get("code") ?? ""));
      if ("error" in finished)
        return finished.restart ? back(finished.error, clearLoginCookie) : back(finished.error);
      const { setCookie, location } = await startIssuerSession(env, finished.user, next);
      const headers = new Headers({ location });
      headers.append("set-cookie", setCookie);
      headers.append("set-cookie", clearLoginCookie);
      return new Response(null, { status: 302, headers });
    }
    const email = String(form.get("email") ?? "");
    if (request.headers.has("authorization")) {
      const { setCookie, location } = await signIn(env, request, { email, next });
      return new Response(null, { status: 302, headers: { location, "set-cookie": setCookie } });
    }
    const started = await startLoginCode(env, email, request.headers.get("cf-connecting-ip"));
    return back(undefined, started.setCookie);
  } catch (error) {
    const code = errorCode(error);
    if (code === "INVALID_INPUT")
      return back(error instanceof Error ? error.message : "Try again.");
    if (code !== "UNAUTHENTICATED") throw error;
    return new Response(error instanceof Error ? error.message : String(error), { status: 401 });
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
      grant: authorization.grant?.grantId,
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
 *  every current and future project) and the scopes left ticked, or create a project first — in one
 *  of the person's organizations (`org`), or in a new one named with it (`newOrg`): the one place
 *  the consent flow creates an organization. */
const ConsentAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    projects: z.array(z.string()),
    scopes: z.array(z.string()),
  }),
  z.object({
    action: z.literal("create-project"),
    project: z.string(),
    org: z.string().optional(),
    newOrg: z.string().optional(),
  }),
]);

/** GET /authorize is the consent page (public/authorize.html) for a signed-in browser — no session ⇒
 *  sign in first, and come back to this very URL. GET /authorize.json describes the request for the
 *  page (`consent.describe`: the client, the person's projects and organizations, the scopes asked
 *  for). POST /authorize is one of the page's two actions: approve, which answers the client's
 *  redirect, or create a project, which answers the refreshed description (and the organization the
 *  project went into, so a retry after a refused name lands in the same one). */
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
      // an empty project name is refused before a new organization is made for it
      if (!action.project.trim()) return json({ error: "Enter a project name." }, 400);
      // The page sends `newOrg` — typed or still empty — only with "New organization…" chosen, so
      // an empty one is refused rather than becoming the person's first organization; with neither
      // named, the project goes to their first (made from their email when they have none).
      orgId =
        action.org ||
        ("newOrg" in action ? (await session.createOrg(action.newOrg || "")).id : undefined);
      // the new project's context is the session's to hold; the teardown below lets it go
      await session.projects.create({ project: action.project, orgId });
    } catch (error) {
      // A refusal after a new organization was made (the slug taken, say) answers with the fresh
      // view and that organization's id: the page offers it next, rather than minting another
      // on the retry.
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
          orgId,
          view: await session.consent.describe(query),
        },
        400,
      );
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
    if (pathname === "/client-icon") return clientIcon(request, env);
    // the pages and their files, as they are in public/
    if (issuerPagePaths.includes(pathname)) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
