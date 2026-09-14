// `serveItx` — serve a NARROWED itx to a browser FROM a project worker or
// Durable Object, over the app's own `/api`, speaking exactly the handshake
// the SDK's session keeper expects (`iterate/client`, `iterate/sdk/itx/react`):
// a Cap'n Web root whose `authenticate()` returns a Session whose
// `projects.get(slug)` is the project. A page on the app's own origin needs
// no configuration — the keeper dials the page's `/api` by default — and
// `useItx()`, `useStreamConnection()`, `useLiveState()` work as on the OS
// dashboard.
//
// The caller decides WHO the visitor is before calling this and WHAT they may
// reach: `scope.surface` lists the members served, as dotted paths down to
// each method. The platform side is `project.scope({ path, surface: roots })`
// — a project-confined, non-admin itx exposing only those roots; this module
// is the member-level allowlist. The credential the browser presents to
// `authenticate()` is not authority here and is ignored.
//
// WHY A RELAY: a Cap'n Web session cannot serialize a Workers-RPC stub, so
// the served project is a tree of small Cap'n Web targets built from the
// served members: each leaf forwards its call onto the stub, browser callbacks
// are retained and re-wrapped as plain functions, and a stub a call returns
// (a connection handle) is wrapped so its methods stay callable. Anything not
// listed does not exist on the served project at all.
import {
  RpcTarget,
  newHttpBatchRpcResponse,
  newWorkersWebSocketRpcResponse,
} from "./sdk/capnweb/index.ts";
import type { ItxAuthCredentials, Project } from "./itx-api.generated.ts";

export type ServeItxOptions = {
  /** The worker's own itx (`this.itx`, `await env.ITX.get()`). Never reaches the browser. */
  project: Project;
  /**
   * What the browser gets. `surface` lists the members served as DOTTED
   * paths down to each METHOD: a leaf is called, so an object-valued member
   * is listed through to its methods — `"agent.liveState.get"` and
   * `"agent.liveState.subscribe"`, never `"agent.liveState"`. A bare root
   * cannot be relayed because its members are unknown here.
   */
  scope: { path: string; surface: string[] };
};

/**
 * Answer an app's `/api` request with an itx session for one narrowed scope.
 * Call it from `fetch` after deciding who the visitor is:
 *
 *   if (url.pathname === "/api") {
 *     return await serveItx(request, {
 *       project: await this.env.ITX.get(),
 *       scope: {
 *         path: `/agents/web/${visitorIdFrom(request)}`,
 *         surface: [
 *           "agent.message",
 *           "agent.liveState.get",
 *           "agent.liveState.subscribe",
 *           "agent.stream.openConnection",
 *         ],
 *       },
 *     });
 *   }
 *
 * WebSocket upgrades carry the live session (stream connections, live
 * state); `POST` answers the client's HTTP-batch transport.
 */
export async function serveItx(request: Request, options: ServeItxOptions): Promise<Response> {
  const { path, surface } = options.scope;
  const roots = [...new Set(surface.map((entry) => entry.split(".", 1)[0]!))];
  const served = relayServedProject(options.project.scope({ path, surface: roots }), surface);
  const root = new ServedItxRoot(new ServedItxSession(served));
  if (request.method === "POST") return await newHttpBatchRpcResponse(request, root);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint accepts WebSocket upgrades and POST batches.", {
      status: 400,
    });
  }
  return newWorkersWebSocketRpcResponse(request, root);
}

// ─────────────────────────────────────────────────────────────────────────────
// The relay.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The served project: the relay tree over a scoped stub for these dotted
 * members. Exported for the relay's own tests; callers use `serveItx`.
 * @internal
 */
export function relayServedProject(scoped: unknown, surface: readonly string[]): RpcTarget {
  return relayNode(scoped, [], surfaceTree(surface));
}

const LEAF = Symbol("served member");
type SurfaceTree = { [member: string]: SurfaceTree | typeof LEAF };

/** `["agent.message", "agent.stream.openConnection"]` → nested member tree. */
function surfaceTree(surface: readonly string[]): SurfaceTree {
  const tree: SurfaceTree = {};
  for (const entry of surface) {
    const segments = entry.split(".");
    if (segments.length < 2) {
      throw new Error(
        `serveItx cannot relay the bare root "${entry}": list the members to serve as dotted paths, e.g. "${entry}.someMethod"`,
      );
    }
    let node = tree;
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const existing = node[segment];
      if (last) {
        if (existing !== undefined && existing !== LEAF) {
          throw new Error(`serveItx: "${entry}" is both a member and a branch of the surface`);
        }
        node[segment] = LEAF;
      } else {
        if (existing === LEAF) {
          throw new Error(`serveItx: "${entry}" is both a member and a branch of the surface`);
        }
        node = existing ?? (node[segment] = {});
      }
    }
  }
  return tree;
}

/**
 * One node of the served project: a real Cap'n Web target whose PROTOTYPE
 * carries exactly the served members — a method per leaf, a getter per
 * branch — plus `__describe`, which forwards so the platform's restricted
 * description comes back unchanged. A leaf IS a method call: an
 * object-valued member (`liveState`) must appear as a branch, i.e. listed
 * through to its methods.
 */
function relayNode(stub: unknown, path: string[], tree: SurfaceTree): RpcTarget {
  class ServedNode extends RpcTarget {}
  for (const [member, child] of Object.entries(tree)) {
    Object.defineProperty(
      ServedNode.prototype,
      member,
      child === LEAF
        ? {
            configurable: true,
            value: (...args: unknown[]) => forward(stub, [...path, member], args),
            writable: true,
          }
        : { configurable: true, get: () => relayNode(stub, [...path, member], child) },
    );
  }
  Object.defineProperty(ServedNode.prototype, "__describe", {
    configurable: true,
    value: () => forward(stub, [...path, "__describe"], []),
    writable: true,
  });
  return new ServedNode();
}

/**
 * Walk `path` on the Workers-RPC stub (pipelined) and call the last segment
 * — as a genuine member call: extracting the method and `apply`ing it would
 * make the stub's proxy dial a remote member named "apply" with the stub
 * itself as an argument, which workerd refuses to serialize.
 */
async function forward(stub: unknown, path: string[], args: unknown[]): Promise<unknown> {
  let target = stub as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    target = target[segment] as Record<string, unknown>;
  }
  const callable = target as Record<string, (...callArgs: unknown[]) => unknown>;
  return relayResult(await callable[path.at(-1)!]!(...args.map((arg) => relayArgument(arg))));
}

/**
 * A browser callback arrives as a Cap'n Web stub function; the platform can
 * only call back a plain function, so wrap it. Plain data passes through,
 * recursively, because callbacks ride inside option objects.
 */
function relayArgument(value: unknown): unknown {
  if (typeof value === "function") {
    // Cap'n Web releases a call's argument stubs when the call returns; a
    // callback the platform keeps for a connection's lifetime must be
    // retained past that — `dup()` is the stub's own way to say so. The
    // duplicate is released with the session.
    const stub = value as unknown as { dup?: () => unknown };
    const callback = (typeof stub.dup === "function" ? stub.dup() : value) as (
      ...callbackArgs: unknown[]
    ) => unknown;
    return (...callbackArgs: unknown[]) => callback(...callbackArgs);
  }
  if (Array.isArray(value)) return (value as unknown[]).map((entry) => relayArgument(entry));
  if (isPlainObject(value)) {
    const relayed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) relayed[key] = relayArgument(entry);
    return relayed;
  }
  return value;
}

/** A stub a call returned (a connection handle) is wrapped so its methods stay callable. */
function relayResult(value: unknown): unknown {
  return isWorkersRpcStub(value) ? new RelayedStub(value) : value;
}

/**
 * Workers-RPC stubs are callable proxies (`typeof` says "function") that
 * implement the dispose protocol; plain data has `Object.prototype` (or no
 * prototype), arrays are arrays, and a plain function has no disposer.
 * `cloudflare:workers` does not export the stub class to type against, so
 * the check is structural.
 */
function isWorkersRpcStub(value: unknown): value is Disposable {
  return (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    !Array.isArray(value) &&
    !isPlainObject(value) &&
    typeof (value as Partial<Disposable>)[Symbol.dispose] === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Names common protocols probe on any object; never forwarded. */
const NEVER_FORWARDED: ReadonlySet<string> = new Set([
  "then",
  "toJSON",
  "asymmetricMatch",
  "constructor",
  "dup",
  "onRpcBroken",
]);

/**
 * A stub a served call returned, as a Cap'n Web target: every unknown member
 * is a method forwarding onto the stub (a connection handle's `close()`,
 * `ping()`). Data properties of such a stub are not readable through the
 * relay — methods only.
 */
class RelayedStub extends RpcTarget {
  readonly #stub: Disposable;
  constructor(stub: Disposable) {
    super();
    this.#stub = stub;
  }
  static stubOf(relayed: RelayedStub): Disposable {
    return relayed.#stub;
  }
}
Object.setPrototypeOf(
  RelayedStub.prototype,
  new Proxy(Object.create(RpcTarget.prototype) as object, {
    get(hopTarget, key, receiver) {
      if (typeof key === "symbol" || key in hopTarget || NEVER_FORWARDED.has(key)) {
        return Reflect.get(hopTarget, key, receiver);
      }
      if (!(receiver instanceof RelayedStub)) return undefined;
      return (...args: unknown[]) => forward(RelayedStub.stubOf(receiver), [key], args);
    },
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// The root the stock client expects.
// ─────────────────────────────────────────────────────────────────────────────

class ServedItxProjects extends RpcTarget {
  readonly #project: RpcTarget;

  constructor(project: RpcTarget) {
    super();
    this.#project = project;
  }

  /** The served project, whatever slug the page addresses it by. */
  get(_slug: string): RpcTarget {
    return this.#project;
  }
}

class ServedItxSession extends RpcTarget {
  readonly #projects: ServedItxProjects;

  constructor(project: RpcTarget) {
    super();
    this.#projects = new ServedItxProjects(project);
  }

  get projects(): ServedItxProjects {
    return this.#projects;
  }

  /** Also the session keeper's liveness probe. */
  async __describe() {
    return {
      instructions: "An app-served itx session: projects.get(slug) is the project.",
      children: { projects: "The served projects catalog." },
    };
  }
}

class ServedItxRoot extends RpcTarget {
  readonly #session: ServedItxSession;

  constructor(session: ServedItxSession) {
    super();
    this.#session = session;
  }

  /** The stock client's `authenticate` call. Identity was decided by the caller of `serveItx`. */
  authenticate(_credentials: ItxAuthCredentials): ServedItxSession {
    return this.#session;
  }
}
