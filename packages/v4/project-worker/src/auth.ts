// auth.ts — optional browser identity around the clean-room edge, plus the same OAuth provider
// that will protect MCP. It deliberately proves only possession of an email-shaped string: no mail
// is sent and no account ownership is claimed.

import {
  AuthorizationError,
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const BrowserPrincipal = z.strictObject({
  kind: z.literal("unverified-email"),
  email: z.email().max(254),
});
const OAuthProps = z.strictObject({
  principal: BrowserPrincipal,
  project: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
});
const Project = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

export type BrowserPrincipal = z.infer<typeof BrowserPrincipal>;

/** Bind this only on a named deployment. With neither binding the wrapper is intentionally absent,
 * so local clean-room compatibility suites keep their anonymous `/api` behaviour. A partial
 * configuration is an operational error, never a silent anonymous fallback. */
export interface OptionalAuthEnv {
  PUBLIC_ORIGIN?: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

type Core<Env> = {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    principal?: BrowserPrincipal,
  ): Promise<Response>;
};

type AuthEnv = Required<OptionalAuthEnv>;

/** Add browser-login and OAuth routes without changing the clean-room HTTP or Cap'n Web interface.
 * Identity travels only as a server-side parameter; callers retain
 * `authenticate(credentials?).projects.get(projectId)` exactly. */
export function withOptionalDemoLogin<Env extends OptionalAuthEnv>(core: Core<Env>) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const configured = configuredAuthEnv(env);
      if (!configured) return core.fetch(request, env, ctx);
      const url = new URL(request.url);
      if (url.origin !== configured.PUBLIC_ORIGIN)
        return new Response("Wrong origin", { status: 421 });
      const provider = new OAuthProvider<Env & AuthEnv>({
        apiRoute: "/mcp",
        apiHandler: {
          async fetch(protectedRequest, protectedEnv, protectedContext) {
            const props = OAuthProps.parse(protectedContext.props);
            const protectedUrl = new URL(protectedRequest.url);
            if (protectedUrl.searchParams.get("project") !== props.project)
              return new Response("Project not granted", { status: 403 });
            return core.fetch(protectedRequest, protectedEnv, protectedContext, props.principal);
          },
        },
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        scopesSupported: ["project"],
        allowPlainPKCE: false,
        clientIdMetadataDocumentEnabled: false,
        resourceMetadata: {
          resource: `${configured.PUBLIC_ORIGIN}/mcp`,
          scopes_supported: ["project"],
        },
        defaultHandler: {
          fetch: (unprotectedRequest, providerEnv, providerContext) =>
            defaultFetch(unprotectedRequest, providerEnv, providerContext, core),
        },
      });
      // `configuredAuthEnv()` proved these bindings exist. OAuthProvider augments this same Env
      // object with OAUTH_PROVIDER before it calls the configured default handler.
      return provider.fetch(request, configured, ctx);
    },
  };
}

async function defaultFetch<Env extends OptionalAuthEnv>(
  request: Request,
  env: Env & AuthEnv,
  ctx: ExecutionContext,
  core: Core<Env>,
): Promise<Response> {
  const url = new URL(request.url);
  const cookieName = url.protocol === "https:" ? "__Host-iterate-session" : "iterate-session";
  if (url.pathname === "/version" || url.pathname === "/secrets")
    return core.fetch(request, env, ctx);
  if (url.pathname === "/login") return login(request, env, url, cookieName);

  const principal = await browserPrincipal(request, env.OAUTH_KV, cookieName);
  // A cookie-bearing browser request must name this dashboard's origin before it can reach any
  // identity-aware route, including the `/api` WebSocket upgrade (CSWSH protection). Non-browser
  // clients omit Origin and retain the explicitly-supported server-to-server path.
  if (principal && foreignOrigin(request, url))
    return new Response("Cross-origin request denied", { status: 403 });
  if (url.pathname === "/logout") {
    if (!principal) return new Response("Log in at /login", { status: 401 });
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    if (!sameOriginPost(request, url))
      return new Response("Same-origin POST required", { status: 403 });
    const token = readCookie(request, cookieName);
    if (token) await env.OAUTH_KV.delete(`demo-session:${await sha256(token)}`);
    return redirect(
      "/login",
      `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`,
    );
  }
  if (!principal) {
    if (url.pathname === "/") return redirect("/login");
    if (url.pathname === "/authorize")
      return redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
    return new Response("Log in at /login", { status: 401 });
  }
  if (url.pathname === "/session")
    return Response.json(
      { email: principal.email, verified: false },
      { headers: { "cache-control": "no-store" } },
    );
  if (url.pathname === "/") return redirect("/app");
  if (url.pathname === "/app") return appPage(principal);
  if (url.pathname === "/authorize") return authorize(request, env, url, principal);

  // A core handler never needs the bearer cookie. Identity travels only on this server-side
  // parameter, then Session gives it to the clean-room `/api` target without changing its RPC API.
  const clean = new Request(request);
  clean.headers.delete("cookie");
  return core.fetch(clean, env, ctx, principal);
}

async function login<Env extends OptionalAuthEnv>(
  request: Request,
  env: Env & AuthEnv,
  url: URL,
  cookieName: string,
): Promise<Response> {
  if (request.method === "GET") return loginPage();
  if (request.method !== "POST") return new Response("POST required", { status: 405 });
  if (!sameOriginPost(request, url))
    return new Response("Same-origin POST required", { status: 403 });
  const parsed = z
    .email()
    .max(254)
    .safeParse((await request.formData()).get("email"));
  if (!parsed.success) return new Response("Enter an email address", { status: 400 });
  const next = new URL(url.searchParams.get("next") ?? "/app", url);
  if (next.origin !== url.origin) return new Response("Invalid return URL", { status: 400 });
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.OAUTH_KV.put(`demo-session:${await sha256(token)}`, parsed.data, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return redirect(
    next.pathname + next.search,
    `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${url.protocol === "https:" ? "; Secure" : ""}`,
  );
}

async function browserPrincipal(
  request: Request,
  kv: KVNamespace,
  cookieName: string,
): Promise<BrowserPrincipal | undefined> {
  const token = readCookie(request, cookieName);
  if (!token) return undefined;
  const email = await kv.get(`demo-session:${await sha256(token)}`);
  return email ? { kind: "unverified-email", email } : undefined;
}

async function authorize<Env extends OptionalAuthEnv>(
  request: Request,
  env: Env & AuthEnv,
  url: URL,
  principal: BrowserPrincipal,
): Promise<Response> {
  try {
    const authorization = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!authorization.scope.includes("project"))
      return new Response("Request the project scope", { status: 400 });
    if (request.method === "GET") return authorizationPage(authorization.clientId, principal.email);
    if (request.method !== "POST" || !sameOriginPost(request, url))
      return new Response("Same-origin POST required", { status: 403 });
    const project = Project.parse((await request.formData()).get("project"));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authorization,
      userId: principal.email,
      metadata: {},
      scope: ["project"],
      props: { principal, project },
    });
    return Response.redirect(redirectTo, 302);
  } catch (error) {
    if (error instanceof AuthorizationError)
      return new Response(error.description, { status: 400 });
    if (error instanceof z.ZodError) return new Response(error.message, { status: 400 });
    throw error;
  }
}

function configuredAuthEnv<Env extends OptionalAuthEnv>(env: Env): (Env & AuthEnv) | undefined {
  if (!env.PUBLIC_ORIGIN && !env.OAUTH_KV) return undefined;
  if (!env.PUBLIC_ORIGIN || !env.OAUTH_KV)
    throw new Error("Auth requires both PUBLIC_ORIGIN and OAUTH_KV on a configured deployment");
  new URL(env.PUBLIC_ORIGIN);
  // The two checks above establish the optional fields required by the configured provider.
  return env as Env & AuthEnv;
}

function readCookie(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function sameOriginPost(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}

function foreignOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== url.origin;
}

function redirect(location: string, cookie?: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", ...(cookie && { "set-cookie": cookie }) },
  });
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><main>${body}</main></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function loginPage(): Response {
  return page(
    "Log in",
    '<h1>Log in</h1><p>Architectural demo: no email verification. This is shared sandbox data, not a private account.</p><form method="post"><label>Email address <input name="email" type="email" autocomplete="email" required></label><p><button>Log in</button></p></form>',
  );
}

function appPage(principal: BrowserPrincipal): Response {
  return page(
    "Iterate sandbox",
    `<h1>Iterate sandbox</h1><p>Signed in as ${escape(principal.email)}. This email is unverified.</p><p>Projects are addressed by project ID through the ITX surface; this proof-of-concept intentionally does not claim account ownership or create a project directory.</p><p><a href="/docs">Open collaborative Docs</a> · <a href="/demo">Live-state explorer</a></p><form action="/logout" method="post"><button>Log out</button></form>`,
  );
}

function authorizationPage(clientId: string, email: string): Response {
  return page(
    "Authorize MCP",
    `<h1>Authorize MCP</h1><p>${escape(clientId)} requests project access as ${escape(email)}.</p><form method="post"><label>Project <input name="project" required pattern="[A-Za-z0-9_-]{1,80}"></label><p><button>Allow project access</button></p></form>`,
  );
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
