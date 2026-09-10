// The OAuth authorization server and TanStack console. Directory policy lives in
// directory.ts; MCP exposes that policy through the existing context capabilities.

import {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { isLocalOrigin } from "./identity.ts";
import { parseAuthorization, type GrantProps } from "./oauth.ts";
import { codedError, errorCode, isSameOriginBrowserRequest } from "./lib.ts";
import { directory, type Project } from "./directory.ts";
import { projectHostOf } from "./hosts.ts";
import { appConfigOf } from "./app-config.ts";
import { sameOriginPath } from "./lib.ts";
import {
  verifyAdminSecret,
  clearSessionCookie,
  setSessionCookie,
  verifySessionCookie,
  type SessionCookieClaims,
} from "./principal.ts";
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

/** The session the request's cookie establishes (principal.ts `verifySessionCookie`), or null. */
export function issuerSessionOf(env: Env, request: Request): Promise<SessionCookieClaims | null> {
  return verifySessionCookie(request.headers.get("cookie"), appConfigOf(env).sessionSecret);
}

async function requireIssuerSession(env: Env, request: Request) {
  const session = await issuerSessionOf(env, request);
  if (!session) throw codedError("UNAUTHENTICATED", "sign in first");
  return session;
}

/** Local login fixture, or explicit administrator impersonation for automated
 * acceptance tests. Deployed visitors prove identity through Google. */
export async function signIn(
  env: Env,
  request: Request,
  input: { email: string; next: string },
): Promise<{ setCookie: string; location: string }> {
  const config = appConfigOf(env);
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (
    !isLocalOrigin(config.platformOrigin) &&
    !(bearer && (await verifyAdminSecret(bearer, config.adminApiSecret)))
  )
    throw codedError("UNAUTHENTICATED", "Sign in with Google.");
  const email = input.email.trim();
  if (!email) throw codedError("INVALID_INPUT", "Enter an email.");
  const user = await directory(env.DB).upsertUser(email);
  const setCookie = await setSessionCookie(
    { sub: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) },
    appConfigOf(env).sessionSecret,
  );
  return { setCookie, location: sameOriginPath(input.next, new URL(request.url).origin) };
}

/** The `Set-Cookie` that ends the session. */
export const signOut = (): string => clearSessionCookie();

/** What the consent page shows, or where the browser goes instead. */
export type Consent =
  /** The consent: the client, the user, THE PROJECT SELECTION (their projects, offered all checked). */
  | {
      kind: "consent";
      query: string;
      clientName: string;
      email: string;
      projects: Project[];
      projectBound: boolean;
      scopes: string[];
    }
  /** The provider's refusal, sent back to the client — `error`, `error_description`, `state`, `iss`
   *  — as its README says, when the client and its redirect URI validated. */
  | { kind: "redirect"; location: string }
  /** The refusal when they did not: rendered here. */
  | { kind: "invalid"; description: string };

/** The /authorize URL the provider parses: the OAuth parameters ride `query` — the page's raw search
 *  string — on this origin. The provider reads them off the URL alone, so the page request and a
 *  client-side navigation's server function hand it the same thing. */
const authorizeRequest = (request: Request, query: string): Request =>
  new Request(
    `${new URL(request.url).origin}/authorize${query === "" || query.startsWith("?") ? query : `?${query}`}`,
  );

/** A platform-served project CIMD client can receive only that project's authority. */
async function projectsForClient(env: Env, clientId: string, userId: string) {
  const projects = await directory(env.DB).listProjects(userId);
  const url = URL.canParse(clientId) ? new URL(clientId) : null;
  const host =
    url?.pathname === "/.auth/client.json"
      ? projectHostOf(url.hostname, appConfigOf(env).projectHostnameBase)
      : null;
  if (!host) return { projects, projectBound: false };
  const project = await directory(env.DB).getProject(host.project);
  return { projects: projects.filter((p) => p.id === project?.id), projectBound: true };
}

/** Expected OAuth refusals retain the validated client redirect when one exists. */
function authorizationFailure(error: unknown): Extract<Consent, { kind: "redirect" | "invalid" }> {
  if (error instanceof CimdFetchError)
    return {
      kind: "invalid",
      description: "The client metadata could not be loaded or validated.",
    };
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) return { kind: "invalid", description: error.description };
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return { kind: "redirect", location: redirect.href };
}

/** The consent (src/routes/_auth/authorize.tsx): the provider parses the request, the client is
 *  named, the user's projects are offered. */
export async function consentOf(env: Env, request: Request, query: string): Promise<Consent> {
  const session = await requireIssuerSession(env, request);
  try {
    const oauthRequest = await parseAuthorization(env, authorizeRequest(request, query));
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    return {
      kind: "consent",
      query,
      clientName: client?.clientName ?? oauthRequest.clientId,
      email: session.email,
      scopes: oauthRequest.scope,
      ...(await projectsForClient(env, oauthRequest.clientId, session.sub)),
    };
  } catch (error) {
    return authorizationFailure(error);
  }
}

/** Approve: the grant minted as the user on the projects they checked — the checked ids intersected
 *  with the directory's (the door's membership check); a user with no project to choose from grants
 *  a `projects`-less grant, which follows their membership (`McpProps`). Where the browser goes: the
 *  client's redirect URI with the code. */
export async function approveConsent(
  env: Env,
  request: Request,
  query: string,
  chosen: string[],
): Promise<{ redirectTo: string } | { error: string }> {
  const session = await requireIssuerSession(env, request);
  try {
    const oauthRequest = await parseAuthorization(env, authorizeRequest(request, query));
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    const { projects, projectBound } = await projectsForClient(
      env,
      oauthRequest.clientId,
      session.sub,
    );
    const checked = new Set(chosen);
    const granted = projects.filter((p) => checked.has(p.id)).map((p) => p.id);
    return await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: session.sub,
      metadata: { clientName: client?.clientName ?? oauthRequest.clientId },
      scope: oauthRequest.scope,
      revokeExistingGrants: false,
      props: {
        kind: "user-grant",
        version: 1,
        userId: session.sub,
        email: session.email,
        projects: !projectBound && checked.has("*") ? null : granted,
        tokenKind: "oauth",
        deadline: Date.now() + 30 * 24 * 3600_000,
      } satisfies GrantProps,
    });
  } catch (error) {
    const failure = authorizationFailure(error);
    return failure.kind === "redirect"
      ? { redirectTo: failure.location }
      : { error: failure.description };
  }
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

/** A 302 to `location`, with `headers` (a Set-Cookie). */
const redirectResponse = (location: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 302, headers: { location, ...headers } });

/** Issuer forms work before hydration. App actions use Cap’n Web. */
async function consoleDoor(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);
  const { pathname, search } = url;
  if (pathname === "/login") {
    const form = await request.formData();
    try {
      const { setCookie, location } = await signIn(env, request, {
        email: String(form.get("email") ?? ""),
        next: String(form.get("next") ?? "/"),
      });
      return redirectResponse(location, { "set-cookie": setCookie });
    } catch (error) {
      const code = errorCode(error);
      if (!["UNAUTHENTICATED", "INVALID_INPUT"].includes(code ?? "")) throw error;
      return new Response(error instanceof Error ? error.message : String(error), {
        status: code === "UNAUTHENTICATED" ? 401 : 400,
      });
    }
  }
  if (pathname === "/logout")
    return redirectResponse(sameOriginPath(url.searchParams.get("next") ?? "/", url.origin), {
      "set-cookie": signOut(),
    });
  if (pathname === "/authorize") {
    if (!(await issuerSessionOf(env, request)))
      return redirectResponse(`/login?next=${encodeURIComponent(pathname + search)}`);
    const chosen = (await request.formData()).getAll("project").map(String);
    const answer = await approveConsent(env, request, search, chosen);
    return "error" in answer
      ? new Response(answer.error, { status: 400 })
      : redirectResponse(answer.redirectTo);
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
    return page;
  },
};
