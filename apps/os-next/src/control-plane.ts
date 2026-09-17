// The fixed issuer shell: the OAuth AS's bindings, the sign-in door, and THE ISSUER'S TWO PAGES —
// /login rendered whole, /authorize an empty shell that public/authorize.js fills over the public
// Cap’n Web session (no build: React, htm and capnweb arrive through the shell's import map).
// Everything else a person does with Iterate is an app's — an ordinary OAuth client of this issuer.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
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
  /** The static assets (wrangler.jsonc `assets`: public/ — authorize.js and issuer.css, served as
   *  written). The PLATFORM HOST's alone: every request runs worker-first and src/worker.ts asks this
   *  binding after the project hosts, so no asset answers on one. Absent in the workers lane
   *  (wrangler.test.jsonc binds none). */
  ASSETS?: Fetcher;
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

/** The browser modules the consent page imports, pinned: React and htm (the page's `html` tagged
 *  templates), the capnweb fork for the `/api` WebSocket. `react-dom` leaves `react` external so the
 *  map resolves both to the one instance. An import map is the whole client toolchain. */
const IMPORT_MAP = JSON.stringify({
  imports: {
    react: "https://esm.sh/react@19.2.7",
    "react-dom/client": "https://esm.sh/react-dom@19.2.7/client?external=react",
    htm: "https://esm.sh/htm@3.1.1",
    "@iterate-com/capnweb": "https://esm.sh/@iterate-com/capnweb@0.12.2",
  },
});

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** One issuer document: the head both pages share (the one stylesheet, public/issuer.css), `body` as
 *  given, and — for the consent page — the import map and the module that mounts it, admitted by a
 *  per-response nonce so the page's CSP names exactly its two script sources: this origin and the
 *  pinned esm.sh modules. */
function issuerDocument(body: string, page?: { module: string }): Response {
  const nonce = crypto.randomUUID();
  const scripts = page
    ? `<script type="importmap" nonce="${nonce}">${IMPORT_MAP}</script><script type="module" nonce="${nonce}" src="${page.module}"></script>`
    : "";
  return new Response(
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Iterate</title><link rel="stylesheet" href="/issuer.css"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%278%27 fill=%27%23111%27/%3E%3Cpath d=%27M16 8v16%27 stroke=%27white%27 stroke-width=%274%27/%3E%3C/svg%3E">${scripts}</head><body>${body}</body></html>\n`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "Content-Security-Policy": [
          "default-src 'self'",
          `script-src 'self' https://esm.sh 'nonce-${nonce}'`,
          "connect-src 'self' https://esm.sh",
          "style-src 'self'",
          "img-src 'self' data:",
          "frame-ancestors 'none'",
        ].join("; "),
        "X-Frame-Options": "DENY",
      },
    },
  );
}

/** /login, rendered whole — it needs the request (who is signed in, which sign-ins this deployment
 *  offers, where to continue) and nothing live. The email form posts back to `signInDoor`; Google
 *  is the identity door (identity.ts); "switch account" ends the browser's session and returns here. */
async function loginPage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = appConfigOf(env);
  const next = sameOriginPath(
    new URL(request.url).searchParams.get("next") || "/",
    config.platformOrigin,
  );
  const session = await browserAuthorization(env, request, ctx);
  const google = Boolean(config.googleClientId && config.googleClientSecret.exposeSecret());
  const switchAccount = `/.auth/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`;
  const who = session && escapeHtml(session.principal.email || session.principal.actor);
  const body = session
    ? `<p>Signed in as <strong>${who}</strong>.</p>
<p><a href="${escapeHtml(next)}">Continue as ${who}</a></p>
<form method="post" action="${escapeHtml(switchAccount)}"><button type="submit">Switch account</button></form>`
    : [
        config.testEmailLogin &&
          `<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Email <input type="email" name="email" placeholder="you@example.com" required></label><button type="submit">Continue</button><p class="muted">Test sign-in: use any email. No verification.</p></form>`,
        google &&
          `<p><a href="/.auth/identity?next=${encodeURIComponent(next)}">Continue with Google</a></p>`,
        !config.testEmailLogin &&
          !google &&
          `<p>Sign-in is not configured for this deployment.</p>`,
      ]
        .filter(Boolean)
        .join("\n");
  return issuerDocument(`<main><h1>Sign in</h1>\n${body}\n</main>`);
}

/** The sign-in form's POST — a plain form, no script needed to sign in. */
async function signInDoor(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/login") {
    const form = await request.formData();
    try {
      const { setCookie, location } = await signIn(env, request, {
        email: String(form.get("email") ?? ""),
        next: String(form.get("next") ?? "/"),
      });
      return new Response(null, {
        status: 302,
        headers: { location, "set-cookie": setCookie },
      });
    } catch (error) {
      const code = errorCode(error);
      if (!["UNAUTHENTICATED", "INVALID_INPUT"].includes(code || "")) throw error;
      return new Response(error instanceof Error ? error.message : String(error), {
        status: code === "UNAUTHENTICATED" ? 401 : 400,
      });
    }
  }
  return null;
}

/** The issuer's pages: the sign-in door and page, the consent shell, with same-origin POST checks.
 *  Anything else on the platform origin is not a page — the OS lives on its own origin. */
export const issuerHandler: Handler = {
  async fetch(request, env, ctx) {
    if (request.method === "POST" && !isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot act on this session\n", {
        status: 403,
      });
    const door = await signInDoor(request, env);
    if (door) return door;
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 });
    const { pathname } = new URL(request.url);
    if (pathname === "/login") return loginPage(request, env, ctx);
    if (pathname === "/authorize")
      return issuerDocument(`<div id="root"></div>`, { module: "/authorize.js" });
    return new Response("Not found", { status: 404 });
  },
};
