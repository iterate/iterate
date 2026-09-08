// The default handler — everything that is NOT the OAuth token/metadata endpoints or the /mcp API route.
// This is the FIRST-PARTY world: the login form, the session, the home page/console, and the OAuth
// /authorize consent page (which reuses the same session AND lets you create an org + project on the
// spot). No first-party surface is ever an OAuth client; they all just carry the session cookie.

import { appConfigOf } from "../app-config.ts";
import { sameOriginPath } from "../project-host.ts";
import type { Env, Handler } from "./env.ts";
import { directory } from "./directory.ts";
import { slugify } from "./ids.ts";
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

/** THE ONE ANONYMOUS IDENTITY of `open` login mode — `user_anonymous`, a directory row seeded by
 *  definitions.sql (so its org membership's FOREIGN KEY holds on every path, /mcp included). */
export const ANONYMOUS: Session = { sub: "user_anonymous", email: "anonymous", iat: 0 };

/** The session for a request: in `open` mode ALWAYS the anonymous identity (a cookie cannot make a
 *  second identity, so /mcp and the console agree on who owns what); in `email` mode the cookie. */
async function identity(request: Request, env: Env): Promise<Session | null> {
  const { sessionSecret, loginMode } = appConfigOf(env);
  return loginMode === "open" ? ANONYMOUS : currentSession(request, sessionSecret);
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

/** The OAuth /authorize consent page — reuses the session AND lets the caller emerge with an org+project. */
async function authorize(request: Request, env: Env, session: Session | null): Promise<Response> {
  let oauthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return page("Invalid request", `<h1>Invalid authorization request</h1>`);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const clientName = client?.clientName ?? oauthRequest.clientId;
  const dir = directory(env.DB);

  // No session → show the login form; on success it returns here (next = this authorize URL).
  if (!session) {
    return page("Sign in", loginForm(request.url, `to authorize ${esc(clientName)}`));
  }

  // POST (approve): resolve the project (create org+project if the user chose "new"), then mint the grant
  // with props scoped to that project.
  if (request.method === "POST") {
    const form = await request.formData();
    const choice = String(form.get("projectId") ?? "");
    let projectId: string;
    if (choice && choice !== "__new__") {
      projectId = choice;
    } else {
      const slug = slugify(String(form.get("slug") ?? ""));
      if (!slug)
        return authorizeConsent(
          request,
          oauthRequest,
          clientName,
          session,
          dir,
          "Enter a project slug.",
        );
      const orgName = String(form.get("orgName") ?? "").trim() || `${session.email}'s org`;
      const org = await dir.ensureOrg(session.sub, orgName);
      projectId = (await dir.createProject(org.id, slug)).id;
    }
    const scope = oauthRequest.scope.length ? oauthRequest.scope : ["project"];
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: session.sub,
      metadata: { clientName },
      scope,
      props: {
        sub: session.sub,
        email: session.email,
        projectId,
      },
    });
    return Response.redirect(redirectTo, 302);
  }

  return authorizeConsent(request, oauthRequest, clientName, session, dir);
}

/** Render the consent page: pick an existing project OR create an org+project inline. */
async function authorizeConsent(
  request: Request,
  oauthRequest: { scope: string[] },
  clientName: string,
  session: Session,
  dir: ReturnType<typeof directory>,
  error = "",
): Promise<Response> {
  const projects = await dir.listProjects(session.sub);
  const existing = projects
    .map(
      (p) =>
        `<label><input type="radio" name="projectId" value="${esc(p.id)}"> <code>${esc(p.id)}</code></label>`,
    )
    .join("");
  return page(
    "Authorize",
    `<h1>Authorize ${esc(clientName)}</h1>
<p><strong>${esc(clientName)}</strong> wants to connect as <strong>${esc(session.email)}</strong>.</p>
<p class="muted">Scopes: <code>${esc(oauthRequest.scope.join(" ") || "project")}</code></p>
${error ? `<p><strong>${esc(error)}</strong></p>` : ""}
<form method="post" action="${esc(request.url)}">
  ${existing ? `<fieldset><legend>Grant access to an existing project</legend>${existing}</fieldset>` : ""}
  <fieldset><legend>…or create a new org + project</legend>
    <label><input type="radio" name="projectId" value="__new__"${existing ? "" : " checked"}> Create new</label>
    <input type="text" name="orgName" placeholder="Org name (optional)">
    <input type="text" name="slug" placeholder="new-project-slug">
  </fieldset>
  <button type="submit">Approve</button>
</form>
<form method="post" action="/logout"><button>Switch account</button></form>`,
  );
}

export const app: Handler = {
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
