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
import { IterateContext, type ContextNamespace, type WaitUntil } from "./iterate-context.ts";

/** WHAT THIS SESSION MUST UNDO AT ITS END — ONE entry per key: a lend relay (the session's copy of
 *  a client stub plus its pager socket, held so neither is GC'd) and anything else scoped to the
 *  session (an anonymous subscription's removal). THE CALLER OWNS THE KEY: one session spans every
 *  IterateContext it hands out, and a capability path is only unique PER CONTEXT, so IterateContext
 *  keys by the composite `"<contextName> <capabilityPath>"` (see #teardownKey) — the bare path would
 *  let two contexts lending at the same path recall each other's stub. Re-adding the SAME key is a
 *  TRANSPORT REPLACEMENT (a re-lend at the same context + path — a reconnect): by the time the new
 *  relay's pager is open, the DO has already dropped the old transport as "replaced", so disposing
 *  the incumbent here is a harmless double-close that just keeps this map from accumulating dead
 *  relays. */
export class SessionTeardown {
  readonly #undo = new Map<string, { dispose(): void }>();
  add(key: string, undo: { dispose(): void }): void {
    this.#undo.get(key)?.dispose();
    this.#undo.set(key, undo);
  }
  dispose(key: string): void {
    const undo = this.#undo.get(key);
    if (!undo) return;
    this.#undo.delete(key);
    undo.dispose();
  }
  disposeAll(): void {
    for (const undo of this.#undo.values()) undo.dispose();
    this.#undo.clear();
  }
}

/** What `/api` serves: nothing but the gate. The ROOT capnweb target, so its lifetime IS the
 *  socket's — capnweb disposes it when the client's session ends, and that is when every stub this
 *  session lent is recalled (the DO-side stubs die with their session instead of lying in the
 *  presence list). */
export class UnauthenticatedSession extends RpcTarget {
  readonly #teardown = new SessionTeardown(); // held for the session so lent stubs + pager sockets aren't GC'd
  readonly #session: Session;

  constructor(contexts: ContextNamespace, ctx: ExecutionContext) {
    super();
    this.#session = new Session(contexts, this.#teardown, (p) => ctx.waitUntil(p));
  }

  [Symbol.dispose](): void {
    this.#teardown.disposeAll();
  }

  /** THE introduction door (the `authenticate()` pattern: the only way to hold authority is to be
   *  handed it by a gate that checked something). Deliberately a NO-OP today — this is where the
   *  real credential check lands without changing any caller: clients already spell
   *  `api.authenticate(credentials).projects.get(id)`. */
  authenticate(_credentials?: unknown): Session {
    return this.#session;
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
export class Session extends RpcTarget {
  readonly #projects: ProjectCollection;

  constructor(contexts: ContextNamespace, teardown: SessionTeardown, waitUntil: WaitUntil) {
    super();
    this.#projects = new ProjectCollection(contexts, teardown, waitUntil);
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }
}

/** The project catalog. `get(projectId)` is pure addressing → that project's ROOT context. No
 *  `list`/`create` yet (owner: not now); when they come they ride a deployment context's events. */
export class ProjectCollection extends RpcTarget {
  readonly #contexts: ContextNamespace;
  readonly #teardown: SessionTeardown;
  readonly #waitUntil: WaitUntil;

  constructor(contexts: ContextNamespace, teardown: SessionTeardown, waitUntil: WaitUntil) {
    super();
    this.#contexts = contexts;
    this.#teardown = teardown;
    this.#waitUntil = waitUntil;
  }

  /** The project's root context ("/") — pure addressing, no DO is reached. A project ID only — a
   *  context name belongs to `cd`. */
  get(projectId: string): IterateContext {
    const address = DurableObjectNameCodec.parse(projectId);
    if (address.path !== "/")
      throw new Error(
        `projects.get(projectId): got a context name ${JSON.stringify(projectId)} — pass the project id and cd(path) from its root`,
      );
    return new IterateContext(this.#contexts, address, this.#teardown, this.#waitUntil);
  }
}
