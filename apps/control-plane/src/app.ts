// The default handler — everything that is NOT the OAuth token/metadata endpoints or the /mcp API route.
// This is the FIRST-PARTY world (design §2): the login form, the session, the home page, and the OAuth
// /authorize consent page (which reuses the same session). No first-party surface is ever an OAuth client;
// they all just carry the session cookie. That is the escape from the app/os client-juggling mess.

import type { Env, Handler, LoginMode } from "./env.ts";
import { directory } from "./directory.ts";
import { clearSessionCookie, currentSession, setSessionCookie, type Session } from "./session.ts";

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
  form { margin: 1rem 0; }
  input[type=email], input[type=text] { font: inherit; padding: .5rem .6rem; width: 100%; box-sizing: border-box; margin-bottom: .6rem; }
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

const loginMode = (env: Env): LoginMode => env.LOGIN_MODE ?? "email";

/** Resolve identity WITHOUT a cookie — for `access` (header) and `open` (anonymous) modes. */
async function ambientIdentity(request: Request, env: Env): Promise<Session | null> {
  const mode = loginMode(env);
  if (mode === "open") return { sub: "user:anonymous", email: "anonymous", iat: 0 };
  if (mode === "access") {
    const email = request.headers.get(
      env.ACCESS_EMAIL_HEADER ?? "cf-access-authenticated-user-email",
    );
    if (!email) return null;
    const user = await directory(env.DB).upsertUser(email);
    return { sub: user.id, email: user.email, iat: 0 };
  }
  return null;
}

/** The session for a request: cookie (email mode) or ambient (access/open). */
async function identity(request: Request, env: Env): Promise<Session | null> {
  return (await currentSession(request, env.SESSION_SECRET)) ?? ambientIdentity(request, env);
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

async function home(request: Request, env: Env, session: Session): Promise<Response> {
  const projects = await directory(env.DB).listProjects(session.sub);
  const list = projects.length
    ? `<ul>${projects.map((p) => `<li>${esc(p.slug)}</li>`).join("")}</ul>`
    : `<p class="muted">No projects yet.</p>`;
  return page(
    "kernel-auth",
    `<h1>Signed in as ${esc(session.email)}</h1>
${list}
<form method="post" action="/projects"><input type="text" name="slug" placeholder="new-project-slug" required><button>Create project</button></form>
<form method="post" action="/logout"><button>Log out</button></form>`,
  );
}

/** The OAuth /authorize consent page — reuses the same login + session. */
async function authorize(request: Request, env: Env, session: Session | null): Promise<Response> {
  let oauthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return page("Invalid request", `<h1>Invalid authorization request</h1>`, {}); // 200 body; provider-owned errors are separate
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const clientName = client?.clientName ?? oauthRequest.clientId;

  // No session → show the login form; on success it returns here (next = this authorize URL).
  if (!session) {
    return page("Sign in", loginForm(request.url, `to authorize ${clientName}`));
  }

  // Session present. GET renders consent; POST (approve) completes the grant.
  if (request.method === "POST") {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: session.sub,
      metadata: { clientName },
      scope: oauthRequest.scope,
      props: { sub: session.sub, email: session.email },
    });
    return Response.redirect(redirectTo, 302);
  }

  return page(
    "Authorize",
    `<h1>Authorize ${esc(clientName)}</h1>
<p><strong>${esc(clientName)}</strong> wants to connect as <strong>${esc(session.email)}</strong>.</p>
<p class="muted">Scopes: <code>${esc(oauthRequest.scope.join(" ") || "(none)")}</code></p>
<form method="post" action="${esc(request.url)}"><button type="submit">Approve</button></form>
<form method="post" action="/logout"><button>Switch account</button></form>`,
  );
}

export const app: Handler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const session = await identity(request, env);

    // Login — email mode only; become the entered user.
    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const email = String(form.get("email") ?? "").trim();
      const next = String(form.get("next") ?? "/");
      if (!email) return page("Sign in", loginForm(next, "Enter an email."));
      const user = await directory(env.DB).upsertUser(email);
      const cookie = await setSessionCookie(
        { sub: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) },
        env.SESSION_SECRET,
      );
      return new Response(null, {
        status: 302,
        headers: {
          location: next.startsWith("/") || next.startsWith("http") ? next : "/",
          "set-cookie": cookie,
        },
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
      if (!session) return new Response(null, { status: 302, headers: { location: "/" } });
      const form = await request.formData();
      const slug = String(form.get("slug") ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");
      if (slug) await directory(env.DB).createProject(session.sub, slug);
      return new Response(null, { status: 302, headers: { location: "/" } });
    }

    if (url.pathname === "/") {
      return session ? home(request, env, session) : page("Sign in", loginForm("/"));
    }

    return new Response("Not found", { status: 404 });
  },
};
