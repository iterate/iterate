// The default handler — everything that is NOT the OAuth token/metadata endpoints or the /mcp API route.
// This is the FIRST-PARTY world (design §2): the login form, the session, the home page/console, and the
// OAuth /authorize consent page (which reuses the same session AND lets you create an org + project on the
// spot — the "emerge with a project during MCP auth" flow, ADR 0029). No first-party surface is ever an
// OAuth client; they all just carry the session cookie.

import { newWorkersRpcResponse } from "capnweb";
import type { Env, Handler, LoginMode } from "./env.ts";
import { Os } from "./api.ts";
import { directory } from "./directory.ts";
import { sha256hex } from "./hash.ts";
import { slugify } from "./ids.ts";
import { resolveHost, stampFor } from "./ingress.ts";
import { clearSessionCookie, currentSession, setSessionCookie, type Session } from "./session.ts";

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Post-login redirect target, hardened against open redirects: only SAME-ORIGIN. Resolving `next` against
 *  our origin turns `http://evil.com` and protocol-relative `//evil.com` into a foreign origin → rejected
 *  to "/". A same-origin absolute URL (e.g. the /authorize URL) collapses to its path+query. */
function safeNext(next: string, origin: string): string {
  try {
    const u = new URL(next, origin);
    return u.origin === origin ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

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

const loginMode = (env: Env): LoginMode => env.LOGIN_MODE ?? "email";

/** Resolve identity WITHOUT a cookie — for `access` (header) and `open` (anonymous) modes. */
async function ambientIdentity(request: Request, env: Env): Promise<Session | null> {
  const mode = loginMode(env);
  if (mode === "open") return { sub: "user_anonymous", email: "anonymous", iat: 0 };
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
    ? `<ul>${projects.map((p) => `<li><code>${esc(p.slug)}</code> <span class="muted">in ${esc(p.orgId)}</span></li>`).join("")}</ul>`
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
      const { project } = await dir.emerge(session.sub, orgName, slug); // create org + membership + project
      projectId = project.id;
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
        grants: [{ projectId, scopes: scope }],
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
        `<label><input type="radio" name="projectId" value="${esc(p.id)}"> <code>${esc(p.slug)}</code></label>`,
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
        env.SESSION_SECRET,
      );
      return new Response(null, {
        status: 302,
        headers: { location: safeNext(next, url.origin), "set-cookie": cookie },
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
      const slug = slugify(String(form.get("slug") ?? ""));
      if (slug) {
        const org = await dir.ensureOrg(session.sub, session.email);
        await dir.createProject(org.id, slug);
      }
      return new Response(null, { status: 302, headers: { location: "/" } });
    }

    // The capnweb /api — the control plane's typed API (sibling of /mcp). Session-or-API-key auth (design
    // §2a): OAuth stays at /mcp. Os.authenticate() reads the cookie/bearer against the D1 directory.
    if (url.pathname === "/api") {
      return newWorkersRpcResponse(request, new Os(request, env));
    }

    // PROJECT INGRESS. In a real deploy the control plane fronts project HOSTs (`<slug>.<base>`), resolves
    // host→projectId via the routes table, and serves the project. On single-host workers.dev we demonstrate
    // the routing half via `/__ingress?host=<host>`: resolve the host + stamp membership. The DIAL half was
    // deleted in clean-room increment cook-1 (the pre-skeleton runner is gone); serving returns via the
    // capability host in a later control-plane increment.
    if (url.pathname === "/__ingress") {
      const host = url.searchParams.get("host");
      if (!host) return new Response("missing ?host\n", { status: 400 });
      const resolved = await resolveHost(host, env);
      if (!resolved) return new Response(`no project for host '${host}'\n`, { status: 404 });
      const actor = session?.sub ?? "user_anonymous";
      const email = session?.email ?? "anonymous";
      const caller = await stampFor(actor, email, resolved.projectId, env);
      return Response.json(
        { resolved, caller, error: "project dial removed (clean-room cook-1)" },
        { status: 503 },
      );
    }

    // Register a route (map a hostname to a project) — the human twin of capnweb project.mapHostname.
    if (url.pathname === "/routes" && request.method === "POST") {
      if (!session) return new Response(null, { status: 302, headers: { location: "/" } });
      const form = await request.formData();
      const host = String(form.get("host") ?? "").trim();
      const projectId = String(form.get("projectId") ?? "").trim();
      if (host && projectId) await dir.upsertRoute(host, projectId, String(form.get("app") ?? ""));
      return new Response(null, { status: 302, headers: { location: "/" } });
    }

    // CIMD client metadata doc — a real public URL usable as an OAuth `client_id` (design §4). Its own URL
    // is the client_id; the provider fetches + validates this when a client presents that URL.
    if (url.pathname === "/cimd-test-client") {
      return Response.json({
        client_id: `${url.origin}/cimd-test-client`,
        client_name: "Proof MCP Client",
        redirect_uris: ["http://localhost:8976/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }

    // Mint an API key scoped to a project (shown once). The console's programmatic-access affordance.
    if (url.pathname === "/apikeys" && request.method === "POST") {
      if (!session) return new Response(null, { status: 302, headers: { location: "/" } });
      const form = await request.formData();
      const projectId = String(form.get("projectId") ?? "").trim();
      const label = String(form.get("label") ?? "cli").trim() || "cli";
      // A key may only be scoped to a project the minter can actually reach — otherwise a user could assert
      // a grant for a project they're not a member of. (Enforcement of these grants at read time is still a
      // known gap — see the review-response doc; today a key inherits its owner's directory authority.)
      if (projectId) {
        const access = await dir.access(session.sub, projectId);
        if (!access.ok) return new Response(`not a member of '${projectId}'\n`, { status: 403 });
      }
      const raw = `key_${crypto.randomUUID().replaceAll("-", "")}`;
      await dir.createApiKey(
        await sha256hex(raw),
        session.sub,
        label,
        projectId ? [{ projectId, scopes: ["project"] }] : [],
      );
      return page(
        "API key",
        `<h1>API key created</h1>
<p>Copy it now — it is not shown again:</p>
<p><code>${esc(raw)}</code></p>
<p class="muted">scoped to project: ${esc(projectId || "(none)")}</p>
<p><a href="/">← back</a></p>`,
      );
    }

    if (url.pathname === "/") {
      return session ? home(request, env, session) : page("Sign in", loginForm("/"));
    }

    return new Response("Not found", { status: 404 });
  },
};
