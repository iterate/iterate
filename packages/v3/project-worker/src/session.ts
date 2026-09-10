// Public /api starts with an authorized Session. Only /internal/rpc exposes the
// administrator gate. Sessions vend project contexts and own their teardown.

import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { Grants } from "./grants.ts";
import {
  DurableObjectNameCodec,
  IterateContext,
  type IterateContextNamespace,
  type WaitUntil,
} from "./iterate-context.ts";
import { describeReach, type Directory, type Project, type Reach } from "./directory.ts";
import type { AppConfig } from "./app-config.ts";
import { codedError } from "./lib.ts";
import { verifyAdminSecret, type Principal } from "./principal.ts";

/** One DNS-safe name — the directory row, the DO name, the host label; in this deployment a project's
 *  id IS its slug. */
export type ProjectIdOrSlug = string;

/** The operator gate accepts only the deployment administrator credential. */
const SessionCredentials = z.object({
  type: z.literal("admin-secret"),
  secret: z.string(),
  as: z.object({ email: z.email() }).optional(),
});
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

/** The internal operator gate. Its teardown owns every context it vends. */
export class UnauthenticatedSession extends RpcTarget {
  readonly #sessionTeardown = new SessionTeardown(); // held for the session so lent stubs + pager sockets aren't GC'd
  readonly #input: SessionInput;

  constructor(input: SessionInput) {
    super();
    this.#input = input;
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  async authenticate(input: unknown): Promise<Session> {
    const credentials = SessionCredentials.safeParse(input);
    if (!credentials.success)
      throw codedError("INVALID_CREDENTIALS", "The operator RPC door requires the admin secret.");
    const admin = await verifyAdminSecret(
      credentials.data.secret,
      this.#input.appConfig.adminApiSecret,
    );
    if (!admin) throw codedError("INVALID_CREDENTIALS", "The admin secret did not match.");
    const user =
      credentials.data.as && (await this.#input.directory.upsertUser(credentials.data.as.email));
    const principal = user ? { actor: user.id, email: user.email } : admin;
    return new Session(this.#input, this.#sessionTeardown, {
      principal,
      reach: user ? { userId: user.id } : "every",
      projectDoors: this.#input,
    });
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
type SessionAuthority = {
  principal: SessionPrincipal;
  reach: Reach;
  projectDoors: ProjectDoorsInput | null;
  grants?: Grants;
  scopes?: string[];
};

export class Session extends RpcTarget {
  readonly #sessionTeardown: SessionTeardown;
  readonly #projects: ProjectCollection;
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
    const { reach, principal } = this.#authority;
    if (reach === "every") return [];
    const orgs = await this.#input.directory.listOrgs(principal.actor);
    if (!("projectIds" in reach)) return orgs;
    const projects = await this.#input.directory.reachableProjects(reach);
    return orgs.filter((org) => projects.some((project) => project.orgId === org.id));
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
  async create(input: { project: ProjectIdOrSlug }): Promise<IterateContext> {
    const project = await this.#input.directory.createProject(this.#reach, input.project);
    return this.#context(project.id);
  }

  /** The project's root context ("/") — and, on it, the project's two session doors: `mintToken()`
   *  and `rotateApiKey()` (iterate-context.ts), gated by this very admission. A project only — a
   *  context name belongs to `cd`. Outside this session's reach is FORBIDDEN. */
  async get(project: ProjectIdOrSlug): Promise<IterateContext> {
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

  #context(projectId: string): IterateContext {
    this.#input.onProjectAccess?.(projectId);
    return new IterateContext(
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
// register every IterateContext of a session shares, testable in the node lane.

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
