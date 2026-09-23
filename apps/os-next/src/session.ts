import {
  normalizeConfigRepoTemplateReference,
  parseConfigRepoTemplateReference,
  formatConfigRepoTemplateReference,
} from "@iterate-com/shared/config-repo-template/reference";
import { pinPublicGithubTemplate } from "@iterate-com/shared/config-repo-template/github";
// Public /api starts with a session: the OAuth gate's, resolved on the upgrade, or one a bare
// socket authenticates IN-BAND — a bearer token, or the operator's admin secret. Sessions vend
// project contexts and own their teardown. What a session KNOWS — which projects and organizations
// exist, who reaches what — and what it DOES to them — create an organization or a project,
// rename, delete, a membership — is one call on the control plane (src/control-plane/edge.ts),
// made under this caller.

import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { IterateApi } from "iterate/next/api";
import { codedError } from "iterate/next/lib";
import { verifyAdminSecret, type Caller, type Principal } from "iterate/next/principal";
import type { StreamEventInput } from "iterate/next/stream/processor";
import { templates } from "./generated/config-templates.js";
import type { ConsentRpcTarget } from "./consent.ts";
import type { GrantsRpcTarget } from "./grants.ts";
import { GLOBAL_PROJECT_ID } from "./context/paths.ts";
import {
  DurableObjectNameCodec,
  IterateContextRpcTarget,
  type IterateContextNamespace,
  type WaitUntil,
} from "./iterate-context.ts";
import type {
  MemberRecord,
  OrganizationRecord,
  ProjectRecord,
  UserRecord,
} from "./control-plane/catalog.ts";
import { type ControlPlane, describeReach, type Reach } from "./control-plane/edge.ts";
import { IdentityProvider } from "./control-plane/contract.ts";
import { OrganizationRole } from "./organization/contract.ts";
import type { AppConfig } from "./app-config.ts";
import type { AuthenticationFact } from "./account/contract.ts";
import { assertSecretPath } from "./secrets.ts";

/** What `IterateRpcTarget.authenticate` accepts. `from-server-cookie` is the browser and `bearer` is
 *  a device or script whose token rode the upgrade: the OAuth gate already resolved the session
 *  from the request, so either only says "hand me that session". Kit firmware (itx_mount.c) sends
 *  `{ type: "bearer" }` alone — the token-less form exists for it.
 *  `bearer` WITH a `token` is the in-band form (capnweb's own pattern): a client that opened the
 *  socket bare — a static page on another origin, whose browser cannot put a header on a WebSocket
 *  (api.ts) — presents its token here, and it goes through the same gate. `admin-secret` is the
 *  operator/CLI credential, verified in-band on any transport — a bare socket, or one the gate
 *  already resolved. */
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

/** What every session is built from: the edge's bindings, the configuration and THIS request. */
export interface SessionInput {
  contextNamespace: IterateContextNamespace;
  waitUntil: WaitUntil;
  /** The control plane as the edge holds it: the catalog's reads and its commands. */
  controlPlane: ControlPlane;
  /** Configuration for operator authentication and context capabilities. */
  appConfig: AppConfig;
  /** THE PLATFORM ORIGIN this session was reached on (app-config.ts `platformAddressesOf`) — what
   *  every context it vends composes public URLs with (a DO isolate cannot know it: the caller
   *  carries it). */
  platformOrigin: string;
  /** A live transport tracks projects whose capabilities it has handed out. */
  onProjectAccess?: (projectId: string) => void;
  /** The in-band bearer (rpc.ts): verify a token a bare socket presents and bind the transport to
   *  its grant — null for a token the gate refuses. Absent on a door with no such form. */
  resolveBearer?: (token: string) => Promise<SessionAuthority | null>;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. `authenticate(credentials)` is
 *  its only real verb: it returns the `SessionRpcTarget` you reach `.user`/`.projects`/… through.
 *  On a transport the OAuth gate resolved, `authenticate({ type: "from-server-cookie" })` hands back
 *  that session; a bare socket (api.ts) carries none, so it authenticates in-band —
 *  `authenticate({ type: "bearer", token })`, or `authenticate({ type: "admin-secret", secret })`,
 *  the deployment admin secret verified here.
 *  Its teardown owns every context the session it vends hands out. */
export class IterateRpcTarget extends RpcTarget {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  /** The authority the transport already resolved (a credential on the upgrade), or null (a bare
   *  socket, which authenticates in-band). */
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
      this.#input.appConfig.secrets.adminBearer.exposeSecret(),
    );
    if (!admin) throw codedError("INVALID_CREDENTIALS", "The admin secret did not match.");
    // Test/operator fixture only; product impersonation must retain operator attribution. The
    // user is found or created in the control plane (a sign-in's own find-or-create).
    const user =
      credentials.data.as && (await this.#input.controlPlane.ensureUser(credentials.data.as.email));
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
    principal: Principal,
    credential: "from-server-cookie" | "admin-secret",
  ): void {
    if (!principal.email) return;
    const operationId = crypto.randomUUID();
    publishAccountFact(
      this.#input,
      principal.actor,
      {
        type: "events.iterate.com/account/authenticated",
        payload: { credential, at: Date.now(), operationId } satisfies AuthenticationFact,
        idempotencyKey: `authenticated/${operationId}`,
      },
      { principal },
    );
  }
}

/** AN ACCOUNT FACT, appended to the person's own context (`/users/<id>`: authenticated here;
 *  grants.ts and consent.ts add a token minted, a grant used, a consent approved) — stamped with
 *  the caller, principal and grant: the audit lives where it happened, attributed to who did it and
 *  through which connection. Best-effort and ASYNC (waitUntil), off the verb's own path: a fact
 *  lost to an eviction is a gap in the record, never a failed action. (A grant's END is not
 *  published this way: grants.ts AWAITS it — it is the revocation truth.) The organization's
 *  facts are the control plane's to land (src/control-plane/durable-object.ts). */
export function publishAccountFact(
  input: Pick<SessionInput, "contextNamespace" | "waitUntil">,
  userId: string,
  fact: StreamEventInput,
  caller: Caller,
): void {
  const name = DurableObjectNameCodec.stringify({
    projectId: GLOBAL_PROJECT_ID,
    path: `/users/${userId}`,
  });
  const context = input.contextNamespace.getByName(name);
  input.waitUntil(
    // The stub's `invoke` is typed as workerd's RPC wrapper over the DO method; neither answer is
    // read, so `unknown` is all the promises need to be.
    (context.invoke(["itx", "processors", ["enable", "account"]], [], caller) as Promise<unknown>)
      .then(() => context.invoke(["itx", ["append", fact]], [], caller) as Promise<unknown>)
      .then(
        () => undefined,
        () => undefined,
      ),
  );
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
export type SessionAuthority = {
  principal: Principal;
  /** The OAuth grant this session IS — the connection, stamped beside the principal on every event
   *  (`source.grant`); absent for the admin secret and the in-band cookie/admin authenticate. */
  grant?: string;
  reach: Reach;
  grants?: GrantsRpcTarget;
  consent?: ConsentRpcTarget;
  scopes?: string[];
};

export class SessionRpcTarget extends RpcTarget {
  readonly #sessionTeardown: SessionTeardown;
  readonly #projects: ProjectCollectionRpcTarget;
  readonly #organizations: OrganizationCollectionRpcTarget;
  readonly #users: UserCollectionRpcTarget;
  readonly #input: SessionInput;
  readonly #authority: SessionAuthority;

  constructor(input: SessionInput, sessionTeardown: SessionTeardown, authority: SessionAuthority) {
    super();
    this.#input = input;
    this.#authority = authority;
    this.#sessionTeardown = sessionTeardown;
    const session: SessionOf = {
      input,
      authority,
      caller: this.#caller,
      globalContext: (path) => this.#globalContext(path),
      organizationsWriter: (verb) => this.#organizationsWriter(verb),
    };
    this.#projects = new ProjectCollectionRpcTarget(session, sessionTeardown);
    this.#organizations = new OrganizationCollectionRpcTarget(session);
    this.#users = new UserCollectionRpcTarget(session);
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  /** Attribution comes from the admission gate, never from the caller. */
  whoami(): Principal {
    return this.#authority.principal;
  }

  /** The operator's project-seed CLI. User sessions, including impersonated users, cannot
   * export secret cells. Address the native context directly, outside project rewrites. */
  async exportProjectSecretForSeed(projectRef: string, path: string): Promise<unknown> {
    if (this.#authority.principal.actor !== "admin" || this.#authority.reach !== "every")
      throw codedError("FORBIDDEN", "Project-seed exports require operator authority.");
    const project = await this.#input.controlPlane.getProject(z.string().min(1).parse(projectRef));
    if (!project) throw codedError("INVALID_INPUT", "Project not found.");
    const name = DurableObjectNameCodec.stringify({
      projectId: project.id,
      path: assertSecretPath(z.string().parse(path)),
    });
    return this.#input.contextNamespace
      .getByName(name)
      .exportSecretForProjectSeed(this.#input.appConfig.secrets.adminBearer.exposeSecret());
  }

  /** Safe bootstrap data for every app, regardless of which host serves it. */
  info() {
    return {
      principal: this.#authority.principal,
      scopes: this.#authority.scopes ?? [],
      platformOrigin: this.#input.platformOrigin,
      ingressRouting: this.#input.appConfig.urls.ingressRouting,
      mcpOrigin: this.#input.appConfig.urls.mcp,
    };
  }

  /** Creating, renaming or deleting an organization, or changing its members, is the
   *  `organizations:write` scope's: a user grant whose consent kept it ticked (the dash asks for
   *  it; the consent page lets the person untick it), the issuer's own session, or the operator —
   *  acting as a user, or as the operator (the replay of an older directory). The grant's project
   *  reach is beside the point — an organization is the person's, and the grant reaches what it
   *  reached before. */
  #organizationsWriter(verb: string): void {
    const { reach, scopes } = this.#authority;
    if (reach === "every") return;
    if (!("userId" in reach))
      throw codedError("FORBIDDEN", `A user session is required to ${verb} an organization.`);
    if (!scopes?.includes("organizations:write"))
      throw codedError(
        "FORBIDDEN",
        `The organizations:write permission is required to ${verb} an organization.`,
      );
  }

  /** WHO this session is, as an event's stamp: the principal and the grant it acts through. */
  get #caller(): Caller {
    return {
      principal: this.#authority.principal,
      grant: this.#authority.grant,
      platformOrigin: this.#input.platformOrigin,
    };
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
  get projects(): ProjectCollectionRpcTarget {
    return this.#projects;
  }

  /** The organizations this session can reach: `list()` (the rows, with the person's role),
   *  `get(orgId)` (the organization's context — a global IterateContextRpcTarget at
   *  `(global, /organizations/<orgId>)`, the same context surface as a user or a project — by
   *  membership), and the verbs, each one call on the control plane. */
  get organizations(): OrganizationCollectionRpcTarget {
    return this.#organizations;
  }

  /** THE PEOPLE — the operator's catalog alone: every other session names one person, itself. */
  get users(): UserCollectionRpcTarget {
    if (this.#authority.reach !== "every")
      throw codedError("FORBIDDEN", "Only the operator reads the user catalog.");
    return this.#users;
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

/** What the collections below share of their session. */
type SessionOf = {
  input: SessionInput;
  authority: SessionAuthority;
  /** The verified caller — principal and grant — stamped on every request and context event. */
  caller: Caller;
  globalContext(path: string): IterateContextRpcTarget;
  organizationsWriter(verb: string): void;
};

/** The organization catalog. `list()` is the person's organizations, with their role (a grant
 *  narrowed to projects sees only the organizations those projects belong to — unless it holds
 *  `organizations:write`, which is the organizations themselves); `get(orgId)` vends the
 *  organization's context BY MEMBERSHIP (an org the session does not reach is FORBIDDEN, exactly as
 *  `projects.get` outside its reach); `create`, `rename`, `delete`, `addMember`, `removeMember` are
 *  each one call on the control plane under this caller, which checks the rest (an owner? the last
 *  owner? projects still held?) against its catalog. */
class OrganizationCollectionRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  constructor(session: SessionOf) {
    super();
    this.#session = session;
  }

  /** The organizations this session reaches, narrowed as the docstring says. `fresh` re-reads the
   *  person's memberships past the isolate's memo — the re-read before a refusal (edge.ts's rule),
   *  so a membership that just landed elsewhere is admitted at once. */
  async #reachable(fresh = false): Promise<OrganizationRecord[]> {
    const { reach, scopes } = this.#session.authority;
    const { controlPlane } = this.#session.input;
    if (reach === "every") return controlPlane.listOrganizations();
    if (!("userId" in reach)) return [];
    const record = await controlPlane.reach(reach.userId, fresh);
    if (!("projectIds" in reach) || scopes?.includes("organizations:write")) return record.orgs;
    const chosen = record.projects.filter((project) => reach.projectIds!.includes(project.id));
    return record.orgs.filter((org) => chosen.some((project) => project.orgId === org.id));
  }

  list(): Promise<OrganizationRecord[]> {
    return this.#reachable();
  }

  async get(orgId: string): Promise<IterateContextRpcTarget> {
    // ONE path segment — the catalog's `org_<hex>` — never a path: the id is interpolated into
    // `/organizations/<id>`, and `..` or `x/../users/<id>` would canonicalize onto another global
    // context (the admin reaches every org, so the membership check alone would not catch it).
    const id = z.string().trim().min(1).parse(orgId);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw codedError(
        "FORBIDDEN",
        `organizations.get(${JSON.stringify(id)}): an organization id is one path segment, never a path`,
      );
    // BY MEMBERSHIP, AS `list()` NARROWS IT: a grant bound to projects reaches only the organizations
    // those projects belong to (unless it holds `organizations:write`), so a personal access token
    // opens no other organization's context. The admin reaches every one. A miss is re-read once
    // past the memo before it is refused: a membership that just landed is admitted at once.
    const reaches = (organizations: OrganizationRecord[]) =>
      organizations.some((organization) => organization.id === id);
    const reachable =
      this.#session.authority.reach === "every" ||
      reaches(await this.#reachable()) ||
      reaches(await this.#reachable(true));
    if (!reachable)
      throw codedError(
        "FORBIDDEN",
        `organizations.get(${JSON.stringify(id)}): not an organization this session belongs to`,
      );
    return this.#session.globalContext(`/organizations/${id}`);
  }

  /** An organization's members with their emails — the operator's alone (the project-seed CLI
   *  captures an organization's membership with the project). */
  async members(orgId: string): Promise<MemberRecord[]> {
    if (this.#session.authority.reach !== "every")
      throw codedError("FORBIDDEN", "Only the operator lists an organization's members.");
    return this.#session.input.controlPlane.listMembers(z.string().min(1).parse(orgId));
  }

  /** A new organization named `name`, the person its owner. The operator may name the owner and
   *  pin the id (the replay of an older directory). */
  async create(input: {
    name: string;
    id?: string;
    ownerId?: string;
  }): Promise<OrganizationRecord> {
    this.#session.organizationsWriter("create");
    const data = z
      .object({
        name: z.string().trim().min(1, "Enter an organization name."),
        id: z.string().optional(),
        ownerId: z.string().optional(),
      })
      .parse(input);
    return this.#session.input.controlPlane.createOrganization(this.#session.caller, data);
  }

  /** Rename an organization the person owns. */
  async rename(orgId: string, input: { name: string }): Promise<OrganizationRecord> {
    this.#session.organizationsWriter("rename");
    const data = z
      .object({ name: z.string().trim().min(1, "Enter an organization name.") })
      .parse(input);
    const record = await this.#session.input.controlPlane.renameOrganization(
      this.#session.caller,
      z.string().min(1).parse(orgId),
      data.name,
    );
    return { ...record, role: "owner" };
  }

  /** Delete an organization the person owns, while it holds no project. The fact lands on the
   *  organization's context, which outlives the catalog row as its record. */
  async delete(orgId: string): Promise<void> {
    this.#session.organizationsWriter("delete");
    await this.#session.input.controlPlane.deleteOrganization(
      this.#session.caller,
      z.string().min(1).parse(orgId),
    );
  }

  /** Add a person to an organization the caller owns, as an owner or a member. */
  async addMember(
    orgId: string,
    input: { userId: string; role?: OrganizationRole },
  ): Promise<void> {
    this.#session.organizationsWriter("add a member to");
    const data = z
      .object({ userId: z.string().min(1), role: OrganizationRole.default("member") })
      .parse(input);
    await this.#session.input.controlPlane.addMember(
      this.#session.caller,
      z.string().min(1).parse(orgId),
      data,
    );
  }

  /** Remove a person from an organization the caller owns. */
  async removeMember(orgId: string, input: { userId: string }): Promise<void> {
    this.#session.organizationsWriter("remove a member from");
    const data = z.object({ userId: z.string().min(1) }).parse(input);
    await this.#session.input.controlPlane.removeMember(
      this.#session.caller,
      z.string().min(1).parse(orgId),
      data,
    );
  }
}

/** The project catalog: `list()`, `get(project)`, `create({ project })` — get and create vend the
 *  project's root context. What a session reaches is its `Reach` (control-plane/edge.ts): every
 *  project, the projects of the user's orgs, or the projects named outright. */
class ProjectCollectionRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  readonly #sessionTeardown: SessionTeardown;

  constructor(session: SessionOf, sessionTeardown: SessionTeardown) {
    super();
    this.#session = session;
    this.#sessionTeardown = sessionTeardown;
  }

  /** The projects this session reaches, as catalog rows: the projects of the orgs the user
   *  belongs to, with their role — narrowed to the projects a grant chose; for the admin secret,
   *  every project (no role). */
  list(): Promise<ProjectRecord[]> {
    return this.#session.input.controlPlane.reachableProjects(this.#session.authority.reach);
  }

  /** The built-in config repo templates a creation may name (generated/config-templates.js). */
  async templates() {
    return templates;
  }

  /** Create the project named `project` (slugified into its hostname label; its id is minted —
   *  or, for the operator restoring a project seed, the archived `restoreProjectId` — the returned
   *  context's `whoami()` says it, so does `list()`) — in the organization named, or
   *  the user's own (the first by name when they have several, created on first use when they
   *  have none), or in the deployment's own for the admin secret — and vend its root context. The
   *  config repo template is PINNED to a commit here (a resumed creation always reads the same
   *  tree); the control plane refuses a slug ANY other organization holds (PROJECT_NAME_TAKEN),
   *  answers the same organization's again with the same project, and opens the project's own saga
   *  on its root (src/project/processor.ts seeds it from the template — the dash watches that
   *  facet's live state). A grant narrowed to named projects creates none: FORBIDDEN. */
  async create(input: {
    project: string;
    orgId?: string;
    restoreProjectId?: string;
    configRepoTemplate?: string;
  }): Promise<IterateContextRpcTarget> {
    const data = z
      .object({
        project: z.string(),
        orgId: z.string().optional(),
        restoreProjectId: z.string().optional(),
        configRepoTemplate: z.string().transform(normalizeConfigRepoTemplateReference).optional(),
      })
      .parse(input);
    const { reach } = this.#session.authority;
    if (typeof reach === "object" && "projectIds" in reach)
      throw codedError(
        "FORBIDDEN",
        `this session is ${describeReach(reach)} — creating a project needs a signed-in user or the admin secret`,
      );
    // pinned once, before the durable request: a resumed creation always reads the same tree
    const configRepoTemplate = data.configRepoTemplate
      ? formatConfigRepoTemplateReference(
          await pinPublicGithubTemplate(parseConfigRepoTemplateReference(data.configRepoTemplate)),
        )
      : undefined;
    const project = await this.#session.input.controlPlane.createProject(this.#session.caller, {
      ...data,
      configRepoTemplate,
    });
    return this.#context(project.id);
  }

  /** The project's root context ("/"), by its minted id (`prj_<hex>`) or its slug (a URL's
   *  `/projects/<slug>`, a hostname's label) — the control plane resolves either (`projectIdOf`), and
   *  the id alone goes on: the DO name's host, a grant's list, `whoami()`. A project only — a
   *  context name belongs to `cd`. Outside this session's reach is FORBIDDEN; so is the global
   *  namespace's id (it is no project). The admin secret alone addresses a project the catalog
   *  never heard of, by id (a fresh context of its own). */
  async get(project: string): Promise<IterateContextRpcTarget> {
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
    const { controlPlane } = this.#session.input;
    const { reach } = this.#session.authority;
    const id = await controlPlane.projectIdOf(address.projectId);
    if (!(await controlPlane.reachesProject(reach, id)))
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(project)}): outside this session's reach — ${describeReach(reach)}`,
      );
    return this.#context(id);
  }

  #context(projectId: string): IterateContextRpcTarget {
    this.#session.input.onProjectAccess?.(projectId);
    return new IterateContextRpcTarget(
      this.#session.input.contextNamespace,
      DurableObjectNameCodec.parse(projectId),
      this.#sessionTeardown,
      this.#session.input.waitUntil,
      this.#session.caller,
    );
  }
}

/** The people — the operator's catalog (`session.users` refuses everyone else): `list()`,
 *  `get(ref)` by id or email, `create({ email, id? })` — the id pinned for the replay of an older
 *  directory. */
class UserCollectionRpcTarget extends RpcTarget {
  readonly #session: SessionOf;
  constructor(session: SessionOf) {
    super();
    this.#session = session;
  }
  list(): Promise<UserRecord[]> {
    return this.#session.input.controlPlane.listUsers();
  }
  get(ref: string): Promise<UserRecord | null> {
    return this.#session.input.controlPlane.getUser(z.string().min(1).parse(ref));
  }
  async create(input: { email: string; id?: string }): Promise<UserRecord> {
    const data = z
      .object({ email: z.string().trim().min(3), id: z.string().optional() })
      .parse(input);
    return this.#session.input.controlPlane.createUser(this.#session.caller, data);
  }
  /** A provider's subject linked to the user with this email (identity.ts does the same at
   *  sign-in; the replay of an older directory carries the links over). */
  async linkIdentity(input: {
    provider: IdentityProvider;
    subject: string;
    email: string;
  }): Promise<UserRecord> {
    const data = z
      .object({
        provider: IdentityProvider,
        subject: z.string().min(1),
        email: z.string().trim().min(3),
      })
      .parse(input);
    return this.#session.input.controlPlane.linkIdentity(data.provider, data.subject, data.email);
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
