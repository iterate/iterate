// control-plane.ts — THE CONTROL PLANE, in-process behind the project worker's front door (worker.ts
// keeps /api, /expression, /version, /demo and delegates everything else to `controlPlane`). Four
// concepts, one file; the schema is control-plane.sql:
//   directory — `directory(db)`: ONE D1 store, users → orgs → projects — the control plane IS the directory
//   session   — `currentSession` / `setSessionCookie`: the signed first-party cookie, "you are this user"
//   mcp       — `mcpHandler`: the /mcp route, the ONLY OAuth-protected boundary
//   app       — `controlPlane`: the OAuth 2.1 AS wrapper around the first-party pages (login, console, /authorize)

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { codedError } from "./lib.ts";
import { appConfigOf, type AppConfigEnv, sameOriginPath } from "./worker.ts";
import { signClaims, verifyClaims } from "./principal.ts";

// ── directory ── the control plane IS the directory. One D1 store, strongly consistent (no KV
// list() lag), relational and org-centric: users → orgs (via org_members) → projects. A project's id is
// ONE DNS-safe name (control-plane.sql): the directory row, the context DO's name and the project-host
// label — nothing a caller can mint escapes it. The statements below are the control plane's whole
// SQL, each spelled once at its one call site and bound positionally; the three row interfaces are
// the rows D1 hands back (`org_id` is selected `AS orgId`).

/** A `users` row. */
export interface User {
  id: string; // user_<lowercased-email>
  email: string;
}
/** An `orgs` row, with the reader's `role` when read through `org_members`. */
export interface Org {
  id: string; // org_<hex>
  name: string;
  role?: string;
}
/** A `projects` row, with the reader's `role` when read through `org_members`. */
export interface Project {
  id: string; // the DNS-safe name — the DO name and the host label
  orgId: string;
  role?: string;
}

/** Slugify as @iterate-com/shared/slug normalizes (lowercase, non-alphanumeric → dash, trimmed). A
 *  PROJECT has no minted id — its slug IS its id; an org has no slug at all. */
const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/** `org_<32hex>`. */
const newOrgId = () => `org_${crypto.randomUUID().replaceAll("-", "")}`;

export function directory(db: D1Database) {
  const dir = {
    /** Find-or-create the user for an email (login is the only writer). */
    async upsertUser(email: string): Promise<User> {
      const normalized = email.trim().toLowerCase();
      // NB: user id must be colon-free — the OAuth provider encodes tokens as `{userId}:{grantId}:{secret}`
      // and splits on ':'. A `user:<email>` id would break that (and the token/grant KV keys).
      const user = await db
        .prepare(
          `INSERT INTO users (id, email) VALUES (?, ?)
ON CONFLICT(id) DO UPDATE SET email = excluded.email
RETURNING id, email;`,
        )
        .bind(`user_${normalized}`, normalized)
        .first<User>();
      return user!;
    },

    /** Create an org (a minted org_ id; the name is free text, two orgs may share one) and make the
     *  creator its owner. */
    async createOrg(userId: string, name: string): Promise<Org> {
      const org = await db
        .prepare(
          `INSERT INTO orgs (id, name) VALUES (?, ?)
RETURNING id, name;`,
        )
        .bind(newOrgId(), name)
        .first<Org>();
      await db
        .prepare(
          `INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)
ON CONFLICT(org_id, user_id) DO NOTHING;`,
        )
        .bind(org!.id, userId, "owner")
        .run();
      return { ...org!, role: "owner" };
    },

    /** Orgs the user belongs to. */
    async listOrgs(userId: string): Promise<Org[]> {
      const { results } = await db
        .prepare(
          `SELECT o.id, o.name, m.role
FROM orgs o
JOIN org_members m ON m.org_id = o.id
WHERE m.user_id = ?
ORDER BY o.name ASC;`,
        )
        .bind(userId)
        .all<Org>();
      return results;
    },

    /** Create a project inside an org: `name` slugified IS the id, GLOBALLY unique — a name already
     *  taken in ANY org throws "already taken". Idempotent within the same org (the insert is ON
     *  CONFLICT DO NOTHING, then re-selected to cover both "just created" and "already existed"). */
    async createProject(orgId: string, name: string): Promise<Project> {
      const id = slugify(name);
      if (!id) throw new Error("project name is empty or invalid");
      await db
        .prepare(
          `INSERT INTO projects (id, org_id) VALUES (?, ?)
ON CONFLICT DO NOTHING;`,
        )
        .bind(id, orgId)
        .run();
      const project = await dir.getProject(id);
      if (!project) throw new Error(`failed to create project '${id}'`);
      if (project.orgId !== orgId)
        throw codedError("PROJECT_NAME_TAKEN", `project name '${id}' is already taken`);
      return project;
    },

    /** The user's first org, created as `orgName` (with them as owner) when they have none yet — every
     *  create-a-project door (the console, /authorize, /mcp) goes through here, then `createProject`. */
    async ensureOrg(userId: string, orgName: string): Promise<Org> {
      const orgs = await dir.listOrgs(userId);
      return orgs[0] ?? dir.createOrg(userId, orgName);
    },

    /** Projects the user can reach (member of the owning org), with their role. */
    async listProjects(userId: string): Promise<Project[]> {
      const { results } = await db
        .prepare(
          `SELECT p.id, p.org_id AS orgId, m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE m.user_id = ?
ORDER BY p.id ASC;`,
        )
        .bind(userId)
        .all<Project>();
      return results;
    },

    /** A project by id (its org), or null — the edge's admission (worker.ts). */
    async getProject(id: string): Promise<Project | null> {
      return db
        .prepare(`SELECT id, org_id AS orgId FROM projects WHERE id = ?;`)
        .bind(id)
        .first<Project>();
    },

    /** EVERY project in the directory, no role — the admin secret's catalog (src/session.ts). */
    async listAllProjects(): Promise<Project[]> {
      const { results } = await db
        .prepare(`SELECT id, org_id AS orgId FROM projects ORDER BY id ASC;`)
        .all<Project>();
      return results;
    },

    /** The deployment's own org — `org_admin`, created on first use, no members: where the admin
     *  secret's `projects.create` puts a project (a user reaches one only through the admin secret
     *  or its `as`). */
    async adminOrg(): Promise<Org> {
      await db
        .prepare(
          `INSERT INTO orgs (id, name) VALUES ('org_admin', 'admin') ON CONFLICT DO NOTHING;`,
        )
        .run();
      return { id: "org_admin", name: "admin" };
    },
  };

  return dir;
}

/** The directory as the edge holds it (src/session.ts). */
export type Directory = ReturnType<typeof directory>;

// ── session ── a signed cookie that says "you are this user". This is the FIRST-PARTY auth mechanism:
// browser pages carry it, no OAuth involved. OAuth only appears at the MCP edge, and its /authorize
// consent reuses whatever session this module minted. One login, reused everywhere. The token is the
// platform's one signed-claims codec (src/principal.ts) under the session secret.

/** The identity behind a browser session. */
export interface Session {
  /** Directory user id, e.g. `user_ada@example.com`. */
  sub: string;
  email: string;
  /** Issued-at (epoch seconds). */
  iat: number;
}

/** WHO a request is, for every door on the platform host (the console, `/api`, the fetch lane): the
 *  session cookie's user, or nobody. */
export async function identity(request: Request, env: AppConfigEnv): Promise<Session | null> {
  return currentSession(request, appConfigOf(env).sessionSecret);
}

const COOKIE = "itx-control-plane-session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** The session a token carries, or null: malformed, a bad signature, the wrong shape, or past
 *  MAX_AGE (the signed token is otherwise valid forever — Max-Age is only a browser hint, so a
 *  captured token could be replayed indefinitely). */
async function verifySession(token: string, secret: string): Promise<Session | null> {
  const session = (await verifyClaims(token, secret)) as Session | null;
  if (typeof session?.sub !== "string" || typeof session?.iat !== "number") return null;
  if (Math.floor(Date.now() / 1000) - session.iat > MAX_AGE) return null;
  return session;
}

function readCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The current session for a request, or null if unauthenticated. */
export async function currentSession(request: Request, secret: string): Promise<Session | null> {
  const token = readCookie(request);
  return token ? verifySession(token, secret) : null;
}

/** `Set-Cookie` value that establishes the session. */
async function setSessionCookie(session: Session, secret: string): Promise<string> {
  const token = await signClaims(session, secret);
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
}

/** `Set-Cookie` value that clears the session. */
function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ── mcp ── the /mcp API route: the ONLY OAuth-protected boundary. The provider validated the bearer (an OAuth
// access token) BEFORE this runs and put the granted props on ctx.props. An MCP server
// (@modelcontextprotocol/server) mounts here, scoped to that identity: every tool acts as the USER the
// grant names (/authorize, the app section below).

/** The props the provider put on ctx after validating the bearer: the user the grant names. */
interface AuthProps {
  sub: string;
  email: string;
}

const validator = new CfWorkerJsonSchemaValidator();
type JsonSchema = Parameters<typeof fromJsonSchema>[0];
const input = (properties: Record<string, unknown>, required: string[] = []) =>
  fromJsonSchema(
    { type: "object", properties, required, additionalProperties: false } as JsonSchema,
    validator,
  );
const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  isError,
});
const str = (a: Record<string, unknown>, k: string) => String(a[k] ?? "");

function buildServer(env: Env, props: AuthProps): McpServer {
  const dir = directory(env.DB);
  const s = new McpServer({ name: "control-plane", version: "0.1.0" });

  s.registerTool(
    "whoami",
    {
      description: "Who this token authenticates as: the user it was granted to at authorization.",
      inputSchema: input({}),
    },
    async () => text(JSON.stringify({ email: props.email, sub: props.sub }, null, 2)),
  );

  s.registerTool(
    "list_projects",
    { description: "List the projects you can reach in this deployment.", inputSchema: input({}) },
    async () => {
      const ps = await dir.listProjects(props.sub);
      return text(
        ps.length ? ps.map((p) => `${p.id}  (org ${p.orgId}, ${p.role})`).join("\n") : "(none yet)",
      );
    },
  );

  s.registerTool(
    "create_project",
    {
      description:
        "Create a project in your first org (creating that org if you have none) and return it — how you 'emerge with a project' from MCP.",
      inputSchema: input({ project: { type: "string" }, orgName: { type: "string" } }, ["project"]),
    },
    async (raw: unknown) => {
      const a = raw as Record<string, unknown>;
      try {
        const name = str(a, "project");
        if (!name) return text("create_project needs a project name", true);
        const org = await dir.ensureOrg(props.sub, str(a, "orgName") || `${props.email}'s org`);
        const project = await dir.createProject(org.id, name);
        return text(`created project '${project.id}' in org '${org.name}' (${org.id})`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  return s;
}

const mcpHandler: Handler = {
  async fetch(request, env, ctx) {
    const { props } = ctx as ExecutionContext & { props: AuthProps };
    // A fresh handler per request under the default response mode (`auto`: one JSON body unless a
    // notification precedes the result — these tools emit none). Not `responseMode: "json"`: the
    // SDK `console.warn`s on every handler built that way, which here would be every request.
    return createMcpHandler(() => buildServer(env, props)).fetch(request);
  },
};

// ── app ── THE CONTROL PLANE, mounted IN-PROCESS as the project worker's front-door catch-all (src/worker.ts
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

/** The control plane's bindings — a slice of the one worker's env (src/worker.ts intersects it with the
 *  DO's `Env`). Its configuration (the session secret) is the worker's, through `appConfigOf(env)`
 *  (src/worker.ts). `OAUTH_PROVIDER` is injected by the OAuthProvider wrapper at
 *  request time. */
export interface Env extends AppConfigEnv {
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The directory: users, orgs, org_members, projects (control-plane.sql). Strongly consistent (D1). */
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
<p class="muted">Enter an email and you become that user. (The demo login verifies nothing.)</p>`;
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

/** The control plane's front door: the OAuth 2.1 AS around `app` — `/token`, `/register`, the
 *  `.well-known` documents and the bearer check on `/mcp` are the provider's; everything else falls
 *  through to `app`. */
export const controlPlane: Handler = new OAuthProvider<Env>({
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
