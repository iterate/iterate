// session.ts — the gate and the catalog: what `/api` hands a client BEFORE it holds a context.
//
// THE SESSION SHAPE (apps/os's, verbatim): a client dials `/api` and holds an `UnauthenticatedSession`
// whose only door is `authenticate()` → a `Session` → `projects: ProjectCollection` →
// `get(projectId)` → the project's ROOT `IterateContext` ("/"). Contexts within a project are
// reached from a context with `cd(path)` (absolute by convention, relative resolves). One
// session may hold contexts of many projects; the ContextLeaseBook below owns each context/key
// lease, so replacing one can never tear down a similarly named lease elsewhere.
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
import type { BrowserPrincipal } from "./auth.ts";

type LeaseTarget = { pager?: { dispose(): void }; undo?: () => void };

/** Owns one session's live `{ context name, key }` claims. A lease is also the caller's disposable
 * handle: it forgets itself only if it remains current, releases its pager, then conditionally
 * undoes its durable row. Therefore an old handle is harmless after a reconnect or re-provide. */
export class ContextLeaseBook {
  readonly #leaseByIdentity = new Map<string, { dispose(): void }>();

  lease(contextName: string, key: string, target: LeaseTarget): { dispose(): void } {
    const identity = `${contextName} ${key}`;
    let lease: { dispose(): void };
    lease = {
      dispose: () => {
        const current = this.#leaseByIdentity.get(identity) === lease;
        if (current) this.#leaseByIdentity.delete(identity);
        target.pager?.dispose();
        if (current) target.undo?.();
      },
    };
    const replaced = this.#leaseByIdentity.get(identity);
    this.#leaseByIdentity.set(identity, lease);
    // The new pager has attached before the old lease is released, so the DO cannot see an
    // otherwise healthy reconnect as its key's last pager.
    replaced?.dispose();
    return lease;
  }

  disposeAll(): void {
    for (const lease of this.#leaseByIdentity.values()) lease.dispose();
    this.#leaseByIdentity.clear();
  }
}

/** Kept for the standalone entrypoint while session-owned code uses ContextLeaseBook. */
export { ContextLeaseBook as SessionTeardown };

/** What `/api` serves: nothing but the gate. The ROOT capnweb target, so its lifetime IS the
 *  socket's — capnweb disposes it when the client's session ends, and that is when every stub this
 *  session lent is recalled (the DO-side stubs die with their session instead of lying in the
 *  presence list). */
export class UnauthenticatedSession extends RpcTarget {
  readonly #leases = new ContextLeaseBook(); // held for the session so lent stubs + pager sockets aren't GC'd
  readonly #session: Session;

  constructor(
    contextNamespace: IterateContextNamespace,
    ctx: ExecutionContext,
    principal?: BrowserPrincipal,
  ) {
    super();
    this.#session = new Session(contextNamespace, this.#leases, (p) => ctx.waitUntil(p), principal);
  }

  [Symbol.dispose](): void {
    this.#leases.disposeAll();
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
class Session extends RpcTarget {
  readonly #projects: ProjectCollection;
  readonly #principal: BrowserPrincipal | null;

  constructor(
    contextNamespace: IterateContextNamespace,
    leases: ContextLeaseBook,
    waitUntil: WaitUntil,
    principal?: BrowserPrincipal,
  ) {
    super();
    this.#principal = principal ?? null;
    this.#projects = new ProjectCollection(contextNamespace, leases, waitUntil);
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }

  /** The edge-established identity; entering an email proves no account ownership. */
  identity(): BrowserPrincipal | null {
    return this.#principal;
  }
}

/** The project catalog. `get(projectId)` is pure addressing → that project's ROOT context. No
 *  `list`/`create` yet (owner: not now); when they come they ride a deployment context's events. */
class ProjectCollection extends RpcTarget {
  readonly #contextNamespace: IterateContextNamespace;
  readonly #leases: ContextLeaseBook;
  readonly #waitUntil: WaitUntil;

  constructor(
    contextNamespace: IterateContextNamespace,
    leases: ContextLeaseBook,
    waitUntil: WaitUntil,
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#leases = leases;
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
    return new IterateContext(this.#contextNamespace, address, this.#leases, this.#waitUntil);
  }
}
