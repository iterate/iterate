// Public /api starts with an authorized Session. Only /internal/rpc exposes the
// administrator gate. Sessions vend project contexts and own their teardown.

import { RpcTarget } from "capnweb";
import { z } from "zod";
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
import { codedError } from "./lib.ts";
import { verifyAdminSecret, type Principal } from "./principal.ts";
import { authenticatedEvent } from "./account/contract.ts";

/** One DNS-safe name — the directory row, the DO name, the host label; in this deployment a project's
 *  id IS its slug. */
export type ProjectIdOrSlug = string;

/** What `IterateRpcTarget.authenticate` accepts. `from-server-cookie` is the browser: the OAuth gate
 *  already resolved the session from the request, so this only says "hand me that session".
 *  `admin-secret` is the operator/CLI credential, verified in-band. (Project-secret/token variants
 *  follow.) */
const SessionCredentials = z.discriminatedUnion("type", [
  z.object({ type: z.literal("from-server-cookie") }),
  z.object({
    type: z.literal("admin-secret"),
    secret: z.string(),
    as: z.object({ email: z.email() }).optional(),
  }),
]);
export type SessionCredentials = z.infer<typeof SessionCredentials>;

/** The verified user or configured administrator acting through this session. */
export type SessionPrincipal = Principal;

/** What the two project doors a vended context carries — `mintToken` signs with the configuration's
 *  token secret, `rotateApiKey` writes the key hash to `SECRETS_KV` (iterate-context.ts) — sign
 *  and write with. */
export type ProjectDoorsInput = Pick<SessionInput, "appConfig" | "secretsKv">;

/** What every session is built from: the edge's bindings, the configuration and THIS request. */
export interface SessionInput {
  contextNamespace: IterateContextNamespace;
  waitUntil: WaitUntil;
  directory: Directory;
  /** Configuration for operator authentication and context capabilities. */
  appConfig: AppConfig;
  /** Storage for the operator's project credential capabilities. */
  secretsKv: KVNamespace;
  /** A live transport tracks projects whose capabilities it has handed out. */
  onProjectAccess?: (projectId: string) => void;
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
        "authenticate({ type }): 'from-server-cookie' (browser) or 'admin-secret' (operator).",
      );
    if (credentials.data.type === "from-server-cookie") {
      if (!this.#resolved)
        throw codedError("UNAUTHENTICATED", "this transport carries no session — sign in first.");
      this.#publishAuthenticationFact(this.#resolved.principal, "from-server-cookie");
      return new SessionRpcTarget(this.#input, this.#sessionTeardown, this.#resolved);
    }
    const admin = await verifyAdminSecret(
      credentials.data.secret,
      this.#input.appConfig.adminApiSecret,
    );
    if (!admin) throw codedError("INVALID_CREDENTIALS", "The admin secret did not match.");
    // Test/operator fixture only; product impersonation must retain operator attribution.
    const user =
      credentials.data.as && (await this.#input.directory.upsertUser(credentials.data.as.email));
    const principal = user ? { actor: user.id, email: user.email } : admin;
    this.#publishAuthenticationFact(principal, "admin-secret");
    return new SessionRpcTarget(this.#input, this.#sessionTeardown, {
      principal,
      reach: user ? { userId: user.id } : "every",
      projectDoors: this.#input,
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
    const name = DurableObjectNameCodec.stringify({
      projectId: GLOBAL_PROJECT_ID,
      path: `/users/${principal.actor}`,
    });
    const fact = authenticatedEvent({ credential, at: Date.now(), operationId: crypto.randomUUID() });
    this.#input.waitUntil(
      (
        this.#input.contextNamespace
          .getByName(name)
          .invoke(["itx", ["append", fact]], [], { principal }) as Promise<unknown>
      ).then(
        () => undefined,
        () => undefined,
      ),
    );
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
type SessionAuthority = {
  principal: SessionPrincipal;
  reach: Reach;
  projectDoors: ProjectDoorsInput | null;
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
      authority.principal,
      authority.reach,
      authority.projectDoors,
    );
    this.#organizations = new OrganizationCollection((orgId) =>
      this.#globalContext(`/organizations/${orgId}`),
    );
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
    };
  }

  async orgs() {
    const { reach } = this.#authority;
    if (reach === "every" || !("userId" in reach)) return [];
    const orgs = await this.#input.directory.listOrgs(reach.userId);
    if (!("projectIds" in reach)) return orgs;
    const projects = await this.#input.directory.reachableProjects(reach);
    return orgs.filter((org) => projects.some((project) => project.orgId === org.id));
  }

  /** The same directory operation is available to any unrestricted user grant. */
  createOrg(name: string) {
    const { reach } = this.#authority;
    if (reach === "every" || "projectIds" in reach)
      throw codedError(
        "FORBIDDEN",
        "An unrestricted user session is required to create an organization.",
      );
    return this.#input.directory.createOrg(reach.userId, z.string().trim().min(1).parse(name));
  }

  get consent() {
    if (!this.#authority.consent)
      throw codedError("FORBIDDEN", "Sign in to Iterate to approve access.");
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
   *  returns the directory rows; this vends the org's context. */
  get organizations(): OrganizationCollection {
    return this.#organizations;
  }

  /** The signed-in human's own context in the deployment-global namespace — an ORDINARY
   *  IterateContextRpcTarget at `(global, /users/<userId>)`, the exact surface a project context
   *  has (`session.user` is `session.projects.get(...)` one namespace over). A getter, like
   *  `projects`. Refused for the admin/project credentials — they name no human. Carries NO project
   *  doors (a user context mints no project token, rotates no key). */
  get user(): IterateContextRpcTarget {
    const { principal } = this.#authority;
    if (!principal.email)
      throw codedError(
        "FORBIDDEN",
        "this credential identifies no user — the admin and project credentials name no `.user` context",
      );
    return this.#globalContext(`/users/${principal.actor}`);
  }

  /** A context in the deployment-global namespace (the control plane's own): an ordinary
   *  IterateContextRpcTarget at `(GLOBAL_PROJECT_ID, path)`, carrying this session's principal and NO
   *  project doors. Which global paths a caller may reach is the path-mask access policy — NOT YET
   *  ENFORCED: for now any authenticated caller can reach any global path, and the naughty things
   *  that lets them do are captured as failing tests (see the security spec), to be fixed later. */
  #globalContext(path: string): IterateContextRpcTarget {
    return new IterateContextRpcTarget(
      this.#input.contextNamespace,
      DurableObjectNameCodec.parse(
        DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path }),
      ),
      this.#sessionTeardown,
      this.#input.waitUntil,
      this.#authority.principal,
      null,
    );
  }
}

/** The organization catalog: `get(orgId)` vends an organization's context in the deployment-global
 *  namespace. Thin — it holds only a factory for `(global, /organizations/<orgId>)`; which orgs a
 *  caller may reach is the path-mask access policy (NOT YET ENFORCED — captured as failing tests). */
class OrganizationCollection extends RpcTarget {
  readonly #context: (orgId: string) => IterateContextRpcTarget;

  constructor(context: (orgId: string) => IterateContextRpcTarget) {
    super();
    this.#context = context;
  }

  get(orgId: string): IterateContextRpcTarget {
    return this.#context(z.string().trim().min(1).parse(orgId));
  }
}

/** The project catalog: `list()`, `get(project)`, `create({ project })` — get and create vend the
 *  project's root context. What a session reaches is its `Reach` (control-plane.ts): every project,
 *  the projects of the user's orgs, or the projects named outright. */
class ProjectCollection extends RpcTarget {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  readonly #reach: Reach;
  /** The verified principal stamped on context events. */
  readonly #contextPrincipal: Principal;
  /** Only operator-created sessions carry the legacy project credential capabilities. */
  readonly #projectDoors: ProjectDoorsInput | null;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    principal: SessionPrincipal,
    reach: Reach,
    projectDoors: ProjectDoorsInput | null,
  ) {
    super();
    this.#input = input;
    this.#sessionTeardown = sessionTeardown;
    this.#reach = reach;
    this.#projectDoors = projectDoors;
    this.#contextPrincipal = principal;
  }

  /** The projects this session reaches, as directory rows: the projects of the orgs the user
   *  belongs to, with their role; the one project a bound session names (its row, no role — none
   *  when the directory never heard of it); for the admin secret, every project (no role). */
  list(): Promise<Project[]> {
    return this.#input.directory.reachableProjects(this.#reach);
  }

  /** Create the project named `project` (slugified: that IS its id) — in the user's org (the first
   *  by name when they have several, created on first use when they have none), or in the
   *  deployment's own org for the admin secret — and vend its root context. A bound session (a
   *  project token, the project secret) creates none: FORBIDDEN. A name ANY org already holds is
   *  refused, coded (PROJECT_NAME_TAKEN); the same org's again is idempotent. */
  async create(input: { project: ProjectIdOrSlug; orgId?: string }): Promise<IterateContextRpcTarget> {
    const data = z.object({ project: z.string(), orgId: z.string().optional() }).parse(input);
    const project = await this.#input.directory.createProject(
      this.#reach,
      data.project,
      data.orgId,
    );
    return this.#context(project.id);
  }

  /** The project's root context ("/") — and, on it, the project's two session doors: `mintToken()`
   *  and `rotateApiKey()` (iterate-context.ts), gated by this very admission. A project only — a
   *  context name belongs to `cd`. Outside this session's reach is FORBIDDEN. */
  async get(project: ProjectIdOrSlug): Promise<IterateContextRpcTarget> {
    const address = DurableObjectNameCodec.parse(project);
    if (address.path !== "/")
      throw new Error(
        `projects.get(project): got a context name ${JSON.stringify(project)} — pass the project and cd(path) from its root`,
      );
    if (!(await this.#input.directory.reachesProject(this.#reach, address.projectId)))
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(project)}): outside this session's reach — ${describeReach(this.#reach)}`,
      );
    return this.#context(address.projectId);
  }

  #context(projectId: string): IterateContextRpcTarget {
    this.#input.onProjectAccess?.(projectId);
    return new IterateContextRpcTarget(
      this.#input.contextNamespace,
      DurableObjectNameCodec.parse(projectId),
      this.#sessionTeardown,
      this.#input.waitUntil,
      this.#contextPrincipal,
      this.#projectDoors,
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
