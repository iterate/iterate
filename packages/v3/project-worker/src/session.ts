// session.ts — the gate and the catalog: what `/api` hands a client BEFORE it holds a context (the
// apps/os shape): `UnauthenticatedSession.authenticate(credentials)` → `Session` → `projects` →
// `list()`, `get(project)`, `create({ project })` — get and create vend the project's ROOT
// `IterateContext`, and `cd(path)` reaches the rest. One session may hold contexts of many projects;
// the SessionTeardown is keyed by context name so they never undo each other's lends.
//   session teardown — `SessionTeardown`: what a session must undo at its end, one entry per key
//
//   using api = newWebSocketRpcSession("wss://<worker>/api");
//   const itx = api.authenticate({ type: "from-server-cookie" }).projects.get("my-project");
//   const fresh = await api.authenticate({ type: "project-token", token }).projects.get("my-project");
//
// Authority is org membership (control-plane.ts) — membership being whatever `/login` was told (the
// demo login form verifies nothing, so a cookie is attribution, not authentication) — except for a
// project token, which names its one project, and the admin secret, which reaches every project.
//
// Every class here is a server-side capnweb RpcTarget (the client is JUST capnweb — iterate-context.ts).
// None of them touches a Durable Object: `projects.get(project)` is addressing (plus the directory's
// membership answer); the first door that reaches a context materializes it.

import { RpcTarget } from "capnweb";
import { isSameOriginBrowserRequest } from "./worker.ts";
import {
  DurableObjectNameCodec,
  IterateContext,
  type IterateContextNamespace,
  type WaitUntil,
} from "./iterate-context.ts";
import type { Directory, Project, Session as ControlPlaneSession } from "./control-plane.ts";
import { codedError } from "./lib.ts";
import { verifyAdminSecret, verifyProjectToken, type Principal } from "./principal.ts";

/** One DNS-safe name — the directory row, the DO name, the host label; in this deployment a project's
 *  id IS its slug. */
export type ProjectIdOrSlug = string;

/** What a client hands `authenticate` — where its identity already is, or the secret that proves it.
 *  `from-server-cookie`: the control plane's session cookie rode this socket's handshake (a browser
 *  cannot set a header on a WebSocket; the call names the cookie, and the cookie counts on a
 *  same-origin request only). `project-token`: a short-lived signed claim, ONE user on ONE project
 *  (principal.ts — a project host's cookie, a script's bearer). `project-secret`: the project's own
 *  long-lived key (a device, a headless app) — step 2 of the auth plan, refused until then.
 *  `admin-secret`: the deployment's `APP_CONFIG_ADMIN_API_SECRET` — every project (the e2e lane,
 *  tooling); with `as`, a user's session without a login: the cookie's claims unsigned — `sub`
 *  (`user_<email>` in this directory) and `email`. */
export type SessionCredentials =
  | { type: "from-server-cookie" }
  | { type: "project-token"; token: string }
  | { type: "project-secret"; project: ProjectIdOrSlug; secret: string }
  | { type: "admin-secret"; secret: string; as?: { sub: string; email: string } };

/** Who a session is: a principal, bound to ONE project when it came from a project token. The admin
 *  secret's is `{ actor: "admin" }`. */
export type SessionPrincipal = Principal & { projectId?: string };

/** What every session is built from: the edge's bindings and THIS request. */
export interface SessionInput {
  contextNamespace: IterateContextNamespace;
  waitUntil: WaitUntil;
  directory: Directory;
  /** The request that dialled `/api` — its `Origin` is what `from-server-cookie` checks
   *  (`isSameOriginBrowserRequest`, worker.ts). */
  request: Pick<Request, "url" | "headers">;
  /** The request's control-plane user — the session cookie's (control-plane.ts `identity`), or null. */
  user: ControlPlaneSession | null;
  /** The secret project tokens verify with (blank ⇒ none does). */
  projectTokenSecret: string;
  /** The deployment's admin secret (`APP_CONFIG_ADMIN_API_SECRET`). */
  adminApiSecret: string;
}

/** What `/api` serves: nothing but the gate. The ROOT capnweb target, so its lifetime IS the
 *  socket's — capnweb disposes it when the client's session ends, and that is when every stub this
 *  session lent is recalled (the DO-side stubs die with their session instead of lying in the
 *  presence list). */
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

  /** THE introduction door (the `authenticate()` pattern: the only way to hold authority is to be
   *  handed it by a gate that checked something). Each credential kind (`SessionCredentials`) has
   *  its check and its refusal, coded: the cookie on a cross-origin browser request, or no cookie at
   *  all, is `UNAUTHENTICATED`; a token or a secret that does not verify is `INVALID_CREDENTIALS`,
   *  whatever is wrong with it; a kind this deployment does not serve yet is `UNSUPPORTED_CREDENTIAL`.
   *  The admin's `as` upserts the user's directory row as `/login` does, so membership works. */
  async authenticate(credentials: SessionCredentials): Promise<Session> {
    const { request, user, directory, projectTokenSecret, adminApiSecret } = this.#input;
    switch (credentials.type) {
      case "from-server-cookie": {
        if (!isSameOriginBrowserRequest(request))
          throw codedError(
            "UNAUTHENTICATED",
            `authenticate({ type: "from-server-cookie" }): the session cookie counts on a same-origin request only — this one's Origin is ${JSON.stringify(request.headers.get("origin"))}`,
          );
        if (!user)
          throw codedError(
            "UNAUTHENTICATED",
            'authenticate({ type: "from-server-cookie" }): no session cookie on this request — sign in at / first',
          );
        return this.#sessionOf(user);
      }
      case "project-token": {
        const claims = await verifyProjectToken(credentials.token, projectTokenSecret);
        if (!claims) throw codedError("INVALID_CREDENTIALS", "the project token did not verify");
        const { projectId, actor, email } = claims;
        return new Session(this.#input, this.#sessionTeardown, null, {
          projectId,
          actor,
          ...(email && { email }),
        });
      }
      case "project-secret":
        throw codedError("UNSUPPORTED_CREDENTIAL", "project secrets arrive in step 2");
      case "admin-secret": {
        if (!(await verifyAdminSecret(credentials.secret, adminApiSecret)))
          throw codedError("INVALID_CREDENTIALS", "the admin secret did not match");
        if (!credentials.as)
          return new Session(this.#input, this.#sessionTeardown, null, { actor: "admin" });
        const { sub, email } = credentials.as;
        await directory.upsertUser(email);
        return this.#sessionOf({ sub, email, iat: Math.floor(Date.now() / 1000) });
      }
    }
  }

  /** A control-plane user's session — the cookie's user, or the admin's `as`. */
  #sessionOf(user: ControlPlaneSession): Session {
    return new Session(this.#input, this.#sessionTeardown, user, {
      actor: user.sub,
      email: user.email,
    });
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
class Session extends RpcTarget {
  readonly #projects: ProjectCollection;
  readonly #principal: SessionPrincipal;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    user: ControlPlaneSession | null,
    principal: SessionPrincipal,
  ) {
    super();
    this.#principal = principal;
    this.#projects = new ProjectCollection(input, sessionTeardown, user, principal);
  }

  /** Who this session is: the user (the cookie's, the admin's `as`), the token's principal (and its
   *  project), or `{ actor: "admin" }`. */
  whoami(): SessionPrincipal {
    return this.#principal;
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }
}

/** The project catalog: `list()`, `get(project)`, `create({ project })` — get and create vend the
 *  project's root context. What a session reaches is what its credential earned (`authenticate`): a
 *  control-plane user (the cookie's, the admin's `as`) reaches the projects of their orgs; a project
 *  token reaches its one project; the admin secret — no user, no token — reaches every project. */
class ProjectCollection extends RpcTarget {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  readonly #user: ControlPlaneSession | null;
  readonly #principal: SessionPrincipal;
  /** The admin secret's session: no user, no token — every project. */
  readonly #admin: boolean;
  /** The principal a context stamps on events: the session's, minus the token's binding. */
  readonly #contextPrincipal: Principal;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    user: ControlPlaneSession | null,
    principal: SessionPrincipal,
  ) {
    super();
    this.#input = input;
    this.#sessionTeardown = sessionTeardown;
    this.#user = user;
    this.#principal = principal;
    this.#admin = user === null && principal.projectId === undefined;
    this.#contextPrincipal = {
      actor: principal.actor,
      ...(principal.email && { email: principal.email }),
    };
  }

  /** The projects this session can reach: the projects of the orgs the user belongs to, with their
   *  role — or, for the admin secret, every project in the directory (no role). */
  list(): Promise<Project[]> {
    const { directory } = this.#input;
    if (this.#admin) return directory.listAllProjects();
    return directory.listProjects(this.#signedInUser().sub);
  }

  /** Create the project named `project` (slugified: that IS its id) — in the user's org (the first
   *  by name when they have several, created on first use when they have none), or in the
   *  deployment's own org for the admin secret — and vend its root context. A name ANY org already
   *  holds is refused, coded (PROJECT_NAME_TAKEN); the same org's again is idempotent. */
  async create(input: { project: ProjectIdOrSlug }): Promise<IterateContext> {
    const { directory } = this.#input;
    const user = this.#admin ? null : this.#signedInUser();
    const org = user
      ? await directory.ensureOrg(user.sub, `${user.email}'s org`)
      : await directory.adminOrg();
    const project = await directory.createProject(org.id, input.project);
    return this.#context(project.id);
  }

  /** The project's root context ("/"). A project only — a context name belongs to `cd`. A session
   *  with a project token holds the token's ONE project; a user's session holds the projects of
   *  their orgs (one directory read); the admin secret's holds any. */
  async get(project: ProjectIdOrSlug): Promise<IterateContext> {
    const address = DurableObjectNameCodec.parse(project);
    if (address.path !== "/")
      throw new Error(
        `projects.get(project): got a context name ${JSON.stringify(project)} — pass the project and cd(path) from its root`,
      );
    if (this.#principal.projectId !== undefined) {
      if (this.#principal.projectId !== address.projectId)
        throw codedError(
          "FORBIDDEN",
          `projects.get(${JSON.stringify(project)}): this session's token names project ${JSON.stringify(this.#principal.projectId)}`,
        );
    } else if (this.#user) {
      const projects = await this.#input.directory.listProjects(this.#user.sub);
      if (!projects.some((candidate) => candidate.id === address.projectId))
        throw codedError(
          "FORBIDDEN",
          `projects.get(${JSON.stringify(project)}): not a project of an org ${this.#user.email} belongs to`,
        );
    } // the admin secret: every project
    return this.#context(address.projectId);
  }

  #context(projectId: string): IterateContext {
    return new IterateContext(
      this.#input.contextNamespace,
      DurableObjectNameCodec.parse(projectId),
      this.#sessionTeardown,
      this.#input.waitUntil,
      this.#contextPrincipal,
    );
  }

  /** The catalog's writer and reader: a control-plane user. A project-token session has none — it
   *  holds one project and reaches it with `get`. */
  #signedInUser(): ControlPlaneSession {
    if (!this.#user)
      throw codedError(
        "FORBIDDEN",
        "a project token names one project — projects.get(project); list() and create() need a signed-in user",
      );
    return this.#user;
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
