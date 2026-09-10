// The OAuth authorization server and TanStack console. Directory policy lives in
// directory.ts; MCP exposes that policy through the existing context capabilities.

import { AuthorizationError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { parseAuthorization, type GrantProps } from "./oauth.ts";
import { codedError, isSameOriginBrowserRequest } from "./lib.ts";
import { directory, projectSlug, type Org, type Project } from "./directory.ts";
import { browserAuthorization } from "./browser-client.ts";
import { projectHostOf } from "./hosts.ts";
import { appConfigOf } from "./app-config.ts";
import { sameOriginPath } from "./lib.ts";
import {
  clearSessionCookie,
  setSessionCookie,
  verifySessionCookie,
  type Principal,
  type SessionCookieClaims,
} from "./principal.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import type { BrowserSession } from "./browser-session.ts";
import type { Env as DurableObjectEnv } from "./iterate-context-durable-object.ts";

/** THE ONE WORKER's bindings: the DO's (`iterate-context-durable-object.ts` `Env` — `ITERATE_CONTEXT`,
 *  where `/mcp`'s `itx.invoke` and the account page's app listing run an expression in-process
 *  through the named project's root context; `SECRETS_KV`, where a project's API-key hash sits for
 *  the project-secret bearer; the `APP_CONFIG_*` vars `appConfigOf(env)` parses) plus the control
 *  plane's own below. src/worker.ts is typed on this. `OAUTH_PROVIDER` is injected by the
 *  OAuthProvider wrapper at request time. */
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

/** What every server function of the console sees as `context` (apps/auth's `context.cloudflare.env`
 *  shape): the worker's env — with the provider's `OAUTH_PROVIDER` on it — the execution context, and
 *  the request itself: the page's under SSR, the function's own fetch on a client call — both carry
 *  the session cookie. Handed to the Start entry below; typed for the routes by ONE Start middleware
 *  (src/routes/-console-context.ts) rather than through Start's `Register` augmentation: tsc 5.9
 *  keeps one `Register` augmentation per program (the generated route tree's), a second shadows it. */
export type ConsoleRequestContext = { env: Env; ctx: ExecutionContext; request: Request };

// ── the console's server half ── one function per action, what the routes' server functions
// (src/routes/**) and the machine doors below share. Each reads the session off the request it is
// handed: the cookie is the truth, and a server function called from the browser carries it on its
// own fetch.

/** The session the request's cookie establishes (principal.ts `verifySessionCookie`), or null. */
export function issuerSessionOf(env: Env, request: Request): Promise<SessionCookieClaims | null> {
  return verifySessionCookie(request.headers.get("cookie"), appConfigOf(env).sessionSecret);
}

/** Console pages use an ordinary browser OAuth grant; issuer identity is only
 * enough to sign in and approve a new client. */
export async function consoleSessionOf(env: Env, request: Request, ctx: ExecutionContext) {
  const auth = await browserAuthorization(env, request, ctx);
  return auth?.grant
    ? { sub: auth.grant.userId, email: auth.grant.email, reach: auth.reach, grant: auth.grant }
    : null;
}
export async function requireConsoleSession(env: Env, request: Request, ctx: ExecutionContext) {
  const session = await consoleSessionOf(env, request, ctx);
  if (!session) throw codedError("UNAUTHENTICATED", "sign in first");
  return session;
}
async function requireIssuerSession(env: Env, request: Request) {
  const session = await issuerSessionOf(env, request);
  if (!session) throw codedError("UNAUTHENTICATED", "sign in first");
  return session;
}

/** Sign in as `email` (the demo login verifies nothing — an email IS a user, upserted lowercased):
 *  the `Set-Cookie` that establishes the session and where to go — `next` as a path on this origin
 *  (worker.ts `sameOriginPath`: the post-login redirect never leaves the host). A blank email is refused. */
export async function signIn(
  env: Env,
  request: Request,
  input: { email: string; next: string },
): Promise<{ setCookie: string; location: string }> {
  const email = input.email.trim();
  if (!email) throw new Error("Enter an email.");
  const user = await directory(env.DB).upsertUser(email);
  const setCookie = await setSessionCookie(
    { sub: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) },
    appConfigOf(env).sessionSecret,
  );
  return { setCookie, location: sameOriginPath(input.next, new URL(request.url).origin) };
}

/** The `Set-Cookie` that ends the session. */
export const signOut = (): string => clearSessionCookie();

/** The account page (src/routes/_auth/index.tsx): who, their orgs, their projects — each with its
 *  "open" link and one per app it serves. */
export interface Account {
  email: string;
  orgs: Org[];
  projects: (Project & { open: string | null; apps: { label: string; open: string }[] })[];
}

export async function accountOf(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<Account> {
  const session = await requireConsoleSession(env, request, ctx);
  const d1Directory = directory(env.DB);
  const [orgs, projects] = await Promise.all([
    d1Directory.listOrgs(session.sub),
    d1Directory.reachableProjects(session.reach),
  ]);
  const { projectHostnameBase } = appConfigOf(env);
  const { protocol, port } = new URL(request.url); // the deployment's scheme and port (a local worker's, too)
  const principal: Principal = { actor: session.sub, email: session.email };
  const rows = await Promise.all(
    projects.map(async (project) => {
      if (!projectHostnameBase) return { ...project, open: null, apps: [] };
      const door = (host: string) =>
        `${protocol}//${host}.${projectHostnameBase}${port ? `:${port}` : ""}/`;
      const labels = await appLabelsOf(env, project.id, principal);
      return {
        ...project,
        open: door(project.id),
        apps: labels.map((label) => ({ label, open: door(`${label}--${project.id}`) })),
      };
    }),
  );
  return { email: session.email, orgs, projects: rows };
}

/** The apps a project serves — the labels of the `itx.apps.<label>` rows in its root context's
 *  rewrite table (`itx.rewriteRules.list()`, run in-process as the user through the DO's `invokeAs`,
 *  the /mcp tool's door). A masked row is no app; a context that cannot answer lists none. */
async function appLabelsOf(env: Env, projectId: string, principal: Principal): Promise<string[]> {
  try {
    const rows = (await env.ITERATE_CONTEXT.getByName(
      DurableObjectNameCodec.stringify({ projectId, path: "/" }),
    ).invokeAs(principal, "itx.rewriteRules.list()")) as { match: string; target: unknown }[];
    return rows
      .filter((row) => row.target !== null && row.match.startsWith("itx.apps."))
      .map((row) => row.match.slice("itx.apps.".length))
      .filter((label) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(label)); // one host label (worker.ts APP_LABEL)
  } catch {
    return [];
  }
}

/** The console's create door: `directory.createProject({ userId }, name)` — the same door as
 *  `projects.create` over /api (session.ts). A taken name is coded PROJECT_NAME_TAKEN, an empty
 *  or invalid one refused: the visitor's problem, shown on the page, never a 500. */
export async function createProjectFor(
  env: Env,
  request: Request,
  name: string,
  ctx: ExecutionContext,
): Promise<Project> {
  const session = await requireConsoleSession(env, request, ctx);
  return directory(env.DB).createProject(session.reach, name);
}

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

/** The consent (src/routes/_auth/authorize.tsx): the provider parses the request, the client is
 *  named, the user's projects are offered. */
export async function consentOf(env: Env, request: Request, query: string): Promise<Consent> {
  const session = await requireIssuerSession(env, request);
  let oauthRequest;
  try {
    oauthRequest = await parseAuthorization(env, authorizeRequest(request, query));
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return { kind: "invalid", description: error.description };
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return { kind: "redirect", location: redirect.toString() };
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  return {
    kind: "consent",
    query,
    clientName: client?.clientName ?? oauthRequest.clientId,
    email: session.email,
    ...(await projectsForClient(env, oauthRequest.clientId, session.sub)),
  };
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
): Promise<{ redirectTo: string }> {
  const session = await requireIssuerSession(env, request);
  const oauthRequest = await parseAuthorization(env, authorizeRequest(request, query));
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const { projects, projectBound } = await projectsForClient(
    env,
    oauthRequest.clientId,
    session.sub,
  );
  const checked = new Set(chosen);
  const granted = projects.filter((p) => checked.has(p.id)).map((p) => p.id);
  return env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: session.sub,
    metadata: { clientName: client?.clientName ?? oauthRequest.clientId },
    scope: ["iterate"],
    revokeExistingGrants: false,
    props: {
      kind: "user-grant",
      version: 1,
      userId: session.sub,
      email: session.email,
      projects: !projectBound && checked.has("*") ? null : granted,
      resources: [oauthRequest.resource!].flat(),
      tokenKind: "oauth",
      deadline: Date.now() + 30 * 24 * 3600_000,
    } satisfies GrantProps,
  });
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

/** THE MACHINE DOORS: the console's four actions as plain form POSTs — /login (email, next),
 *  /logout (`?next=`, a path on this origin, `/` by default), /projects (slug), /authorize?<the OAuth
 *  query> (project, repeated) — each the very function the route's server function calls, answered
 *  as a form post is: a 302 on success (the session cookie set or cleared on it), a text refusal
 *  otherwise. The console's own forms post here too (src/routes/login.tsx says how: a form submitted
 *  before the page hydrates), so each door's fields are the form's. Null for anything else: the console's. */
async function consoleDoor(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);
  const { pathname, search } = url;
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  if (pathname === "/login") {
    const form = await request.formData();
    try {
      const { setCookie, location } = await signIn(env, request, {
        email: String(form.get("email") ?? ""),
        next: String(form.get("next") ?? "/"),
      });
      return redirectResponse(location, { "set-cookie": setCookie });
    } catch (error) {
      return new Response(`400: ${message(error)}\n`, { status: 400 });
    }
  }
  if (pathname === "/logout")
    return redirectResponse(sameOriginPath(url.searchParams.get("next") ?? "/", url.origin), {
      "set-cookie": signOut(),
    });
  if (pathname === "/projects") {
    // The console's form. A program creates projects over /api — `authenticate().projects.create`
    // (src/session.ts) — the same directory door.
    if (!(await consoleSessionOf(env, request, ctx))) return redirectResponse("/"); // no session: back to sign in
    const slug = String((await request.formData()).get("slug") ?? "");
    if (!projectSlug(slug)) return redirectResponse("/");
    try {
      await createProjectFor(env, request, slug, ctx);
      return redirectResponse("/");
    } catch (error) {
      return new Response(`409: ${message(error)}\n`, { status: 409 }); // a name another org holds — the visitor's problem, not a 500
    }
  }
  if (pathname === "/authorize") {
    if (!(await issuerSessionOf(env, request)))
      return redirectResponse(`/login?next=${encodeURIComponent(pathname + search)}`);
    const consent = await consentOf(env, request, search);
    if (consent.kind === "redirect") return redirectResponse(consent.location);
    if (consent.kind === "invalid")
      return new Response(`400: ${consent.description}\n`, { status: 400 });
    const chosen = (await request.formData()).getAll("project").map(String);
    return redirectResponse((await approveConsent(env, request, search, chosen)).redirectTo);
  }
  return null;
}

/** THE CONSOLE — the provider's default handler: everything that is NOT the OAuth token/metadata
 *  endpoints or the /mcp API route. Every door that ACTS is a POST — a server function's
 *  (`/_serverFn/*`) or a machine door's — and a POST from a foreign origin is 403: a browser stamps
 *  the page's origin on a form post and on a fetch alike, so a foreign one is another site driving
 *  the visitor's session cookie (a script's POST carries no Origin and passes). Then the machine
 *  doors; then the Start server entry — the routes, SSR'd, and their server functions — handed the
 *  env, the execution context and the request as every server function's `context`. A page is the
 *  visitor's own (the session, the consent): never cached. */
export const consoleHandler: Handler = {
  async fetch(request, env, ctx) {
    if (request.method === "POST" && !isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot act on this session\n", {
        status: 403,
      });
    const door = await consoleDoor(request, env, ctx);
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
