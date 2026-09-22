// The fixed issuer shell: the OAuth AS's bindings, the sign-in POST, and THE ISSUER'S TWO PAGES —
// /login and the /oauth2/auth consent. The pages are FILES — public/login.html and public/oauth2/auth.html,
// with the stylesheet and a script each beside them — served through the assets binding: no
// framework, no build. The sign-in page asks /login.json what to show and signs in with plain form
// posts to /login — the password, or an email then its mailed code (login-code.ts) — or a provider
// link (identity.ts); the consent page is a capnweb client of /api like any app (public/capnweb.js
// beside it is the fork's browser bundle, copied by scripts/build.ts; the cookie rides the
// handshake) — this worker only gates it. Everything else a person does with Iterate is an app's —
// an ordinary OAuth client of this issuer (the dash, on its own origin, first among them); `/` says
// so and points at the dash.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { errorCode, isSameOriginBrowserRequest, sameOriginPath } from "iterate/next/lib";
import type { BrowserSession } from "iterate/next/app-session";
import { startIssuerSession } from "./issuer-session.ts";
import {
  clearLoginCookie,
  emailSignInOffered,
  finishLoginCode,
  loginCodePending,
  passwordSignInOffered,
  signInWithPassword,
  startLoginCode,
} from "./login-code.ts";
import { appConfigOf, platformOriginOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import type { User } from "./directory.ts";
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

// ── the issuer's pages ──

/** The paths the issuer's pages own on the platform origin, open to a browser that is not signed in
 *  (worker.ts lets them through without a bearer): the two pages, the sign-in page's JSON, their
 *  files (the consent page's capnweb bundle among them) — and `/`, the landing page (`landingPage`) telling a browser this origin is deliberately headless
 *  and where the dash is. */
export const issuerPagePaths = [
  "/",
  "/login",
  "/login.json",
  "/login.js",
  "/oauth2/auth",
  "/authorize.js",
  "/capnweb.js",
  "/issuer.css",
  "/iterate-logo.svg",
  "/google-logo.svg",
  "/cloudflare-logo.svg",
  // the prompt an agent follows to deploy and connect a platform of the person's own
  "/setup-prompt.md",
];

/** /login.json — what the sign-in page (public/login.js) shows: who is signed in (continue, or switch
 *  account); or that a code is on its way and to whom (the code step); or the sign-ins this
 *  deployment offers — the password, email (a code), Google or Cloudflare — and where to continue to; and what
 *  went wrong with the last post (`?error=`, the message `loginFormPost` bounced back with). Signing
 *  in is the form's POSTs to `loginFormPost` or a provider link (identity.ts); "switch account" ends
 *  the browser's session and returns here. Without a `next` the page is its own destination (the
 *  issuer has no home page): signed in, it says so. */
async function loginState(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = appConfigOf(env);
  const url = new URL(request.url);
  const next = sameOriginPath(
    url.searchParams.get("next") || "/login",
    platformOriginOf(config, request),
  );
  const session = await browserAuthorization(env, request, ctx);
  return Response.json(
    {
      next,
      signedInAs: session ? session.principal.email || session.principal.actor : null,
      switchAccount: `/.auth/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`,
      codeSentTo: session ? null : await loginCodePending(env, request),
      error: url.searchParams.get("error"),
      // the email the refused post carried, so the page keeps what was typed
      email: url.searchParams.get("email") || "",
      // the mechanisms this deployment offers (app-config.ts `login`): the page renders each
      password: passwordSignInOffered(env),
      passwordSelected: url.searchParams.get("method") === "password",
      emailSignIn: emailSignInOffered(env),
      google: config.login.google ? `/.auth/identity?next=${encodeURIComponent(next)}` : null,
      cloudflare: config.login.cloudflare
        ? `/.auth/identity/cloudflare?next=${encodeURIComponent(next)}`
        : null,
      // where a signed-in person with nowhere else to go is sent (the landing page's pointer)
      dash: config.urls.dash || null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** The sign-in page's POSTs — plain forms, no script in the loop. An `email` with a `password`
 *  signs in at once; an `email` alone starts the code sign-in; a `code` finishes it; `restart`
 *  drops a pending code for another email. What goes wrong comes back to the page as `?error=`
 *  (303), so the person reads it where they typed. */
async function loginFormPost(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/login") return null;
  const form = await request.formData();
  const next = String(form.get("next") || "/login");
  const email = String(form.get("email") ?? "").trim();
  /** Back to the page with what went wrong — and the email as typed, so it is still there. */
  const back = (error?: string, ...cookies: string[]) => {
    const query = new URLSearchParams({ next });
    if (error) query.set("error", error);
    if (error && email) query.set("email", email);
    if (error && form.has("password")) query.set("method", "password");
    const headers = new Headers({ location: `/login?${query}` });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  };
  /** The person is signed in: the issuer session's cookie, any pending code dropped, onward. */
  const signedIn = async (user: User) => {
    const { setCookie, location } = await startIssuerSession(env, request, user, next);
    const headers = new Headers({ location });
    headers.append("set-cookie", setCookie);
    headers.append("set-cookie", clearLoginCookie);
    return new Response(null, { status: 302, headers });
  };
  try {
    if (form.has("restart")) return back(undefined, clearLoginCookie);
    if (form.has("code")) {
      const finished = await finishLoginCode(env, request, String(form.get("code") ?? ""));
      if ("error" in finished)
        return finished.restart ? back(finished.error, clearLoginCookie) : back(finished.error);
      return signedIn(finished.user);
    }
    const client = request.headers.get("cf-connecting-ip");
    if (form.has("password")) {
      const attempt = await signInWithPassword(env, email, String(form.get("password")), client);
      if ("error" in attempt) return back(attempt.error);
      return signedIn(attempt.user);
    }
    const started = await startLoginCode(env, email, client);
    return back(undefined, started.setCookie);
  } catch (error) {
    const code = errorCode(error);
    if (code === "INVALID_INPUT")
      return back(error instanceof Error ? error.message : "Try again.");
    if (code !== "UNAUTHENTICATED") throw error;
    return new Response(error instanceof Error ? error.message : String(error), { status: 401 });
  }
}

/** GET /oauth2/auth is the consent page (public/oauth2/auth.html) for a signed-in browser — no session ⇒
 *  sign in first, and come back to this very URL. The page itself is a capnweb client of `/api`
 *  like any app, the cookie riding the handshake: `consent.describe` for what to show, `createOrg`
 *  and `projects.create` for a project made on the spot, `consent.approve` for the client's
 *  redirect — this worker only gates the page. */
async function authorizePage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (await browserAuthorization(env, request, ctx)) return env.ASSETS.fetch(request);
  const login = `/login?next=${encodeURIComponent(`/oauth2/auth${new URL(request.url).search}`)}`;
  return new Response(null, {
    status: 303,
    headers: { Location: login, "Cache-Control": "no-store" },
  });
}

/** `/` — the one landing page: this origin is headless (the API, the OAuth issuer, the MCP server;
 *  sign-in and consent are its only pages) and the dash is where a person's projects, organizations
 *  and sessions are. Rendered from the configuration, so the hostnames are the deployment's own —
 *  a preview's, a self-hoster's — never a file's. */
function landingPage(request: Request, env: Env): Response {
  const config = appConfigOf(env);
  const issuer = platformOriginOf(config, request);
  const escape = (text: string) =>
    text.replace(
      /[&<>"]/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
    );
  const dash = config.urls.dash
    ? `<p>
        Your projects, organizations and sessions are in the dash:
        <a class="button primary" href="${escape(`${config.urls.dash}/.auth/connect?${new URLSearchParams({ issuer })}`)}">${escape(new URL(config.urls.dash).host)}</a>
      </p>`
    : "";
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iterate platform</title>
    <link rel="stylesheet" href="/issuer.css" />
    <link rel="icon" href="/iterate-logo.svg" type="image/svg+xml" />
  </head>
  <body>
    <main class="issuer-card">
      <img class="issuer-mark" src="/iterate-logo.svg" alt="" width="56" height="56" />
      <h1>iterate platform</h1>
      <p>
        <strong>${escape(new URL(issuer).host)}</strong> is deliberately headless: the
        API (<code>/api</code>), the OAuth issuer and the MCP server. Its only pages are
        <a href="/login">sign-in</a> and consent.
      </p>
      ${dash}
      <p class="muted">
        Setting this up with an agent? Point it at <a href="/setup-prompt.md">/setup-prompt.md</a>.
      </p>
    </main>
  </body>
</html>
`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // what public/_headers gives the pages beside it
        "content-security-policy":
          "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
      },
    },
  );
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
    if (pathname === "/oauth2/auth" && request.method !== "POST")
      return authorizePage(request, env, ctx);
    if (request.method === "POST") return new Response("Not found", { status: 404 });
    if (pathname === "/") return landingPage(request, env);
    if (pathname === "/login.json") return loginState(request, env, ctx);
    // the pages and their files, as they are in public/
    if (issuerPagePaths.includes(pathname)) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
