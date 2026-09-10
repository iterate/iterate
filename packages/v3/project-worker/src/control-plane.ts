// control-plane.ts — THE CONTROL PLANE, in-process behind the project worker's front door (worker.ts
// keeps the project hosts, /api, /version, the static assets and delegates everything else to
// `controlPlane`). Three concepts, one file; the schema is control-plane.sql; the session cookie it
// sets is verified in principal.ts beside every other credential:
//   directory — `directory(db)`: ONE D1 store, users → orgs → projects — the control plane IS the
//               directory, and `Reach` is its word for what a session may touch
//   mcp       — `mcpHandler`: /mcp, the ONE MCP server for every project — the only OAuth-protected boundary
//   app       — `controlPlane`: the OAuth 2.1 AS wrapper around THE CONSOLE — a TanStack Start app
//               (src/routes/**: login, the account page, the /authorize consent) whose server
//               functions call this file's console half, plus its machine doors (form POSTs)

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import {
  AuthorizationError,
  OAuthProvider,
  type OAuthHelpers,
  type ResolveExternalTokenInput,
  type ResolveExternalTokenResult,
} from "@cloudflare/workers-oauth-provider";
import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { codedError, errorCode, isSameOriginBrowserRequest } from "./lib.ts";
import { appConfigOf, sameOriginPath } from "./worker.ts";
import {
  clearSessionCookie,
  setSessionCookie,
  signProjectToken,
  verifySessionCookie,
  type Principal,
  type SessionCookieClaims,
} from "./principal.ts";
import { verifyCredentials, type SessionCredentials, type SessionPrincipal } from "./session.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import type { Env as DurableObjectEnv } from "./iterate-context-durable-object.ts";
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
 *  control-plane user (the cookie, the admin's `as`, a grant with nothing to choose from); the
 *  projects named outright for a project token or the project secret (one) and for an OAuth grant
 *  (the consent's choice — none chosen is bound to none). */
export type Reach = "every" | { userId: string } | { projectIds: string[] };

/** THE ONE RULE for what a principal reaches (`Reach`) — session.ts `authenticate` and `/mcp`
 *  (`buildServer`) both ask it. THE BINDING FIRST: a principal bound to projects — a session's
 *  `projectId` (a project token's, the project secret's), an `/mcp` grant's `projects` (the
 *  consent's choice; a token's or a secret's one through `resolveExternalToken`) — reaches exactly
 *  those, whoever it is: a project token the admin minted reaches its one project, never every.
 *  Unbound, the admin secret's `{ actor: "admin" }` reaches every project and a user (the cookie,
 *  the admin's `as` — `user_<email>`, never `admin`) the projects of their orgs. */
export function reachOf(principal: SessionPrincipal | McpProps): Reach {
  if ("projects" in principal && principal.projects) return { projectIds: principal.projects };
  if ("projectId" in principal && principal.projectId !== undefined)
    return { projectIds: [principal.projectId] };
  return principal.actor === "admin" ? "every" : { userId: principal.actor };
}

/** `reach`, for a refusal's message (session.ts `projects.get`, `createProject`). */
export const describeReach = (reach: Reach): string =>
  reach === "every"
    ? "every project"
    : "userId" in reach
      ? `the projects of the orgs ${reach.userId} belongs to`
      : `bound to ${reach.projectIds.map((projectId) => JSON.stringify(projectId)).join(", ") || "no project"}`;

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
     *  then re-selected to cover both "just created" and "already existed"). Both create-a-project
     *  doors — `projects.create` over /api and the console's form — are this. */
    async createProject(reach: Reach, name: string): Promise<Project> {
      if (typeof reach === "object" && "projectIds" in reach)
        throw codedError(
          "FORBIDDEN",
          `this session is ${describeReach(reach)} — creating a project needs a signed-in user or the admin secret`,
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
// (@modelcontextprotocol/server) mounts here with three tools; `itx.invoke` runs an expression
// through a named project's context IN-PROCESS under the bearer's principal (the DO's `invokeAs`),
// so MCP is not a parallel capability API: a tool call reaches what an expression reaches, for any
// project the bearer names. The project is resolved as apps/os's `resolveToolProject` does:
// optional when the bearer reaches exactly one, required for the admin secret, refused outside the
// grant. No tool creates a project: a project is created on the console or over `/api`
// (`projects.create`) — a bearer that chose its projects at consent is bound to them.

/** What the provider puts on `ctx.props` once the bearer is validated — WHO the tools act as (the
 *  principal `invokeAs` stamps on every event) and WHICH projects they reach, `reachOf`'s answer:
 *  `projects` names them outright and binds the bearer to them whoever it is — an OAuth grant's,
 *  chosen at consent (`authorize`); a project secret's or a project token's one
 *  (`resolveExternalToken`, the admin's own token included); absent — a user who had no project to
 *  choose from — the projects of the user's orgs, read per call; the admin secret's
 *  `{ actor: "admin" }` reaches every project, so its tool calls must name one. */
type McpProps = Principal & { projects?: string[] };

/** The project a tool call runs in (apps/os `resolveToolProject`): `project`, when named, is a
 *  project — a context name is refused, as `projects.get` refuses it (session.ts): the expression
 *  reaches the project's other contexts through `itx.cd(path)` — and must be within the grant;
 *  omitted, it is the one project the bearer reaches — the admin secret reaches every project, so
 *  it must name one. */
async function projectOfToolCall(
  d1Directory: Directory,
  reach: Reach,
  requested: string,
): Promise<string> {
  if (requested) {
    const { projectId, path } = DurableObjectNameCodec.parse(requested);
    if (path !== "/")
      throw new Error(
        `project: got a context name ${JSON.stringify(requested)} — pass the project and cd(path) in the expression`,
      );
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
/** A tool's input schema as `fromJsonSchema` takes it — the SDK's own JSON-Schema type. */
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

// ── app ── THE CONTROL PLANE, mounted IN-PROCESS as the project worker's front-door catch-all
// (src/worker.ts keeps the project hosts, /api, /version and the static assets, and delegates
// everything else to `controlPlane` below). The whole handler is wrapped in an OAuth 2.1
// Authorization Server whose routing is the library's; the AS owns only a thin edge — /oauth/token,
// /oauth/register, the .well-known metadata, and the bearer check on /mcp (the mcp section).
// EVERYTHING ELSE (login, session, the account page, the /authorize consent, project creation) falls
// through to THE CONSOLE: a TanStack Start app — src/routes/** are its screens, SSR'd here through
// the Start server entry, and their server functions call the functions of this section — with THE
// MACHINE DOORS beside it (`consoleDoor`): the same four actions as plain form POSTs, /login /logout
// /projects /authorize, for a script, the lanes, a `page.request.post` (a server function's URL is
// the build's, `/_serverFn/<id>`). The consent page reuses the same session and grants the client the
// USER on the projects they check — what /mcp acts as. No first-party surface is ever an OAuth
// client; they all just carry the session cookie.
//
//   • first-party surfaces  → session cookie via the console   (0 OAuth clients)
//   • external MCP clients  → OAuth on /mcp, self-describing via CIMD  (0 hand-registered clients)

/** THE ONE WORKER's bindings: the DO's (`iterate-context-durable-object.ts` `Env` — `ITERATE_CONTEXT`,
 *  where `/mcp`'s `itx.invoke` and the account page's app listing run an expression in-process
 *  through the named project's root context; `SECRETS_KV`, where a project's API-key hash sits for
 *  the project-secret bearer; the `APP_CONFIG_*` vars `appConfigOf(env)` parses) plus the control
 *  plane's own below. src/worker.ts is typed on this. `OAUTH_PROVIDER` is injected by the
 *  OAuthProvider wrapper at request time. */
export interface Env extends DurableObjectEnv {
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
export function consoleSessionOf(env: Env, request: Request): Promise<SessionCookieClaims | null> {
  return verifySessionCookie(request.headers.get("cookie"), appConfigOf(env).sessionSecret);
}

/** The session, or the coded refusal an action throws with none (the `_auth` layout redirects before a
 *  page loads; a function called with a cookie that expired meanwhile lands here). */
async function requireConsoleSession(env: Env, request: Request): Promise<SessionCookieClaims> {
  const session = await consoleSessionOf(env, request);
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
  projects: (Project & {
    /** The project's apex host through `/.itx/session?token=`: a project token for this user, good
     *  for 15 minutes, becomes the host-scoped cookie there (worker.ts `projectSessionResponse`).
     *  Null where no project hosts exist (a blank hostname base — the workers lane). */
    open: string | null;
    /** The same door on each app host `<label>--<project>.<base>` — a `__Host-` cookie is its host's
     *  alone, so every host signs in through its own door. */
    apps: { label: string; open: string }[];
  })[];
}

export async function accountOf(env: Env, request: Request): Promise<Account> {
  const session = await requireConsoleSession(env, request);
  const d1Directory = directory(env.DB);
  const [orgs, projects] = await Promise.all([
    d1Directory.listOrgs(session.sub),
    d1Directory.listProjects(session.sub),
  ]);
  const { projectTokenSecret, projectHostnameBase } = appConfigOf(env);
  const { protocol, port } = new URL(request.url); // the deployment's scheme and port (a local worker's, too)
  const principal: Principal = { actor: session.sub, email: session.email };
  const rows = await Promise.all(
    projects.map(async (project) => {
      if (!projectHostnameBase) return { ...project, open: null, apps: [] };
      const token = await signProjectToken(
        { projectId: project.id, ...principal },
        15 * 60_000,
        projectTokenSecret,
      );
      const door = (host: string) =>
        `${protocol}//${host}.${projectHostnameBase}${port ? `:${port}` : ""}/.itx/session?token=${encodeURIComponent(token)}&next=/`;
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
export async function createProjectFor(env: Env, request: Request, name: string): Promise<Project> {
  const session = await requireConsoleSession(env, request);
  return directory(env.DB).createProject({ userId: session.sub }, name);
}

/** What the consent page shows, or where the browser goes instead. */
export type Consent =
  /** The consent: the client, the user, THE PROJECT SELECTION (their projects, offered all checked). */
  | { kind: "consent"; query: string; clientName: string; email: string; projects: Project[] }
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

/** The consent (src/routes/_auth/authorize.tsx): the provider parses the request, the client is
 *  named, the user's projects are offered. */
export async function consentOf(env: Env, request: Request, query: string): Promise<Consent> {
  const session = await requireConsoleSession(env, request);
  let oauthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(authorizeRequest(request, query));
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
    projects: await directory(env.DB).listProjects(session.sub),
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
  const session = await requireConsoleSession(env, request);
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(authorizeRequest(request, query));
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const projects = await directory(env.DB).listProjects(session.sub);
  const checked = new Set(chosen);
  const granted = projects.filter((p) => checked.has(p.id)).map((p) => p.id);
  return env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: session.sub,
    metadata: { clientName: client?.clientName ?? oauthRequest.clientId },
    scope: ["project"],
    props: {
      actor: session.sub,
      email: session.email,
      ...(projects.length > 0 && { projects: granted }),
    } satisfies McpProps,
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

/** THE MACHINE DOORS: the console's four actions as plain form POSTs — /login (email, next), /logout,
 *  /projects (slug), /authorize?<the OAuth query> (project, repeated) — each the very function the
 *  route's server function calls, answered as a form post is: a 302 on success (the session cookie
 *  set or cleared on it), a text refusal otherwise. Null for anything else: the console's. */
async function consoleDoor(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const { pathname, search } = new URL(request.url);
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
  if (pathname === "/logout") return redirectResponse("/", { "set-cookie": signOut() });
  if (pathname === "/projects") {
    // The console's form. A program creates projects over /api — `authenticate().projects.create`
    // (src/session.ts) — the same directory door.
    if (!(await consoleSessionOf(env, request))) return redirectResponse("/"); // no session: back to sign in
    const slug = String((await request.formData()).get("slug") ?? "");
    if (!slugify(slug)) return redirectResponse("/");
    try {
      await createProjectFor(env, request, slug);
      return redirectResponse("/");
    } catch (error) {
      return new Response(`409: ${message(error)}\n`, { status: 409 }); // a name another org holds — the visitor's problem, not a 500
    }
  }
  if (pathname === "/authorize") {
    if (!(await consoleSessionOf(env, request)))
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
const consoleHandler: Handler = {
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

/** The control plane's front door: the OAuth 2.1 AS around the console — `/oauth/token`,
 *  `/oauth/register`, the `.well-known` documents and the bearer check on `/mcp` are the provider's;
 *  everything else falls through to `consoleHandler`. ONE resource, pinned: `<origin>/mcp`, the
 *  provider its own authorization server — every token is bound to it and a foreign one refused. The
 *  provider wants that resource as an absolute URL at construction, and the platform's origin is the
 *  request's (`https://project-worker.iterate.workers.dev`, the custom hostname,
 *  `http://localhost:<port>` in the local lanes), so the provider is built per request from
 *  `new URL(request.url).origin` — its constructor only checks its options. An issuer must be https
 *  (RFC 8414; the provider refuses another), so on an http origin — a local lane — the provider
 *  carries no resource document: the console, the login and the bearer check still serve, and no
 *  token binds to a resource. */
export const controlPlane: Handler = {
  fetch(request, env, ctx) {
    const { origin, protocol } = new URL(request.url);
    return new OAuthProvider<Env>({
      apiRoute: "/mcp", // the ONLY OAuth-protected boundary
      apiHandler: mcpHandler,
      defaultHandler: consoleHandler, // login + session + /authorize consent + the account page
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
