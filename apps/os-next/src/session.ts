// Public /api starts with an authorized Session. Only /internal/rpc exposes the
// administrator gate. Sessions vend project contexts and own their teardown.

import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { IterateApi } from "iterate/next/api";
import { codedError } from "iterate/next/lib";
import { verifyAdminSecret, type Caller, type Principal } from "iterate/next/principal";
import type { StreamEventInput } from "iterate/next/stream/processor";
import type { Consent } from "./consent.ts";
import type { Grants } from "./grants.ts";
import {
  DurableObjectNameCodec,
  GLOBAL_PROJECT_ID,
  IterateContextRpcTarget,
  type IterateContextNamespace,
  type WaitUntil,
} from "./iterate-context.ts";
import { describeReach, type Directory, type Project, type Reach } from "./directory.ts";
import type { AppConfig } from "./app-config.ts";
import type { AuthenticationFact } from "./account/contract.ts";

/** A project as a caller names it: its minted id (`prj_<hex>`) or its slug (a URL's
 *  `/projects/<slug>`, a hostname's label) — the directory resolves either (`projectIdOf`), and the
 *  id alone goes on: the DO name's host, a grant's list, `whoami()`. */
export type ProjectRef = string;

/** What `IterateRpcTarget.authenticate` accepts. `from-server-cookie` is the browser and `bearer` is
 *  a device or script whose token rode the upgrade: the OAuth gate already resolved the session from
 *  the request, so either only says "hand me that session". `bearer` WITH a `token` is the in-band
 *  form (capnweb's own pattern): a client that opened the socket bare — a static page on another
 *  origin, whose browser cannot put a header on a WebSocket (api.ts) — presents its token here, and
 *  it goes through the same gate. `admin-secret` is the operator/CLI credential, verified in-band. */
const SessionCredentials = z.discriminatedUnion("type", [
  z.object({ type: z.literal("from-server-cookie") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1).optional() }),
  z.object({
    type: z.literal("admin-secret"),
    secret: z.string(),
    as: z.object({ email: z.email() }).optional(),
  }),
]);
export type SessionCredentials = z.infer<typeof SessionCredentials>;

/** The verified user or configured administrator acting through this session. */
export type SessionPrincipal = Principal;

/** What every session is built from: the edge's bindings, the configuration and THIS request. */
export interface SessionInput {
  contextNamespace: IterateContextNamespace;
  waitUntil: WaitUntil;
  directory: Directory;
  /** Configuration for operator authentication and context capabilities. */
  appConfig: AppConfig;
  /** A live transport tracks projects whose capabilities it has handed out. */
  onProjectAccess?: (projectId: string) => void;
  /** The in-band bearer (rpc.ts): verify a token a bare socket presents and bind the transport to
   *  its grant — null for a token the gate refuses. Absent on a door with no such form. */
  resolveBearer?: (token: string) => Promise<SessionAuthority | null>;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. `authenticate(credentials)` is
 *  its only real verb: it returns the `SessionRpcTarget` you reach `.user`/`.projects`/… through.
 *  On the public transport the OAuth gate has already resolved the caller, so `authenticate({ type:
 *  "from-server-cookie" })` hands back that session; the operator door carries no resolved session,
 *  so `authenticate({ type: "admin-secret", secret })` verifies the deployment admin secret in-band.
 *  Its teardown owns every context the session it vends hands out. */
export class IterateRpcTarget extends RpcTarget {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  /** The authority the transport already resolved (public `/api`), or null (the operator door, which
   *  authenticates in-band with the admin secret). */
  readonly #resolved: SessionAuthority | null;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    resolved: SessionAuthority | null = null,
  ) {
    super();
    this.#input = input;
    this.#sessionTeardown = sessionTeardown;
    this.#resolved = resolved;
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  async authenticate(input: unknown): Promise<SessionRpcTarget> {
    const credentials = SessionCredentials.safeParse(input);
    if (!credentials.success)
      throw codedError(
        "INVALID_CREDENTIALS",
        "authenticate({ type }): 'from-server-cookie' (browser), 'bearer' (a token on the upgrade, or in-band as `token`) or 'admin-secret' (operator).",
      );
    if (credentials.data.type === "bearer" && credentials.data.token) {
      // IN-BAND: the same gate as a header on the upgrade, bound to this transport by rpc.ts. No
      // account fact — a page or script presenting its token on every reconnect is not a sign-in.
      const resolved = await this.#input.resolveBearer?.(credentials.data.token);
      if (!resolved) throw codedError("INVALID_CREDENTIALS", "Invalid or revoked bearer");
      return new SessionRpcTarget(this.#input, this.#sessionTeardown, resolved);
    }
    if (credentials.data.type === "from-server-cookie" || credentials.data.type === "bearer") {
      if (!this.#resolved)
        throw codedError("UNAUTHENTICATED", "this transport carries no session — sign in first.");
      // A person signing in is an account fact; a device or script presenting its token on every
      // reconnect is not (the grant's last use already records it) — so only the browser form
      // publishes one.
      if (credentials.data.type === "from-server-cookie")
        this.#publishAuthenticationFact(this.#resolved.principal, "from-server-cookie");
      return new SessionRpcTarget(this.#input, this.#sessionTeardown, this.#resolved);
    }
    const admin = await verifyAdminSecret(
      credentials.data.secret,
      this.#input.appConfig.adminApiSecret.exposeSecret(),
    );
    if (!admin) throw codedError("INVALID_CREDENTIALS", "The admin secret did not match.");
    // Test/operator fixture only; product impersonation must retain operator attribution.
    const user =
      credentials.data.as && (await this.#input.directory.upsertUser(credentials.data.as.email));
    const principal = user ? { actor: user.id, email: user.email } : admin;
    this.#publishAuthenticationFact(principal, "admin-secret");
    // the operator acting as a user is that user with every scope
    return new SessionRpcTarget(this.#input, this.#sessionTeardown, {
      principal,
      reach: user ? { userId: user.id } : "every",
      ...(user && { scopes: ["iterate", "account", "organizations:write"] }),
    });
  }

  /** Record a successful authentication on the human's account context — best-effort and ASYNC (via
   *  waitUntil), off the connection's hot path: it is "nice to see", not authoritative, so a lost one
   *  on eviction is fine. Only a human (a principal with an email) has an account context — the admin
   *  and project credentials name none. The fact rides `session.user`'s stream, where the
   *  AccountProcessor folds it into the account view (src/account/contract.ts). NOTE: the boundary is
   *  per-authenticate for now (a reconnect re-publishes); narrowing it to credential-establishment is
   *  a later refinement. Attribution is the user's until the platform principal lands. */
  #publishAuthenticationFact(
    principal: SessionPrincipal,
    credential: "from-server-cookie" | "admin-secret",
  ): void {
    if (!principal.email) return;
    const operationId = crypto.randomUUID();
    publishGlobalFact(
      this.#input,
      `/users/${principal.actor}`,
      {
        type: "events.iterate.com/account/authenticated",
        payload: { credential, at: Date.now(), operationId } satisfies AuthenticationFact,
        idempotencyKey: `authenticated/${operationId}`,
      },
      { principal },
    );
  }
}

/** A CONTROL-PLANE FACT, appended to the global context of the entity it happened to — the
 *  organization (`/organizations/<id>`: created, renamed, deleted, a project created in it), the
 *  person (`/users/<id>`: authenticated; grants.ts and consent.ts add a token minted, a grant
 *  ended, a consent approved) — stamped with the caller, principal and grant: the audit lives where
 *  it happened, attributed to who did it and through which connection. Best-effort and ASYNC
 *  (waitUntil), off the verb's own path: the directory stays the truth for the state, this is the
 *  record of it — a fact lost to an eviction is a gap in the record, never a failed action. */
function publishGlobalFact(
  input: SessionInput,
  path: string,
  fact: StreamEventInput,
  caller: Caller,
): void {
  const name = DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path });
  input.waitUntil(
    // The stub's `invoke` is typed as workerd's RPC wrapper over the DO method; the append's answer
    // is not read, so `unknown` is all the promise needs to be.
    (
      input.contextNamespace
        .getByName(name)
        .invoke(["itx", ["append", fact]], [], caller) as Promise<unknown>
    ).then(
      () => undefined,
      () => undefined,
    ),
  );
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
export type SessionAuthority = {
  principal: SessionPrincipal;
  /** The OAuth grant this session IS — the connection, stamped beside the principal on every event
   *  (`source.grant`); absent for the admin secret and the in-band cookie/admin authenticate. */
  grant?: string;
  reach: Reach;
  grants?: Grants;
  consent?: Consent;
  scopes?: string[];
};

export class SessionRpcTarget extends RpcTarget {
  readonly #sessionTeardown: SessionTeardown;
  readonly #projects: ProjectCollection;
  readonly #organizations: OrganizationCollection;
  readonly #input: SessionInput;
  readonly #authority: SessionAuthority;

  constructor(input: SessionInput, sessionTeardown: SessionTeardown, authority: SessionAuthority) {
    super();
    this.#input = input;
    this.#authority = authority;
    this.#sessionTeardown = sessionTeardown;
    this.#projects = new ProjectCollection(
      input,
      sessionTeardown,
      { principal: authority.principal, grant: authority.grant },
      authority.reach,
    );
    this.#organizations = new OrganizationCollection(
      (orgId) => this.#reachesOrg(orgId),
      (orgId) => this.#globalContext(`/organizations/${orgId}`),
    );
  }

  /** Whether this session may hold `orgId`'s context: the admin (every project) reaches every
   *  organization; a user reaches the organizations `orgs()` lists — their memberships, narrowed to
   *  the orgs of the projects a grant chose. */
  async #reachesOrg(orgId: string): Promise<boolean> {
    if (this.#authority.reach === "every") return true;
    return (await this.orgs()).some((org) => org.id === orgId);
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  /** Attribution comes from the admission gate, never from the caller. */
  whoami(): SessionPrincipal {
    return this.#authority.principal;
  }

  /** Safe bootstrap data for every app, regardless of which host serves it. */
  info() {
    return {
      principal: this.#authority.principal,
      scopes: this.#authority.scopes ?? [],
      platformOrigin: this.#input.appConfig.platformOrigin,
      projectHostnameBase: this.#input.appConfig.projectHostnameBase,
      mcpOrigin: this.#input.appConfig.mcpOrigin,
    };
  }

  /** The person's organizations. A grant narrowed to projects sees only the organizations those
   *  projects belong to — unless it holds `organizations:write`, which is the organizations
   *  themselves: every one the person belongs to, the one it just created included. */
  async orgs() {
    const { reach, scopes } = this.#authority;
    if (reach === "every" || !("userId" in reach)) return [];
    const orgs = await this.#input.directory.listOrgs(reach.userId);
    if (!("projectIds" in reach) || scopes?.includes("organizations:write")) return orgs;
    const projects = await this.#input.directory.reachableProjects(reach);
    return orgs.filter((org) => projects.some((project) => project.orgId === org.id));
  }

  /** Creating, renaming or deleting an organization is the `organizations:write` scope's: a user
   *  grant whose consent kept it ticked (the dash asks for it; the consent page lets the person
   *  untick it), the issuer's own session, or the operator acting as a user. The grant's project
   *  reach is beside the point — an organization is the person's, and the grant reaches what it
   *  reached before. The person behind the grant, for the directory. */
  #organizationsWriter(verb: string): { userId: string } {
    const { reach, scopes } = this.#authority;
    if (reach === "every" || !("userId" in reach))
      throw codedError("FORBIDDEN", `A user session is required to ${verb} an organization.`);
    if (!scopes?.includes("organizations:write"))
      throw codedError(
        "FORBIDDEN",
        `The organizations:write permission is required to ${verb} an organization.`,
      );
    return reach;
  }

  /** WHO this session is, as an event's stamp: the principal and the grant it acts through. */
  get #caller(): Caller {
    return { principal: this.#authority.principal, grant: this.#authority.grant };
  }

  /** A new organization named `name`, the person its owner — and the fact of it on the
   *  organization's own context (src/organization/). */
  async createOrg(name: string) {
    const { userId } = this.#organizationsWriter("create");
    const org = await this.#input.directory.createOrg(userId, z.string().trim().min(1).parse(name));
    publishGlobalFact(
      this.#input,
      `/organizations/${org.id}`,
      {
        type: "events.iterate.com/organization/created",
        idempotencyKey: "organization/created",
        payload: { name: org.name },
      },
      this.#caller,
    );
    return org;
  }

  /** Rename an organization the person owns. */
  async updateOrg(orgId: string, input: { name: string }) {
    const { userId } = this.#organizationsWriter("rename");
    const data = z.object({ name: z.string().trim().min(1) }).parse(input);
    const org = await this.#input.directory.renameOrg(
      userId,
      z.string().min(1).parse(orgId),
      data.name,
    );
    publishGlobalFact(
      this.#input,
      `/organizations/${org.id}`,
      { type: "events.iterate.com/organization/renamed", payload: { name: org.name } },
      this.#caller,
    );
    return org;
  }

  /** Delete an organization the person owns, while it holds no project. The fact lands on the
   *  organization's context, which outlives the directory row as its record. */
  async deleteOrg(orgId: string) {
    const { userId } = this.#organizationsWriter("delete");
    const id = z.string().min(1).parse(orgId);
    await this.#input.directory.deleteOrg(userId, id);
    publishGlobalFact(
      this.#input,
      `/organizations/${id}`,
      {
        type: "events.iterate.com/organization/deleted",
        idempotencyKey: "organization/deleted",
        payload: {},
      },
      this.#caller,
    );
  }

  get consent() {
    if (!this.#authority.consent)
      throw codedError("FORBIDDEN", "Sign in to iterate to approve access.");
    return this.#authority.consent;
  }

  get grants() {
    if (!this.#authority.grants)
      throw codedError("FORBIDDEN", "This session cannot manage OAuth grants.");
    return this.#authority.grants;
  }

  logout() {
    return this.grants.endCurrent();
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }

  /** The organizations this session can reach, each as a global IterateContextRpcTarget at
   *  `(global, /organizations/<orgId>)` — the same context surface as a user or a project. `orgs()`
   *  returns the directory rows; this vends the org's context, by membership. */
  get organizations(): OrganizationCollection {
    return this.#organizations;
  }

  /** The signed-in human's own context in the deployment-global namespace — an ORDINARY
   *  IterateContextRpcTarget at `(global, /users/<userId>)`, the exact surface a project context
   *  has (`session.user` is `session.projects.get(...)` one namespace over). A getter, like
   *  `projects`. Refused for the admin credential — it names no human. */
  get user(): IterateContextRpcTarget {
    const { principal, reach } = this.#authority;
    if (!principal.email)
      throw codedError(
        "FORBIDDEN",
        "this credential identifies no user — the admin credential names no `.user` context",
      );
    // A grant bound to projects (a personal access token a device holds) reaches those projects
    // and nothing of the person's own: the user context is the account, not a project.
    if (reach !== "every" && "projectIds" in reach)
      throw codedError(
        "FORBIDDEN",
        "this credential is bound to projects — it opens no `.user` context",
      );
    return this.#globalContext(`/users/${principal.actor}`);
  }

  /** A context in the deployment-global namespace (the control plane's own): an ordinary
   *  IterateContextRpcTarget at `(GLOBAL_PROJECT_ID, path)`, carrying this session's principal. THE
   *  ONLY WAY TO A GLOBAL CONTEXT: `user` and `organizations.get` vend one by IDENTITY (the session's
   *  own user, an org it belongs to) and the handle's `cd` is refused (iterate-context.ts), so no
   *  caller can name another global path — the path mask with no policy table. */
  #globalContext(path: string): IterateContextRpcTarget {
    return new IterateContextRpcTarget(
      this.#input.contextNamespace,
      DurableObjectNameCodec.address({ projectId: GLOBAL_PROJECT_ID, path }),
      this.#sessionTeardown,
      this.#input.waitUntil,
      this.#caller,
    );
  }
}

/** The organization catalog: `get(orgId)` vends an organization's context in the deployment-global
 *  namespace, `(global, /organizations/<orgId>)` — BY MEMBERSHIP (`SessionRpcTarget.#reachesOrg`):
 *  an org the session does not reach is FORBIDDEN, exactly as `projects.get` outside its reach. */
class OrganizationCollection extends RpcTarget {
  readonly #reachesOrg: (orgId: string) => Promise<boolean>;
  readonly #context: (orgId: string) => IterateContextRpcTarget;

  constructor(
    reachesOrg: (orgId: string) => Promise<boolean>,
    context: (orgId: string) => IterateContextRpcTarget,
  ) {
    super();
    this.#reachesOrg = reachesOrg;
    this.#context = context;
  }

  async get(orgId: string): Promise<IterateContextRpcTarget> {
    // ONE path segment — the directory's `org_<hex>` — never a path: the id is interpolated into
    // `/organizations/<id>`, and `..` or `x/../users/<id>` would canonicalize onto another global
    // context (the admin reaches every org, so the membership check alone would not catch it).
    const id = z.string().trim().min(1).parse(orgId);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw codedError(
        "FORBIDDEN",
        `organizations.get(${JSON.stringify(id)}): an organization id is one path segment, never a path`,
      );
    if (!(await this.#reachesOrg(id)))
      throw codedError(
        "FORBIDDEN",
        `organizations.get(${JSON.stringify(id)}): not an organization this session belongs to`,
      );
    return this.#context(id);
  }
}

/** The project catalog: `list()`, `get(project)`, `create({ project })` — get and create vend the
 *  project's root context. What a session reaches is its `Reach` (control-plane.ts): every project,
 *  the projects of the user's orgs, or the projects named outright. */
class ProjectCollection extends RpcTarget {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  readonly #reach: Reach;
  /** The verified caller — principal and grant — stamped on context events. */
  readonly #caller: Caller;

  constructor(input: SessionInput, sessionTeardown: SessionTeardown, caller: Caller, reach: Reach) {
    super();
    this.#input = input;
    this.#sessionTeardown = sessionTeardown;
    this.#reach = reach;
    this.#caller = caller;
  }

  /** The projects this session reaches, as directory rows: the projects of the orgs the user
   *  belongs to, with their role — narrowed to the projects a grant chose; for the admin secret,
   *  every project (no role). */
  list(): Promise<Project[]> {
    return this.#input.directory.reachableProjects(this.#reach);
  }

  /** Create the project named `project` (slugified into its hostname label; its id is minted —
   *  the returned context's `whoami()` says it, so does `list()`) — in the user's org (the first
   *  by name when they have several, created on first use when they have none), or in the
   *  deployment's own org for the admin secret — and vend its root context. A grant narrowed to
   *  named projects creates none: FORBIDDEN. A slug ANY org already holds is refused, coded
   *  (PROJECT_NAME_TAKEN); the same org's again is idempotent. */
  async create(input: { project: string; orgId?: string }): Promise<IterateContextRpcTarget> {
    const data = z.object({ project: z.string(), orgId: z.string().optional() }).parse(input);
    const project = await this.#input.directory.createProject(
      this.#reach,
      data.project,
      data.orgId,
    );
    // The fact of it, on the organization it was created in (idempotent on the project: the same
    // org's same slug again is the same project).
    publishGlobalFact(
      this.#input,
      `/organizations/${project.orgId}`,
      {
        type: "events.iterate.com/organization/project-created",
        idempotencyKey: `organization/project-created/${project.id}`,
        payload: { projectId: project.id, slug: project.slug },
      },
      this.#caller,
    );
    return this.#context(project.id);
  }

  /** The project's root context ("/"), by its slug or its id. A project only — a context name
   *  belongs to `cd`. Outside this session's reach is FORBIDDEN; so is the global namespace's id (it
   *  is no project). The admin secret alone addresses a project the directory never heard of, by
   *  id (a fresh context of its own). */
  async get(project: ProjectRef): Promise<IterateContextRpcTarget> {
    const address = DurableObjectNameCodec.parse(project);
    if (address.path !== "/")
      throw new Error(
        `projects.get(project): got a context name ${JSON.stringify(project)} — pass the project and cd(path) from its root`,
      );
    if (address.projectId === GLOBAL_PROJECT_ID)
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(project)}): the deployment-global namespace is no project — a global context is reached by identity (session.user, session.organizations)`,
      );
    const id = await this.#input.directory.projectIdOf(address.projectId);
    if (!(await this.#input.directory.reachesProject(this.#reach, id)))
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(project)}): outside this session's reach — ${describeReach(this.#reach)}`,
      );
    return this.#context(id);
  }

  #context(projectId: string): IterateContextRpcTarget {
    this.#input.onProjectAccess?.(projectId);
    return new IterateContextRpcTarget(
      this.#input.contextNamespace,
      DurableObjectNameCodec.parse(projectId),
      this.#sessionTeardown,
      this.#input.waitUntil,
      this.#caller,
    );
  }
}

// ── session teardown ── WHAT A SESSION MUST UNDO AT ITS END, as a leaf (no imports): the one-entry-per-key
// register every IterateContextRpcTarget of a session shares, testable in the node lane.

/** WHAT THIS SESSION MUST UNDO AT ITS END — ONE entry per key: a lend relay (the session's copy of
 *  a client stub plus its pager socket, held so neither is GC'd) and anything else scoped to the
 *  session. THE CALLER OWNS THE KEY (iterate-context.ts `#sessionTeardownKey` pairs the context name
 *  with the stub key). Re-adding the SAME key is a TRANSPORT REPLACEMENT (a reconnect): by the time
 *  the new relay's pager is open, the DO has already dropped the old transport as "replaced", so
 *  disposing the incumbent here is a harmless double-close that keeps this map from accumulating
 *  dead relays. */
export class SessionTeardown {
  readonly #undoByKey = new Map<string, { dispose(): void }>();
  /** Register `undo` under `key`, REPLACING what sat there (disposed now). Returns the LEASE — the
   *  one thing a handle should hold: its dispose runs `undo` only while `undo` is still the current
   *  entry, so a stale handle (re-provide at the same match, then dispose the OLD handle) can never tear
   *  down its replacement (the v4 review's kernel finding 2.6). */
  add(key: string, undo: { dispose(): void }): { dispose(): void } {
    this.#undoByKey.get(key)?.dispose();
    this.#undoByKey.set(key, undo);
    return {
      dispose: () => {
        if (this.#undoByKey.get(key) !== undo) return; // replaced — the replacement owns the key now
        this.#undoByKey.delete(key);
        undo.dispose();
      },
    };
  }
  /** Dispose whatever sits under `key` now — the SESSION's own act (a `provide(match, null)`, a
   *  `subscribe` re-spelled as an expression), never a handle's. */
  dispose(key: string): void {
    const undo = this.#undoByKey.get(key);
    if (!undo) return;
    this.#undoByKey.delete(key);
    undo.dispose();
  }
  disposeAll(): void {
    for (const undo of this.#undoByKey.values()) undo.dispose();
    this.#undoByKey.clear();
  }
}

// THE PUBLISHED API IS DECLARED, NOT GENERATED (iterate/next/api): this root satisfies it, checked here.
const _iterateApi: IterateApi = null as unknown as IterateRpcTarget;
void _iterateApi;
