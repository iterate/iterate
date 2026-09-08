// session.ts — the gate and the catalog: what `/api` hands a client BEFORE it holds a context.
//
// THE SESSION SHAPE (apps/os's): a client dials `/api` and holds an `UnauthenticatedSession` whose
// only door is `authenticate()` → a `Session` → `projects` → `list()`, `get(projectId)`,
// `create({ slug })` — get and create vend the project's ROOT `IterateContext` ("/"). Contexts within
// a project are reached from a context with `cd(path)` (absolute by convention, relative resolves).
// One session may hold contexts of many projects; the SessionTeardown (below) is keyed by canonical
// context name so they never undo each other's lends.
//
//   using api = newWebSocketRpcSession("wss://<worker>/api");
//   const itx = api.authenticate().projects.get("my-project");
//   const fresh = await api.authenticate().projects.create({ slug: "another" });
//
// WHO: `authenticate()` with no credentials is the request's control-plane identity — in `open`
// login mode the anonymous user, in `email` mode the session cookie a browser's same-origin socket
// carried (none ⇒ UNAUTHENTICATED); `authenticate({ projectToken })` is a principal bound to ONE
// project (src/principal.ts). Authority is org membership (control-plane/directory.ts): in `email`
// mode `projects.get` admits members only; in `open` mode every project is the anonymous org's and
// the door stays open (the trusted-client doctrine every local proof relies on).
//
// Every class here is a server-side capnweb RpcTarget (the client is JUST capnweb — see
// iterate-context.ts). None of them touches a Durable Object: `projects.get(id)` is addressing (plus
// the directory's membership answer); the first door that reaches a context materializes it.

import { RpcTarget } from "capnweb";
import type { LoginMode } from "./app-config.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import type { Directory, Project } from "./control-plane/directory.ts";
import { IterateContext, type IterateContextNamespace, type WaitUntil } from "./iterate-context.ts";
import { codedError } from "./lib/errors.ts";
import { verifyProjectToken, type Principal } from "./principal.ts";
import { SessionTeardown } from "./session-teardown.ts";

export { SessionTeardown };

/** A control-plane user: the cookie's, or the anonymous one in `open` mode. */
export type SessionUser = { id: string; email: string };
/** Who a session is: a principal, bound to ONE project when it came from a project token. */
export type SessionPrincipal = Principal & { projectId?: string };

/** What every session is built from: the edge's bindings and THIS request's identity. */
export interface SessionInput {
  contextNamespace: IterateContextNamespace;
  waitUntil: WaitUntil;
  directory: Directory;
  loginMode: LoginMode;
  /** The request's control-plane user — the anonymous one (`open`), the cookie's (`email`), or none. */
  user: SessionUser | null;
  /** The secret project tokens verify with (blank ⇒ none does). */
  projectTokenSecret: string;
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
   *  handed it by a gate that checked something). A project token ⇒ a session that knows who it is,
   *  bound to the token's one project (a token that does not verify is refused, coded, the same way
   *  whatever is wrong with it). No credentials ⇒ the request's control-plane user: in `open` mode the
   *  anonymous one — carrying NO principal, identity being attribution and there being none; in `email`
   *  mode the session cookie's user, or UNAUTHENTICATED. */
  async authenticate(credentials?: { projectToken?: string }): Promise<Session> {
    if (credentials?.projectToken) {
      const claims = await verifyProjectToken(
        credentials.projectToken,
        this.#input.projectTokenSecret,
      );
      if (!claims) throw codedError("INVALID_CREDENTIALS", "the project token did not verify");
      const { projectId, actor, email } = claims;
      return new Session(this.#input, this.#sessionTeardown, null, {
        projectId,
        actor,
        ...(email && { email }),
      });
    }
    const { user, loginMode } = this.#input;
    if (!user)
      throw codedError(
        "UNAUTHENTICATED",
        "authenticate(): no session cookie on this request and no project token — sign in at / first",
      );
    return new Session(
      this.#input,
      this.#sessionTeardown,
      user,
      loginMode === "open" ? null : { actor: user.id, email: user.email },
    );
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
class Session extends RpcTarget {
  readonly #projects: ProjectCollection;
  readonly #principal: SessionPrincipal | null;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    user: SessionUser | null,
    principal: SessionPrincipal | null,
  ) {
    super();
    this.#principal = principal;
    this.#projects = new ProjectCollection(input, sessionTeardown, user, principal);
  }

  /** Who this session is: the cookie's user, the token's principal (and its project), or null for
   *  the anonymous one. */
  whoami(): SessionPrincipal | null {
    return this.#principal;
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }
}

/** The project catalog: `list()`, `get(projectId)`, `create({ slug })` — get and create vend the
 *  project's root context. */
class ProjectCollection extends RpcTarget {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  readonly #user: SessionUser | null;
  readonly #principal: SessionPrincipal | null;
  /** The principal a context stamps on events: the session's, minus the token's binding. */
  readonly #contextPrincipal: Principal | null;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    user: SessionUser | null,
    principal: SessionPrincipal | null,
  ) {
    super();
    this.#input = input;
    this.#sessionTeardown = sessionTeardown;
    this.#user = user;
    this.#principal = principal;
    this.#contextPrincipal = principal
      ? { actor: principal.actor, ...(principal.email && { email: principal.email }) }
      : null;
  }

  /** The projects this session's user can reach — a member of the owning org — with their role. */
  list(): Promise<Project[]> {
    return this.#input.directory.listProjects(this.#signedInUser().id);
  }

  /** Create the project named `slug` (slugified: that IS its id) in the user's org — their first,
   *  created on first use — and vend its root context. A name ANY org already holds is refused,
   *  coded (PROJECT_NAME_TAKEN); the user's own again is idempotent. */
  async create(input: { slug: string }): Promise<IterateContext> {
    const user = this.#signedInUser();
    const { directory } = this.#input;
    const org = await directory.ensureOrg(user.id, `${user.email}'s org`);
    const project = await directory.createProject(org.id, input.slug);
    return this.#context(project.id);
  }

  /** The project's root context ("/"). A project ID only — a context name belongs to `cd`. A session
   *  with a project token holds the token's ONE project; in `email` mode a user's session holds the
   *  projects of their orgs (one directory read); in `open` mode the door is open — any project. */
  async get(projectId: string): Promise<IterateContext> {
    const address = DurableObjectNameCodec.parse(projectId);
    if (address.path !== "/")
      throw new Error(
        `projects.get(projectId): got a context name ${JSON.stringify(projectId)} — pass the project id and cd(path) from its root`,
      );
    if (this.#principal?.projectId !== undefined) {
      if (this.#principal.projectId !== address.projectId)
        throw codedError(
          "FORBIDDEN",
          `projects.get(${JSON.stringify(projectId)}): this session's token names project ${JSON.stringify(this.#principal.projectId)}`,
        );
    } else if (this.#input.loginMode === "email") {
      const user = this.#signedInUser();
      const projects = await this.#input.directory.listProjects(user.id);
      if (!projects.some((project) => project.id === address.projectId))
        throw codedError(
          "FORBIDDEN",
          `projects.get(${JSON.stringify(projectId)}): not a project of an org ${user.email} belongs to`,
        );
    }
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
  #signedInUser(): SessionUser {
    if (!this.#user)
      throw codedError(
        "FORBIDDEN",
        "a project token names one project — projects.get(id); list() and create() need a signed-in user",
      );
    return this.#user;
  }
}
