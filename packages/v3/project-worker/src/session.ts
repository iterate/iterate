// session.ts — the gate and the catalog: what `/api` hands a client BEFORE it holds a context.
//
// THE SESSION SHAPE (apps/os's, verbatim): a client dials `/api` and holds an `UnauthenticatedSession`
// whose only door is `authenticate()` → a `Session` → `projects: ProjectCollection` →
// `get(projectId)` → the project's ROOT `IterateContext` ("/"). Contexts within a project are
// reached from a context with `cd(path)` (absolute by convention, relative resolves). One
// session may hold contexts of many projects; the SessionTeardown (below) is keyed by canonical
// context name so they never undo each other's lends.
//
//   using api = newWebSocketRpcSession("wss://<worker>/api");
//   const itx = api.authenticate().projects.get("prj_123");
//
// Every class here is a server-side capnweb RpcTarget (the client is JUST capnweb — see
// iterate-context.ts). None of them touches a Durable Object: `projects.get(id)` is pure
// addressing (as is a context's `cd`); the first door that reaches a context materializes it.

import { RpcTarget } from "capnweb";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import { IterateContext, type IterateContextNamespace, type WaitUntil } from "./iterate-context.ts";
import { codedError } from "./lib/errors.ts";
import { verifyProjectToken, type Principal } from "./principal.ts";

/** What a session knows about its holder: the principal, bound to ONE project by the token. */
export type SessionPrincipal = Principal & { projectId: string };

/** WHAT THIS SESSION MUST UNDO AT ITS END — ONE entry per key: a lend relay (the session's copy of
 *  a client stub plus its pager socket, held so neither is GC'd) and anything else scoped to the
 *  session (an anonymous subscription's removal). THE CALLER OWNS THE KEY: one session spans every
 *  IterateContext it hands out, and an rpc stub key is only unique PER CONTEXT, so IterateContext
 *  keys by the composite `"<iterateContextName> <rpcStubKey>"` (see #sessionTeardownKey) — the bare key would
 *  let two contexts lending at the same path recall each other's stub. Re-adding the SAME key is a
 *  TRANSPORT REPLACEMENT (a re-lend at the same context + path — a reconnect): by the time the new
 *  relay's pager is open, the DO has already dropped the old transport as "replaced", so disposing
 *  the incumbent here is a harmless double-close that just keeps this map from accumulating dead
 *  relays. */
export class SessionTeardown {
  readonly #undoByKey = new Map<string, { dispose(): void }>();
  add(key: string, undo: { dispose(): void }): void {
    this.#undoByKey.get(key)?.dispose();
    this.#undoByKey.set(key, undo);
  }
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

/** What `/api` serves: nothing but the gate. The ROOT capnweb target, so its lifetime IS the
 *  socket's — capnweb disposes it when the client's session ends, and that is when every stub this
 *  session lent is recalled (the DO-side stubs die with their session instead of lying in the
 *  presence list). */
export class UnauthenticatedSession extends RpcTarget {
  readonly #sessionTeardown = new SessionTeardown(); // held for the session so lent stubs + pager sockets aren't GC'd
  readonly #contextNamespace: IterateContextNamespace;
  readonly #waitUntil: WaitUntil;
  readonly #projectTokenSecret: string;
  readonly #anonymousSession: Session;

  constructor(
    contextNamespace: IterateContextNamespace,
    ctx: ExecutionContext,
    projectTokenSecret: string,
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#waitUntil = (p) => ctx.waitUntil(p);
    this.#projectTokenSecret = projectTokenSecret;
    this.#anonymousSession = new Session(
      contextNamespace,
      this.#sessionTeardown,
      this.#waitUntil,
      null,
    );
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  /** THE introduction door (the `authenticate()` pattern: the only way to hold authority is to be
   *  handed it by a gate that checked something). No credentials ⇒ the ANONYMOUS session — the one
   *  intra-project code has always held (identity is attribution, not authority). A project token
   *  (src/principal.ts, minted by whoever fronts the users) ⇒ a session that knows who it is,
   *  bound to the token's one project; a token that does not verify is refused, coded, the same way
   *  whatever is wrong with it. */
  async authenticate(credentials?: { projectToken?: string }): Promise<Session> {
    if (!credentials?.projectToken) return this.#anonymousSession;
    const claims = await verifyProjectToken(credentials.projectToken, this.#projectTokenSecret);
    if (!claims) throw codedError("INVALID_CREDENTIALS", "the project token did not verify");
    const { projectId, actor, email } = claims;
    return new Session(this.#contextNamespace, this.#sessionTeardown, this.#waitUntil, {
      projectId,
      actor,
      ...(email && { email }),
    });
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
class Session extends RpcTarget {
  readonly #projects: ProjectCollection;
  readonly #principal: SessionPrincipal | null;

  constructor(
    contextNamespace: IterateContextNamespace,
    sessionTeardown: SessionTeardown,
    waitUntil: WaitUntil,
    principal: SessionPrincipal | null,
  ) {
    super();
    this.#principal = principal;
    this.#projects = new ProjectCollection(contextNamespace, sessionTeardown, waitUntil, principal);
  }

  /** Who this session is: the token's principal and its project, or null for the anonymous one. */
  whoami(): SessionPrincipal | null {
    return this.#principal;
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }
}

/** The project catalog. `get(projectId)` is pure addressing → that project's ROOT context. No
 *  `list`/`create` yet (owner: not now); when they come they ride a deployment context's events. */
class ProjectCollection extends RpcTarget {
  readonly #contextNamespace: IterateContextNamespace;
  readonly #sessionTeardown: SessionTeardown;
  readonly #waitUntil: WaitUntil;
  readonly #principal: SessionPrincipal | null;

  constructor(
    contextNamespace: IterateContextNamespace,
    sessionTeardown: SessionTeardown,
    waitUntil: WaitUntil,
    principal: SessionPrincipal | null,
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#sessionTeardown = sessionTeardown;
    this.#waitUntil = waitUntil;
    this.#principal = principal;
  }

  /** The project's root context ("/") — pure addressing, no DO is reached. A project ID only — a
   *  context name belongs to `cd`. A session with a principal holds the token's ONE project; any
   *  other is refused, coded. */
  get(projectId: string): IterateContext {
    const address = DurableObjectNameCodec.parse(projectId);
    if (address.path !== "/")
      throw new Error(
        `projects.get(projectId): got a context name ${JSON.stringify(projectId)} — pass the project id and cd(path) from its root`,
      );
    if (this.#principal && this.#principal.projectId !== address.projectId)
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(projectId)}): this session's token names project ${JSON.stringify(this.#principal.projectId)}`,
      );
    const { projectId: _boundProject, ...principal } = this.#principal ?? { projectId: "" };
    return new IterateContext(
      this.#contextNamespace,
      address,
      this.#sessionTeardown,
      this.#waitUntil,
      this.#principal ? (principal as Principal) : null,
    );
  }
}
