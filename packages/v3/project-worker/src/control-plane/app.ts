// The CONTROL PLANE — mounted IN-PROCESS as the project worker's front-door catch-all (src/worker.ts
// keeps /api, /expression, /version, /demo and delegates everything else to `controlPlane` below).
// The whole handler is wrapped in an OAuth 2.1 Authorization Server whose routing is the library's;
// the AS owns only a thin edge — the /token endpoint, the .well-known metadata, and token-validation
// on /mcp (mcp.ts). EVERYTHING ELSE (login, session, console, /authorize consent, project creation)
// falls through to `app`, the FIRST-PARTY world: the login form, the session, the home page/console,
// and the OAuth /authorize consent page (which reuses the same session and grants the client the
// USER — what /mcp acts as). No first-party surface is ever an OAuth client; they all just carry the
// session cookie.
//
//   • first-party surfaces  → session cookie via `app`   (0 OAuth clients)
//   • external MCP clients  → OAuth on /mcp, self-describing via CIMD  (0 hand-registered clients)

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { appConfigOf, type AppConfigEnv } from "../app-config.ts";
import { sameOriginPath } from "../project-host.ts";
import { directory, slugify } from "./directory.ts";
import { mcpHandler } from "./mcp.ts";
import {
  ANONYMOUS,
  clearSessionCookie,
  identity,
  setSessionCookie,
  type Session,
} from "./session.ts";

/** The control plane's bindings — a slice of the one worker's env (src/worker.ts intersects it with the
 *  DO's `Env`). Its configuration (the login mode, the session secret) is the worker's, through
 *  `appConfigOf(env)` (src/app-config.ts). `OAUTH_PROVIDER` is injected by the OAuthProvider wrapper at
 *  request time. */
export interface Env extends AppConfigEnv {
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The directory: users, orgs, org_members, projects (definitions.sql). Strongly consistent (D1). */
  DB: D1Database;
  /** Injected by the provider — the OAuth helper surface (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function page(title: string, body: string, headers: HeadersInit = {}): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  h2 { font-size: 1rem; margin: 1.4rem 0 .4rem; }
  form { margin: 1rem 0; }
  fieldset { border: 1px solid color-mix(in oklab, currentColor 25%, transparent); border-radius: 6px; margin: .8rem 0; }
  legend { padding: 0 .4rem; opacity: .7; font-size: .85em; }
  input[type=email], input[type=text] { font: inherit; padding: .5rem .6rem; width: 100%; box-sizing: border-box; margin-bottom: .6rem; }
  label { display: block; margin: .25rem 0; }
  button { font: inherit; padding: .5rem .9rem; cursor: pointer; }
  .muted { opacity: .6; font-size: .85em; }
  ul { padding-left: 1.1rem; }
  code { font-size: .85em; opacity: .8; }
</style>
${body}`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function loginForm(next: string, note = ""): string {
  return `<h1>Sign in</h1>
${note ? `<p>${esc(note)}</p>` : ""}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="email" name="email" placeholder="you@example.com" autofocus required>
  <button type="submit">Continue</button>
</form>
<p class="muted">Enter an email and you become that user. (Demo login mode.)</p>`;
}

async function home(_request: Request, env: Env, session: Session): Promise<Response> {
  const dir = directory(env.DB);
  const [orgs, projects] = await Promise.all([
    dir.listOrgs(session.sub),
    dir.listProjects(session.sub),
  ]);
  const orgList = orgs.length
    ? `<ul>${orgs.map((o) => `<li>${esc(o.name)} <span class="muted">(${esc(o.role ?? "")})</span></li>`).join("")}</ul>`
    : `<p class="muted">No orgs yet.</p>`;
  const projList = projects.length
    ? `<ul>${projects.map((p) => `<li><code>${esc(p.id)}</code> <span class="muted">in ${esc(p.orgId)}</span></li>`).join("")}</ul>`
    : `<p class="muted">No projects yet.</p>`;
  return page(
    "Control plane",
    `<h1>Signed in as ${esc(session.email)}</h1>
<h2>Orgs</h2>${orgList}
<h2>Projects</h2>${projList}
<form method="post" action="/projects"><input type="text" name="slug" placeholder="new-project-slug" required><button>Create project</button></form>
<form method="post" action="/logout"><button>Log out</button></form>`,
  );
}

/** The OAuth /authorize consent page — reuses the session; approving grants the client the USER
 *  (`props.sub` / `props.email`, what every /mcp tool acts as). */
async function authorize(request: Request, env: Env, session: Session | null): Promise<Response> {
  let oauthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return page("Invalid request", `<h1>Invalid authorization request</h1>`);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const clientName = client?.clientName ?? oauthRequest.clientId;

  // No session → show the login form; on success it returns here (next = this authorize URL).
  if (!session) {
    return page("Sign in", loginForm(request.url, `to authorize ${clientName}`));
  }

  // POST (approve): mint the grant as the user.
  if (request.method === "POST") {
    const scope = oauthRequest.scope.length ? oauthRequest.scope : ["project"];
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: session.sub,
      metadata: { clientName },
      scope,
      props: { sub: session.sub, email: session.email },
    });
    return Response.redirect(redirectTo, 302);
  }

  return page(
    "Authorize",
    `<h1>Authorize ${esc(clientName)}</h1>
<p><strong>${esc(clientName)}</strong> wants to connect as <strong>${esc(session.email)}</strong>.</p>
<p class="muted">Scopes: <code>${esc(oauthRequest.scope.join(" ") || "project")}</code></p>
<form method="post" action="${esc(request.url)}"><button type="submit">Approve</button></form>
<form method="post" action="/logout"><button>Switch account</button></form>`,
  );
}

/** The provider's default handler — everything that is NOT the OAuth token/metadata endpoints or the
 *  /mcp API route. */
const app: Handler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const session = await identity(request, env);
    const dir = directory(env.DB);

    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const email = String(form.get("email") ?? "").trim();
      const next = String(form.get("next") ?? "/");
      if (!email) return page("Sign in", loginForm(next, "Enter an email."));
      const user = await dir.upsertUser(email);
      const cookie = await setSessionCookie(
        { sub: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) },
        appConfigOf(env).sessionSecret,
      );
      return new Response(null, {
        status: 302,
        headers: { location: sameOriginPath(next, url.origin), "set-cookie": cookie },
      });
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": clearSessionCookie() },
      });
    }

    if (url.pathname === "/authorize") {
      return authorize(request, env, session);
    }

    if (url.pathname === "/projects" && request.method === "POST") {
      // The console's form. A program creates projects over /api — `authenticate().projects.create`
      // (src/session.ts) — the same directory door.
      const back = new Response(null, { status: 302, headers: { location: "/" } });
      if (!session) return back;
      const slug = slugify(String((await request.formData()).get("slug") ?? ""));
      if (!slug) return back;
      const org = await dir.ensureOrg(session.sub, `${session.email}'s org`);
      try {
        await dir.createProject(org.id, slug);
        return back;
      } catch (error) {
        // a name another org holds — the visitor's problem, shown, not a 500
        const message = error instanceof Error ? error.message : String(error);
        return page(
          "Create project",
          `<h1>Not created</h1><p>${esc(message)}</p><p><a href="/">Back</a></p>`,
        );
      }
    }

    if (url.pathname === "/") {
      return session ? home(request, env, session) : page("Sign in", loginForm("/"));
    }

    return new Response("Not found", { status: 404 });
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp", // the ONLY OAuth-protected boundary
  apiHandler: mcpHandler,
  defaultHandler: app, // login + session + /authorize consent + console
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  scopesSupported: ["project"],
  allowPlainPKCE: false, // OAuth 2.1: S256 only
  clientIdMetadataDocumentEnabled: true, // CIMD — clients register themselves by URL (proved on HTTPS)
  clientRegistrationEndpoint: "/register", // DCR — the spec-sanctioned MAY-fallback (the local http proof)
});

/** The control plane's front door. `open` login mode (APP_CONFIG_LOGIN_MODE): no OAuth, so `/mcp` is
 *  TOKENLESS — short-circuit before the provider's apiRoute would 401, running the MCP server with the
 *  single anonymous identity. `email` mode goes through the provider unchanged. */
export const controlPlane: Handler = {
  async fetch(request, env, ctx) {
    if (appConfigOf(env).loginMode === "open" && new URL(request.url).pathname === "/mcp") {
      (ctx as ExecutionContext & { props: unknown }).props = {
        sub: ANONYMOUS.sub,
        email: ANONYMOUS.email,
      };
      return mcpHandler.fetch(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },
};
