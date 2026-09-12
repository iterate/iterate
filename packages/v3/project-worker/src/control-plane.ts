// The fixed issuer shell. Authenticated UI uses the public Cap’n Web session.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { startIssuerSession } from "./issuer-session.ts";
import { codedError, errorCode, isSameOriginBrowserRequest } from "./lib.ts";
import { directory } from "./directory.ts";
import { appConfigOf } from "./app-config.ts";
import { verifyAdminSecret } from "./principal.ts";
import type { BrowserSession } from "./browser-session.ts";
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
  /** The static assets (wrangler.jsonc `assets`: dist/client — the console's client bundle, public/
   *  verbatim with the hosted /demo page). The PLATFORM HOST's alone: every request runs worker-first
   *  and src/worker.ts asks this binding after the project hosts, so no asset answers on one. Absent
   *  in the workers lane (wrangler.test.jsonc binds none). */
  ASSETS?: Fetcher;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

/** Request-local context for issuer login and consent server functions. */
export type ConsoleRequestContext = { env: Env; ctx: ExecutionContext; request: Request };

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

// ── the console ──

/** The console's Start server entry — the routes (src/routes/**) SSR'd, their server functions
 *  dispatched — loaded on the console's first request and kept. A DYNAMIC import, on purpose: the
 *  entry's graph resolves only inside the Vite build (vite.config.ts — Start's virtual modules), and
 *  this module sits in the graph of the DO and the session (worker.ts `appConfigOf`, `directory`),
 *  which the lanes import from src as plain modules; a static import here would drag Start into every
 *  one of them. The built worker (dist/server) carries the entry as a chunk beside index.js. */
let startServerEntry: Promise<ServerEntry> | undefined;
const loadStartServerEntry = (): Promise<ServerEntry> =>
  (startServerEntry ??= import("@tanstack/react-start/server-entry").then(
    (module) => module.default,
  ));

/** Issuer forms work before hydration. App actions use Cap’n Web. */
async function consoleDoor(request: Request, env: Env): Promise<Response | null> {
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
      if (!["UNAUTHENTICATED", "INVALID_INPUT"].includes(code ?? "")) throw error;
      return new Response(error instanceof Error ? error.message : String(error), {
        status: code === "UNAUTHENTICATED" ? 401 : 400,
      });
    }
  }
  return null;
}

/** TanStack issuer routes and the console shell, with same-origin POST checks. */
export const consoleHandler: Handler = {
  async fetch(request, env, ctx) {
    if (request.method === "POST" && !isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot act on this session\n", {
        status: 403,
      });
    const door = await consoleDoor(request, env);
    if (door) return door;
    const context: ConsoleRequestContext = { env, ctx, request };
    const entry = await loadStartServerEntry();
    // Start types `context` off its `Register` (see ConsoleRequestContext) — the entry takes ours.
    const answer = await entry.fetch(request, { context } as Parameters<typeof entry.fetch>[1]);
    if (!answer.headers.get("content-type")?.startsWith("text/html")) return answer;
    const page = new Response(answer.body, answer);
    page.headers.set("cache-control", "no-store");
    page.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    page.headers.set("X-Frame-Options", "DENY");
    return page;
  },
};
