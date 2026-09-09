// control-plane.ts — THE CONTROL PLANE, in-process behind the project worker's front door (worker.ts
// keeps /api, /expression, /version, /demo and delegates everything else to `controlPlane`). Three
// concepts, one file; the schema is control-plane.sql; the session cookie it sets is verified in
// principal.ts beside every other credential:
//   directory — `directory(db)`: ONE D1 store, users → orgs → projects — the control plane IS the
//               directory, and `Reach` is its word for what a session may touch
//   mcp       — `mcpHandler`: /mcp, the ONE MCP server for every project — the only OAuth-protected boundary
//   app       — `controlPlane`: the OAuth 2.1 AS wrapper around the first-party pages (login, console, /authorize)

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import {
  AuthorizationError,
  OAuthProvider,
  type OAuthHelpers,
  type ResolveExternalTokenInput,
  type ResolveExternalTokenResult,
} from "@cloudflare/workers-oauth-provider";
import { codedError, errorCode, isSameOriginBrowserRequest } from "./lib.ts";
import { appConfigOf, type AppConfigEnv, sameOriginPath } from "./worker.ts";
import {
  clearSessionCookie,
  setSessionCookie,
  signProjectToken,
  verifySessionCookie,
  type Principal,
  type SessionCookieClaims,
} from "./principal.ts";
import { verifyCredentials, type SessionCredentials } from "./session.ts";
import { DurableObjectNameCodec, type IterateContextNamespace } from "./iterate-context.ts";
import {
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
} from "./context/expression.ts";

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
const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The projects a session may touch — what its credential earned (session.ts `authenticate`, the
 *  `/mcp` grant): `"every"` for the admin secret; the projects of the orgs `userId` belongs to for a
 *  control-plane user (the cookie, the admin's `as`, a grant that chose nothing); the projects named
 *  outright for a project token or the project secret (one) and for an OAuth grant (the consent's
 *  choice). */
export type Reach = "every" | { userId: string } | { projectIds: string[] };

/** `org_<32hex>`. */
const newOrgId = () => `org_${crypto.randomUUID().replaceAll("-", "")}`;

export function directory(db: D1Database) {
  const d1Directory = {
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

    /** Create the project `name` (slugified: that IS its id, GLOBALLY unique) for `reach` — in the
     *  user's first org by name, created as `<email>'s org` with them as owner when they have none;
     *  in the deployment's own org for the admin secret. A reach that names its projects (a token,
     *  the secret, a grant that chose) creates none: FORBIDDEN. A name already taken in ANY org is
     *  PROJECT_NAME_TAKEN; the same org's again is idempotent (the insert is ON CONFLICT DO NOTHING,
     *  then re-selected to cover both "just created" and "already existed"). Every create-a-project
     *  door — `projects.create` over /api, the console's form, /mcp's `create_project` — is this. */
    async createProject(reach: Reach, name: string): Promise<Project> {
      if (typeof reach === "object" && "projectIds" in reach)
        throw codedError(
          "FORBIDDEN",
          `this session is bound to ${reach.projectIds.map((projectId) => JSON.stringify(projectId)).join(", ") || "no project"} — creating a project needs a signed-in user or the admin secret`,
        );
      const id = slugify(name);
      if (!id) throw new Error("project name is empty or invalid");
      const org =
        reach === "every"
          ? await d1Directory.adminOrg()
          : await d1Directory.ensureOrg(reach.userId);
      await db
        .prepare(
          `INSERT INTO projects (id, org_id) VALUES (?, ?)
ON CONFLICT DO NOTHING;`,
        )
        .bind(id, org.id)
        .run();
      const project = await d1Directory.getProject(id);
      if (!project) throw new Error(`failed to create project '${id}'`);
      if (project.orgId !== org.id)
        throw codedError("PROJECT_NAME_TAKEN", `project name '${id}' is already taken`);
      return project;
    },

    /** The user's first org — created as `<email>'s org`, with them as owner, when they have none
     *  yet (the row `/login` or the admin's `as` upserted names the email). */
    async ensureOrg(userId: string): Promise<Org> {
      const orgs = await d1Directory.listOrgs(userId);
      if (orgs[0]) return orgs[0];
      const user = await db
        .prepare(`SELECT id, email FROM users WHERE id = ?;`)
        .bind(userId)
        .first<User>();
      return d1Directory.createOrg(userId, `${user!.email}'s org`);
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

    /** EVERY project in the directory, no role — the admin secret's catalog. */
    async listAllProjects(): Promise<Project[]> {
      const { results } = await db
        .prepare(`SELECT id, org_id AS orgId FROM projects ORDER BY id ASC;`)
        .all<Project>();
      return results;
    },

    /** The projects `reach` reaches, as directory rows: every project for the admin secret; the
     *  user's, with their role; the named ones (their rows — a name the directory never heard of
     *  is no row). */
    async reachableProjects(reach: Reach): Promise<Project[]> {
      if (reach === "every") return d1Directory.listAllProjects();
      if ("userId" in reach) return d1Directory.listProjects(reach.userId);
      const rows = await Promise.all(
        reach.projectIds.map((projectId) => d1Directory.getProject(projectId)),
      );
      return rows.filter((row): row is Project => row !== null);
    },

    /** Whether `reach` reaches `projectId` — the admission behind `projects.get` (session.ts) and a
     *  `/mcp` tool's `project`. The admin reaches a project the directory never heard of (the door
     *  is the admin's); a named reach is its list; a user's is one membership read. */
    async reachesProject(reach: Reach, projectId: string): Promise<boolean> {
      if (reach === "every") return true;
      if ("projectIds" in reach) return reach.projectIds.includes(projectId);
      return (await d1Directory.listProjects(reach.userId)).some(
        (project) => project.id === projectId,
      );
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

  return d1Directory;
}

/** The directory as the edge holds it (src/session.ts). */
export type Directory = ReturnType<typeof directory>;

// ── mcp ── /mcp: the ONE MCP server, for every project — the only OAuth-protected boundary. The
// provider validated the bearer BEFORE this runs and put the granted props on ctx.props: an OAuth
// access token's (the user and the projects chosen at consent — `authorize`, the app section below)
// or, through `resolveExternalToken`, the admin secret's or a project secret's. An MCP server
// (@modelcontextprotocol/server) mounts here with four tools; `itx.invoke` runs an expression
// through a named project's context IN-PROCESS under the bearer's principal (the DO's `invokeAs`),
// so MCP is not a parallel capability API: a tool call reaches what an expression reaches, for any
// project the bearer names. The project is resolved as apps/os's `resolveToolProject` does:
// optional when the bearer reaches exactly one, required for the admin secret, refused outside the
// grant.

/** What the provider puts on `ctx.props` once the bearer is validated — WHO the tools act as (the
 *  principal `invokeAs` stamps on every event) and WHICH projects they reach: `projects` names them
 *  outright — an OAuth grant's, chosen at consent (`authorize`); a project secret's or a project
 *  token's one (`resolveExternalToken`); absent — a grant older than project selection, or a user
 *  who had no project to choose from — the projects of the user's orgs, read per call; the admin
 *  secret's `{ actor: "admin" }` reaches every project, so its tool calls must name one. */
type McpProps = Principal & { projects?: string[] };

/** The projects `props` reaches (`Reach`, the directory's word). */
const reachOf = (props: McpProps): Reach =>
  props.actor === "admin"
    ? "every"
    : props.projects
      ? { projectIds: props.projects }
      : { userId: props.actor };

/** The project a tool call runs in (apps/os `resolveToolProject`): `project`, when named, must be
 *  within the grant (the name checked by the codec); omitted, it is the one project the bearer
 *  reaches — the admin secret reaches every project, so it must name one. */
async function projectOfToolCall(
  d1Directory: Directory,
  reach: Reach,
  requested: string,
): Promise<string> {
  if (requested) {
    const { projectId } = DurableObjectNameCodec.parse(requested);
    if (!(await d1Directory.reachesProject(reach, projectId)))
      throw new Error(`project ${JSON.stringify(requested)} is outside this token's grant`);
    return projectId;
  }
  if (reach === "every") throw new Error("the admin secret reaches every project — pass project");
  const reachable = (await d1Directory.reachableProjects(reach)).map((project) => project.id);
  if (reachable.length === 1) return reachable[0]!;
  throw new Error(
    reachable.length
      ? `pass project — this token reaches ${reachable.join(", ")}`
      : "this token reaches no project",
  );
}

/** The tool's expression as ONE expression for `invokeAs`: either codec half normalized (a string
 *  parsed, an array shape-checked — refused in the parser's words), rooted at `itx`, with `args`
 *  appended to its terminal call — a terminal NAME becomes that call: `itx.kv.get` + `["k"]` is
 *  `itx.kv.get("k")`. */
function itxExpressionWithArgs(input: ItxExpressionInput, args: unknown[]): ItxExpression {
  const expression = normalizedItxExpression(input);
  const [root, ...steps] = expression;
  if (root !== "itx")
    throw new Error(`an itx expression is rooted at itx, not ${JSON.stringify(root)}`);
  const last = steps.at(-1);
  if (args.length === 0 || last === undefined) return expression;
  return [
    "itx",
    ...steps.slice(0, -1),
    typeof last === "string" ? [last, ...args] : [...last, ...args],
  ];
}

const validator = new CfWorkerJsonSchemaValidator();
type JsonSchema = Parameters<typeof fromJsonSchema>[0];
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  fromJsonSchema(
    { type: "object", properties, required, additionalProperties: false } as JsonSchema,
    validator,
  );
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError,
});
/** A tool FAILURE as the protocol's own channel — an `isError` result, never a thrown error and
 *  never a 500 — its text led by the platform's CODE when the error carries one (lib.ts —
 *  `NO_ITX_EXPRESSION_MATCH`, `INVALID_CONTEXT`, …), the machine-readable channel a client
 *  classifies by, then the message. */
const failure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return textResult(code ? `${code}: ${message}` : message, true);
};

const PROJECT_INPUT = {
  type: "string",
  description:
    "The project (its id/slug). Optional when this token reaches exactly one; required for the admin secret.",
};

function buildServer(env: Env, props: McpProps): McpServer {
  const d1Directory = directory(env.DB);
  const reach = reachOf(props);
  const mcpServer = new McpServer({ name: "control-plane", version: "0.1.0" });

  mcpServer.registerTool(
    "whoami",
    {
      description:
        "Who this token authenticates as and which projects it reaches: the user and the projects chosen at authorization; the admin secret (every project); a project token (its one project); a project secret (its one project — the secret names it with ?project=<id> on the /mcp URL).",
      inputSchema: objectSchema({}),
    },
    async () => textResult(JSON.stringify(props, null, 2)),
  );

  mcpServer.registerTool(
    "list_projects",
    {
      description: "List the projects this token reaches (the admin secret: every project).",
      inputSchema: objectSchema({}),
    },
    async () => {
      const projects = await d1Directory.reachableProjects(reach);
      return textResult(
        projects.length
          ? projects
              .map(
                (project) =>
                  `${project.id}  (org ${project.orgId}${project.role ? `, ${project.role}` : ""})`,
              )
              .join("\n")
          : "(none yet)",
      );
    },
  );

  mcpServer.registerTool(
    "create_project",
    {
      description:
        "Create a project in your first org (creating that org if you have none; the admin secret's land in the deployment's own org) and return it. A token bound to named projects — a grant that chose projects at authorization, a project secret, a project token — creates none: authorize again with nothing chosen, or create over /api.",
      inputSchema: objectSchema({ project: { type: "string" } }, ["project"]),
    },
    async (raw: unknown) => {
      const toolArguments = raw as { project?: string };
      try {
        const name = String(toolArguments.project ?? "").trim();
        if (!name) return textResult("create_project needs a project name", true);
        const project = await d1Directory.createProject(reach, name);
        return textResult(`created project '${project.id}' in org '${project.orgId}'`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  mcpServer.registerTool(
    "itx.invoke",
    {
      title: "Invoke itx",
      description:
        "Evaluate one itx expression in a project's context, exactly as itx evaluates it (through the project's rewrite rules), under this token's principal: a dotted string such as itx.kv.get('k'), or its parsed form; args are appended to the terminal call. Returns the result as JSON.",
      inputSchema: objectSchema(
        {
          project: PROJECT_INPUT,
          expression: {
            description:
              'An itx expression: a dotted string such as itx.kv.get(\'k\') or itx.append({ type: \'note\' }) (call args are JSON5), or its parsed form ["itx","kv",["get","k"]] for anything large.',
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", minItems: 1 },
            ],
          },
          args: {
            type: "array",
            description:
              "Appended to the expression's terminal call (a terminal name becomes that call) — an argument that is awkward to spell inline rides here as plain JSON.",
          },
        },
        ["expression"],
      ),
    },
    async (raw: unknown) => {
      const toolArguments = raw as {
        project?: string;
        expression: ItxExpressionInput;
        args?: unknown[];
      };
      const { projects: _grantedProjects, ...principal } = props; // the stamp is the principal, never its grant
      try {
        const projectId = await projectOfToolCall(
          d1Directory,
          reach,
          toolArguments.project?.trim() ?? "",
        );
        const value = await env.ITERATE_CONTEXT.getByName(
          DurableObjectNameCodec.stringify({ projectId, path: "/" }),
        ).invokeAs(
          principal,
          itxExpressionWithArgs(toolArguments.expression, toolArguments.args ?? []),
        );
        // THE JSON BOUNDARY: a round trip drops what JSON cannot carry (undefined members, a
        // function-valued handle's members) and throws on what it refuses (a cycle, a BigInt).
        const json = JSON.stringify(value) ?? "null";
        return {
          content: [{ type: "text" as const, text: json }],
          structuredContent: { result: JSON.parse(json) as unknown },
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return mcpServer;
}

const mcpHandler: Handler = {
  async fetch(request, env, ctx) {
    const { props } = ctx as ExecutionContext & { props: McpProps };
    // A fresh handler per request under the default response mode (`auto`: one JSON body unless a
    // notification precedes the result — these tools emit none). Not `responseMode: "json"`: the
    // SDK `console.warn`s on every handler built that way, which here would be every request.
    return createMcpHandler(() => buildServer(env, props)).fetch(request);
  },
};

/** The provider's hook for a bearer on /mcp that is not one of its own tokens — the platform's
 *  credentials, tried as `/api` and the lanes try them (session.ts `verifyCredentials`): a project
 *  token (its one project), the deployment's admin secret (`{ actor: "admin" }`, every project), a
 *  project secret for the project `?project=` names on the request URL (that one project). Each is
 *  a first-party credential consumed at this resource, so the result is bound to it (`audience`)
 *  like every provider token. Anything else is null: the provider's 401. */
async function resolveExternalToken({
  token,
  request,
  env,
}: ResolveExternalTokenInput): Promise<ResolveExternalTokenResult | null> {
  const bindings = env as Env;
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const candidates: SessionCredentials[] = [
    { type: "project-token", token },
    { type: "admin-secret", secret: token },
    ...(project ? [{ type: "project-secret" as const, project, secret: token }] : []),
  ];
  const input = {
    request,
    directory: directory(bindings.DB),
    appConfig: appConfigOf(bindings),
    secretsKv: bindings.SECRETS_KV,
  };
  for (const credentials of candidates) {
    const sessionPrincipal = await verifyCredentials(credentials, input);
    if (!sessionPrincipal) continue;
    const { projectId, ...principal } = sessionPrincipal;
    return {
      props: {
        ...principal,
        ...(projectId !== undefined && { projects: [projectId] }),
      } satisfies McpProps,
      audience: `${url.origin}/mcp`,
    };
  }
  return null;
}

// ── app ── THE CONTROL PLANE, mounted IN-PROCESS as the project worker's front-door catch-all (src/worker.ts
// keeps /api, /expression, /version, /demo and delegates everything else to `controlPlane` below).
// The whole handler is wrapped in an OAuth 2.1 Authorization Server whose routing is the library's;
// the AS owns only a thin edge — /oauth/token, /oauth/register, the .well-known metadata, and the
// bearer check on /mcp (the mcp section). EVERYTHING ELSE (login, session, console, /authorize
// consent, project creation) falls through to `app`, the FIRST-PARTY world: the login form, the
// session, the home page/console, and the OAuth /authorize consent page (which reuses the same
// session and grants the client the USER on the projects they check — what /mcp acts as). No
// first-party surface is ever an OAuth client; they all just carry the session cookie.
//
//   • first-party surfaces  → session cookie via `app`   (0 OAuth clients)
//   • external MCP clients  → OAuth on /mcp, self-describing via CIMD  (0 hand-registered clients)

/** The control plane's bindings — a slice of the one worker's env (src/worker.ts intersects it with the
 *  DO's `Env`). Its configuration (the session and admin secrets) is the worker's, through
 *  `appConfigOf(env)` (src/worker.ts). `OAUTH_PROVIDER` is injected by the OAuthProvider wrapper at
 *  request time. */
export interface Env extends AppConfigEnv {
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The directory: users, orgs, org_members, projects (control-plane.sql). Strongly consistent (D1). */
  DB: D1Database;
  /** Injected by the provider — the OAuth helper surface (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
  /** The context namespace — where `/mcp`'s `itx.invoke` runs an expression, in-process, through
   *  the named project's root context (`invokeAs`). */
  ITERATE_CONTEXT: IterateContextNamespace;
  /** The per-project secret store — where a project's API-key hash sits (principal.ts
   *  `verifyProjectSecret`, the project-secret bearer on `/mcp`). */
  SECRETS_KV: KVNamespace;
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

/** A console page — never cached: every one is the visitor's own (the session, the consent). */
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
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
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

async function home(env: Env, session: SessionCookieClaims): Promise<Response> {
  const d1Directory = directory(env.DB);
  const [orgs, projects] = await Promise.all([
    d1Directory.listOrgs(session.sub),
    d1Directory.listProjects(session.sub),
  ]);
  const orgList = orgs.length
    ? `<ul>${orgs.map((o) => `<li>${esc(o.name)} <span class="muted">(${esc(o.role ?? "")})</span></li>`).join("")}</ul>`
    : `<p class="muted">No orgs yet.</p>`;
  // Each project links to its own host through `/.itx/session`: a project token for this user,
  // good for 15 minutes, becomes the host-scoped cookie there (worker.ts `projectSessionResponse`).
  // Only where project hosts exist: a hostname base (the workers lane has none).
  const { projectTokenSecret, projectHostnameBase } = appConfigOf(env);
  const projectHostLink = async (p: Project): Promise<string> => {
    if (!projectHostnameBase) return "";
    const token = await signProjectToken(
      { projectId: p.id, actor: session.sub, email: session.email },
      15 * 60_000,
      projectTokenSecret,
    );
    return ` <a href="https://${esc(p.id)}.${esc(projectHostnameBase)}/.itx/session?token=${encodeURIComponent(token)}&amp;next=/">open</a>`;
  };
  const projectRows = await Promise.all(
    projects.map(
      async (p) =>
        `<li><code>${esc(p.id)}</code> <span class="muted">in ${esc(p.orgId)}</span>${await projectHostLink(p)}</li>`,
    ),
  );
  const projList = projects.length
    ? `<ul>${projectRows.join("")}</ul>`
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

/** The OAuth /authorize consent page — reuses the session and is THE PROJECT SELECTION: the user's
 *  projects as checkboxes, all checked; approving grants the client the USER on the checked ones
 *  (`props.actor` / `props.email` / `props.projects`, what every /mcp tool acts within). The checked
 *  ids are intersected with the directory's — the door's membership check; a user with no project
 *  to choose from grants a `projects`-less grant, which follows their membership (`McpProps`). The
 *  provider reads the OAuth parameters off the URL, so the POST's body is this form's alone. A
 *  request the provider refuses (`AuthorizationError`) is answered as the provider's README says:
 *  sent back to the client with `error`, `error_description`, `state` and `iss` when the client and
 *  its redirect URI validated (`redirectUri` present), rendered here when they did not. */
async function authorize(
  request: Request,
  env: Env,
  session: SessionCookieClaims | null,
): Promise<Response> {
  let oauthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri)
      return page(
        "Invalid request",
        `<h1>Invalid authorization request</h1><p>${esc(error.description)}</p>`,
      );
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const clientName = client?.clientName ?? oauthRequest.clientId;

  // No session → show the login form; on success it returns here (next = this authorize URL).
  if (!session) {
    return page("Sign in", loginForm(request.url, `to authorize ${clientName}`));
  }
  const projects = await directory(env.DB).listProjects(session.sub);

  // POST (approve): mint the grant as the user, on the projects they checked.
  if (request.method === "POST") {
    const checked = new Set((await request.formData()).getAll("project").map(String));
    const granted = projects.filter((p) => checked.has(p.id)).map((p) => p.id);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: session.sub,
      metadata: { clientName },
      scope: ["project"],
      props: {
        actor: session.sub,
        email: session.email,
        ...(projects.length > 0 && { projects: granted }),
      } satisfies McpProps,
    });
    return Response.redirect(redirectTo, 302);
  }

  const choice = projects.length
    ? projects
        .map(
          (p) =>
            `<label><input type="checkbox" name="project" value="${esc(p.id)}" checked> <code>${esc(p.id)}</code> <span class="muted">in ${esc(p.orgId)}</span></label>`,
        )
        .join("\n")
    : `<p class="muted">No projects yet — every project you join is reachable.</p>`;
  return page(
    "Authorize",
    `<h1>Authorize ${esc(clientName)}</h1>
<p><strong>${esc(clientName)}</strong> wants to connect as <strong>${esc(session.email)}</strong>.</p>
<form method="post" action="${esc(request.url)}">
<fieldset><legend>Projects it may reach</legend>
${choice}
</fieldset>
<button type="submit">Approve</button></form>
<form method="post" action="/logout"><button>Switch account</button></form>`,
  );
}

/** The provider's default handler — everything that is NOT the OAuth token/metadata endpoints or the
 *  /mcp API route. Every door that ACTS is a POST, and a POST from a foreign origin is 403: a
 *  browser stamps the page's origin on a form post, so a foreign one is another site driving the
 *  visitor's session cookie (the login form, the consent, the project form; a script's POST carries
 *  no Origin and passes). `/logout` is a POST like the rest — a GET cannot end a session. */
const app: Handler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && !isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot act on this session\n", {
        status: 403,
      });
    const { sessionSecret } = appConfigOf(env);
    const session = await verifySessionCookie(request.headers.get("cookie"), sessionSecret);
    const d1Directory = directory(env.DB);

    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const email = String(form.get("email") ?? "").trim();
      const next = String(form.get("next") ?? "/");
      if (!email) return page("Sign in", loginForm(next, "Enter an email."));
      const user = await d1Directory.upsertUser(email);
      const cookie = await setSessionCookie(
        { sub: user.id, email: user.email, iat: Math.floor(Date.now() / 1000) },
        sessionSecret,
      );
      return new Response(null, {
        status: 302,
        headers: { location: sameOriginPath(next, url.origin), "set-cookie": cookie },
      });
    }

    if (url.pathname === "/logout" && request.method === "POST") {
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
      const slug = String((await request.formData()).get("slug") ?? "");
      if (!slugify(slug)) return back;
      try {
        await d1Directory.createProject({ userId: session.sub }, slug);
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
      return session ? home(env, session) : page("Sign in", loginForm("/"));
    }

    return new Response("Not found", { status: 404 });
  },
};

/** The control plane's front door: the OAuth 2.1 AS around `app` — `/oauth/token`, `/oauth/register`,
 *  the `.well-known` documents and the bearer check on `/mcp` are the provider's; everything else
 *  falls through to `app`. ONE resource, pinned: `<origin>/mcp`, the provider its own authorization
 *  server — every token is bound to it and a foreign one refused. The provider wants that resource
 *  as an absolute URL at construction, and the platform's origin is the request's
 *  (`https://project-worker.iterate.workers.dev`, the custom hostname, `http://localhost:<port>` in
 *  the local lanes), so the provider is built per request from `new URL(request.url).origin` — its
 *  constructor only checks its options. An issuer must be https (RFC 8414; the provider refuses
 *  another), so on an http origin — a local lane — the provider carries no resource document: the
 *  console, the login and the bearer check still serve, and no token binds to a resource. */
export const controlPlane: Handler = {
  fetch(request, env, ctx) {
    const { origin, protocol } = new URL(request.url);
    return new OAuthProvider<Env>({
      apiRoute: "/mcp", // the ONLY OAuth-protected boundary
      apiHandler: mcpHandler,
      defaultHandler: app, // login + session + /authorize consent + console
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register", // DCR — the spec-sanctioned MAY-fallback: a client with no CIMD document (Cursor; a client on an http origin, which CIMD cannot serve)
      scopesSupported: ["project"],
      ...(protocol === "https:" && {
        resourceMetadata: {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["project"],
        },
      }),
      clientIdMetadataDocumentEnabled: true, // CIMD — clients register themselves by URL (the `global_fetch_strictly_public` flag, wrangler.jsonc)
      allowPlainPKCE: false, // OAuth 2.1: S256 only
      resolveExternalToken, // a project token, the admin secret, a project secret
    }).fetch(request, env, ctx);
  },
};
