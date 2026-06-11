// The itx handle: the ONE thing user code ever touches, identical in the
// browser, Node, the REPL, the project worker, itx scripts, and caps
// themselves (spec §5).
//
// A handle is a cheap, ephemeral VIEW over a durable context node. Authority
// is "which context this handle points at" (Law 3) — by construction there
// is nothing here to check: a project handle was either minted by
// connect-time auth, by a global handle narrowing through projects.get()
// (which IS the access check), or by the platform wiring a cap's isolate.
//
// Anatomy:
//   - typed built-ins (the trust kernel): the verbs provideCapability,
//     revokeCapability, describe, extend, invoke — plus super, streams,
//     project, projects, and `fetch`, which is sugar dispatching through the
//     core's `fetch` capability (a shadowable platform default)
//   - a fallthrough Proxy: any unknown name becomes a PathProxy whose
//     terminal call dispatches to the context node's core (node.itx()).
//     itx.slack works because someone provided "slack", not because anything
//     here knows about Slack.

import { RpcTarget } from "cloudflare:workers";
import { RpcStub } from "capnweb";
import { createD1Client } from "sqlfu";
import { PathProxy } from "./path-proxy.ts";
import { ItxError } from "./errors.ts";
import { ItxStreams } from "./capabilities/streams.ts";
import {
  isCapabilityAddress,
  isLocalBareFunction,
  replayPathCall,
  RESERVED_CAPABILITY_NAMES,
  type CapabilityAddress,
  type CapabilityMeta,
  type CapabilityTarget,
  type ItxStub,
  type PathCall,
} from "./itx.ts";
import {
  dialContext,
  extendContext,
  isChildContextAddress,
  journalBaseOf,
  parseItxDurableObjectName,
  projectContextAddress,
} from "./journal.ts";
import {
  getPlatformContext,
  PLATFORM_PROJECT_CONTEXT_ADDRESS,
  PLATFORM_PROJECT_CONTEXT_ID,
} from "./platform-context.ts";
import { GLOBAL_CONTEXT_ID, type ProjectAccess } from "./refs.ts";
import type { CapabilityProvision as CapabilityProvisionContract } from "./types.ts";
import { createShareToken, SHARE_TOKEN_PARAM } from "./http.ts";
import type { AppConfig } from "~/config.ts";
import {
  countAllProjects,
  deleteProject,
  getProjectById,
  getProjectBySlug,
  insertProject,
  listAllProjects,
} from "~/db/queries/.generated/index.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import { isProjectId } from "~/domains/projects/project-id.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";

/**
 * Everything a handle needs, resolved once by the restorer
 * (entrypoint.ts/fetch.ts) from `{ context, access }` props. Live values
 * only — this never serializes (Law 2: the serializable form is ItxProps).
 */
export type ItxRuntime = {
  access: ProjectAccess;
  /** Attribution: which capability's isolate holds this handle, if any —
   * the dotted route, not a display name. */
  capabilityPath?: string;
  config: AppConfig;
  /** "global", a project id, a itx_… child context id, or the
   * platform:project chain root. */
  contextId: string;
  /** How to dial the context node — resolved once by the restorer (the
   * catalog for bare itx_… refs, derivation for projects); null only on
   * global handles. */
  contextAddress: CapabilityAddress | null;
  /** The owning project; null only on global handles. For project contexts
   * this equals contextId; for child contexts the restorer resolved it from
   * the context catalog. */
  projectId: string | null;
  env: Env;
  /** The parent worker's loopback exports (ctx.exports). */
  exports: Record<string, (options: { props: Record<string, unknown> }) => unknown>;
};

/** Whether `prop` resolves through a getter anywhere on the prototype chain. */
function isAccessor(target: object, prop: PropertyKey): boolean {
  for (let node: object | null = target; node; node = Object.getPrototypeOf(node)) {
    const descriptor = Object.getOwnPropertyDescriptor(node, prop);
    if (descriptor) return descriptor.get !== undefined;
  }
  return false;
}

export class ItxHandle extends RpcTarget {
  readonly #runtime: ItxRuntime;

  constructor(runtime: ItxRuntime) {
    super();
    this.#runtime = runtime;
    // Unknown names fall through to the context's capability core. The
    // Proxy wraps the RpcTarget instance (workerd supports this since
    // workerd#3184); real members always win, and registration-time name
    // validation (itx.ts) guarantees caps cannot shadow them.
    return new Proxy(this, {
      get(target, prop, _receiver) {
        if (prop === "then") return undefined;
        // Private-field access inside getters needs receiver === target, so
        // we deliberately do NOT forward the proxy as receiver.
        if (typeof prop === "symbol" || prop in target) {
          const value = Reflect.get(target, prop, target);
          // Bind prototype METHODS so detached calls keep their receiver.
          // Getter results pass through untouched even when callable: the
          // path proxies returned by `project`/`worker` reserve "bind" as a
          // path segment (it reads as undefined), so binding them throws.
          if (typeof value === "function" && !isAccessor(target, prop)) {
            return value.bind(target);
          }
          return value;
        }
        if (RESERVED_CAPABILITY_NAMES.has(prop)) return undefined;
        return target.capability(prop);
      },
    });
  }

  // ---- the trust kernel ---------------------------------------------------

  /**
   * Provide a capability on this handle's context — THE verb: the capability
   * kind carries everything else (durable or live). A bare function or a
   * live stub is session-bound (dies with your connection); an rpc/url
   * address is durable. The entry lives at a PATH: `name` is the 1-segment
   * sugar, `path` shadows one subtree of an inherited cap (longest-prefix
   * dispatch) — exactly one of the two.
   *
   * Returns a provision handle: `revoke()` removes the entry, and
   * `Symbol.dispose` auto-revokes ONLY live provides — dropping the session
   * would have killed those anyway, while a durable provide must outlive the
   * session that created it (session teardown disposes every returned
   * handle), so its disposer is deliberately a no-op.
   */
  async provideCapability(input: {
    name?: string;
    path?: string[];
    /** The capability (types.ts): a serializable rpc/url address, a bare
     * function (auto-wrapped: empty remainder calls it, deeper errors), or
     * anything live — a stub implementing call({ path, args }) itself, or a
     * plain object-of-methods wrapped client-side with asPathCallable. */
    capability: CapabilityTarget;
    /** A sentence for the human/agent who finds this cap (the
     * meta.instructions convention field, lifted by describe()). */
    instructions?: string;
    /** TypeScript declarations for the cap's surface — the machine-facing
     * counterpart of `instructions`; lifted by describe(). */
    types?: string;
    meta?: CapabilityMeta;
  }): Promise<CapabilityProvision> {
    const capability = await resolveLiveCapability(input.capability);
    await this.#itx().provideCapability({ ...input, capability });
    const path = input.path ?? [input.name!];
    return new CapabilityProvision({
      live: !isCapabilityAddress(capability),
      revoke: async () => {
        await this.#itx().revokeCapability({ path });
      },
    });
  }

  /** Remove an entry (exact path match, never prefix; defaults can only be shadowed). */
  async revokeCapability(input: { name?: string; path?: string[] }) {
    return await this.#itx().revokeCapability(input);
  }

  /**
   * The explicit dispatch form of the fallthrough: one core dispatch with
   * the full call path. `itx.invoke({ path: ["slack", "chat", "postMessage"],
   * args: [msg] })` ≡ `itx.slack.chat.postMessage(msg)`. The handle never
   * forwards an origin: that field is the chain's trusted identity channel,
   * set by delegating NODES only.
   */
  async invoke(input: { path: string[]; args: unknown[] }): Promise<unknown> {
    return await this.#itx().invoke({ args: input.args, path: input.path });
  }

  get streams(): ItxStreams {
    // Project handles resolve `streams` like any capability — it is a
    // platform:project default (StreamsCapability loopback), so a context can
    // shadow it. The chained calls (get("/x").append(e)) ride RPC promise
    // pipelining across whichever boundary the caller came in over.
    const projectId = this.#projectId();
    if (projectId !== null) {
      return this.capability("streams") as ItxStreams;
    }
    // The deployment-wide "global" namespace stays KERNEL: it is gated on
    // the connect-time access set ("all" = the admin API secret / admin
    // cookie), which no cap definition can express — a user's global handle
    // must narrow to a project first, otherwise any logged-in user could
    // read platform-level streams through /api/itx.
    if (this.#runtime.access !== "all") {
      throw new ItxError({
        code: "FORBIDDEN",
        message:
          "Global streams need admin access. Narrow to a project first: itx.projects.get(idOrSlug).",
      });
    }
    return new ItxStreams(
      { access: this.#runtime.access, exports: this.#runtime.exports as never },
      GLOBAL_CONTEXT_ID,
    );
  }

  /**
   * The project's own (cap #0) surface IS the Project Durable Object —
   * adding a method/getter to ProjectDurableObject makes it instantly
   * reachable as itx.project.newMethod() — zero forwarder code, nothing to
   * keep in sync (the owner-chosen whole-surface posture, DECISIONS D17).
   *
   * Wrapped in a path proxy rather than handing out the raw stub: workerd
   * does not pipeline calls through property accesses, so on a raw stub
   * `stub.processor.snapshot()` throws. The proxy accumulates the path and
   * replayPathCall awaits each intermediate segment, so deep traversal works
   * in one expression: `await itx.project.processor.snapshot()`. Reserved/
   * prototype path segments stay gated inside replayPathCall.
   */
  get project(): ProjectStub {
    const stub = this.#projectStub();
    return new PathProxy((call) => {
      // The node's `itx()` core is node-to-node machinery: chain
      // delegation passes a TRUSTED `origin`. Reachable here, it would let
      // any handle holder
      // spoof another context's identity (e.g. read a sibling fork's
      // workspace by faking origin). The proper doors are the root verbs
      // (provideCapability/revokeCapability) and the caps themselves.
      const head = call.path[0] ?? "";
      if (head === "itx" || /^itx[A-Z]/.test(head)) {
        throw new ItxError({
          code: "FORBIDDEN",
          message: `${head} is internal context-node plumbing, not part of the project surface — use itx.provideCapability / itx.<cap> instead.`,
        });
      }
      // Same reasoning for the raw egress doors: now that `fetch` is a
      // shadowable capability, the DO's fetch/egressFetch here would bypass
      // any live shadow — the one egress door for handle holders is
      // itx.fetch (the terminal pipe stays reachable to the DEFAULT cap via
      // direct stubs, never through this proxy).
      if (head === "fetch" || head === "egressFetch") {
        throw new ItxError({
          code: "FORBIDDEN",
          message: `${head} is the raw egress pipe — use itx.fetch, which honors fetch-cap shadowing.`,
        });
      }
      return replayPathCall(stub, call);
    }) as unknown as ProjectStub;
  }

  get projects(): ItxProjects {
    return new ItxProjects(this.#runtime);
  }

  /**
   * Explicit project egress (Law 5) — sugar over the context's `fetch`
   * CAPABILITY (a platform:project default): the default pipe substitutes
   * secrets inside the Project DO — `fetch("https://api.x.com", { headers: {
   * authorization: 'getSecret("X_TOKEN")' } })` never sees the material —
   * and a provided `fetch` shadow (e.g. a live provider) intercepts instead.
   * Isolates the platform loads get this same dispatch as global fetch.
   */
  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;
    return (await this.#itx().invoke({ args: [request], path: ["fetch"] })) as Response;
  }

  async describe() {
    const projectId = this.#projectId();
    return {
      access: this.#runtime.access,
      capabilityPath: this.#runtime.capabilityPath,
      capabilities: projectId === null ? [] : await this.#itx().describe(),
      context: this.#runtime.contextId,
      project: projectId === null ? null : await this.#projectStub().describe(),
    };
  }

  /** Fallthrough target — also reachable explicitly as itx.capability("name"). */
  capability(name: string): unknown {
    return new PathProxy(async ({ path, args }) => {
      return await this.#itx().invoke({ args, path: [name, ...path] });
    });
  }

  /**
   * Extend this context with a child (prototype-chain intuition: children
   * extend parents; resolution climbs upward): same anatomy (capability table,
   * parent chain, journal), cheaper and disposable — an agent session,
   * a REPL scratchpad. Returns a handle, because narrowing is construction
   * (Law 4). Child caps shadow this context's; misses delegate up the chain.
   */
  async extend(opts: { name?: string } = {}): Promise<ItxHandle> {
    const projectId = this.#requireProjectId();
    const address = this.#requireContextAddress();
    // Creation is an event: mint the id, append the birth certificate to the
    // child's journal (identity AND parentage — the child dials chain
    // delegation through the parent address recorded there), catalog the
    // coordinate, return a handle. Nothing touches the new node — it
    // materializes lazily by consuming its journal.
    const created = await extendContext({
      base: isChildContextAddress(address)
        ? journalBaseOf(parseItxDurableObjectName(addressDoName(address)).path)
        : "/",
      db: createD1Client(this.#runtime.env.DB),
      env: this.#runtime.env,
      name: opts.name,
      parent: { address, id: this.#runtime.contextId },
      projectId,
      typeIdPrefix: this.#runtime.config.typeIdPrefix,
    });
    // The child is NARROWER than its parent (Law 4): its access is exactly
    // its owning project, never the parent's wider scope. So a session
    // extended off an admin (access "all") handle still cannot reach sibling
    // projects via itx.projects — same access a reconnect through
    // /api/itx/itx_… would resolve.
    return new ItxHandle({
      ...this.#runtime,
      access: [projectId],
      capabilityPath: undefined,
      contextAddress: created.address,
      contextId: created.contextId,
      projectId,
    });
  }

  /**
   * A handle on the PARENT context — the "call next()" of middleware: a
   * `fetch` shadow delegates to the unshadowed pipe via
   * `itx.super.fetch(request)`. Returned as a path proxy (not a bare
   * promise) so the dotted call pipelines over capnweb in one round trip;
   * `await itx.super` also works and yields the parent handle's surface.
   *
   * An extension's parent comes from its birth certificate; the project
   * context's parent IS the platform context (the chain's code root); the
   * platform context is the end of the line.
   */
  get super(): ItxHandle {
    const parentHandle = async (): Promise<ItxHandle> => {
      const address = this.#runtime.contextAddress;
      if (!address) {
        throw new ItxError({
          code: "BAD_REQUEST",
          message: "The global handle has no parent context.",
        });
      }
      if (isChildContextAddress(address)) {
        // A generic context's parentage is its birth certificate, folded
        // from its journal — ask the node.
        const descriptor = await dialContext(this.#runtime.env, address).descriptor!();
        return new ItxHandle({
          ...this.#runtime,
          capabilityPath: undefined,
          contextAddress: descriptor.parent.address as CapabilityAddress,
          contextId: descriptor.parent.id,
          projectId: descriptor.projectId,
        });
      }
      if (this.#runtime.contextId === PLATFORM_PROJECT_CONTEXT_ID) {
        throw new ItxError({
          code: "BAD_REQUEST",
          message: "The platform context is the chain root — it has no parent.",
        });
      }
      // The project context's parent IS the platform defaults link: a
      // read-only code context, dialed in-process.
      return new ItxHandle({
        ...this.#runtime,
        capabilityPath: undefined,
        contextAddress: PLATFORM_PROJECT_CONTEXT_ADDRESS,
        contextId: PLATFORM_PROJECT_CONTEXT_ID,
      });
    };
    return new PathProxy(async (call: PathCall) => {
      const handle = await parentHandle();
      // Empty path = `await itx.super` pulled the proxy and called it — not
      // meaningful; surface the handle's members via replay instead.
      return await replayPathCall(handle, call);
    }) as unknown as ItxHandle;
  }

  /**
   * "Let me show you something real quick": a signed, expiring URL for one
   * HTTP-exposed cap. Possession grants exactly that cap's fetch surface
   * until expiry — nothing else (spec §8).
   */
  async shareUrl(input: { name: string; path?: string; ttlSeconds?: number }): Promise<string> {
    const secret = this.#runtime.config.adminApiSecret?.exposeSecret();
    if (!secret) throw new Error("Share URLs need an admin API secret configured.");
    const projectId = this.#runtime.projectId;
    if (!projectId) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message: "Share URLs are project-scoped; narrow to a project first.",
      });
    }

    const ingress = new URL(await this.#projectStub().ingressUrl());
    const expiresAtMs = Date.now() + (input.ttlSeconds ?? 3600) * 1000;
    const token = await createShareToken({
      capability: input.name,
      expiresAtMs,
      projectId,
      secret,
    });

    const url = new URL(ingress);
    url.hostname = `${input.name}--${ingress.hostname}`;
    url.pathname = input.path ?? "/";
    url.searchParams.set(SHARE_TOKEN_PARAM, token);
    return url.toString();
  }

  // ---- wiring -------------------------------------------------------------

  #projectId(): string | null {
    return this.#runtime.projectId;
  }

  /**
   * The core of the context node this handle points at: the Project DO for
   * project contexts, an ItxDurableObject for extended children — both
   * expose it via itx() (a method, so `node.itx().invoke(...)` pipelines in
   * ONE round trip; workerd does not pipeline calls through property
   * accesses) — or the in-process platform context at the chain root. The
   * runtime carries the ADDRESS; global handles get the narrow-first error.
   */
  #itx(): ItxStub {
    this.#requireProjectId();
    if (this.#runtime.contextId === PLATFORM_PROJECT_CONTEXT_ID) {
      return getPlatformContext({
        exports: this.#runtime.exports,
        projectId: this.#requireProjectId(),
      });
    }
    return dialContext(this.#runtime.env, this.#requireContextAddress()).itx();
  }

  #requireContextAddress(): CapabilityAddress {
    const address = this.#runtime.contextAddress;
    if (!address) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message:
          "This itx handle is on the global context. Narrow to a project first: itx.projects.get(idOrSlug).",
      });
    }
    return address;
  }

  #requireProjectId(): string {
    const projectId = this.#projectId();
    if (projectId === null) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message:
          "This itx handle is on the global context. Narrow to a project first: itx.projects.get(idOrSlug).",
      });
    }
    return projectId;
  }

  #projectStub(): ProjectStub {
    return projectStub(this.#runtime.env, this.#requireProjectId());
  }
}

/**
 * What `provideCapability` returns over the wire: an RpcTarget so `revoke()`
 * crosses capnweb/Workers RPC, with disposal semantics both transports
 * propagate to the target. (ItxFn and Stubify live in types.ts.)
 *
 * `Symbol.dispose` auto-revokes ONLY live provides. The asymmetry is the
 * point: session teardown disposes every stub the session was handed, so a
 * revoking disposer on a DURABLE provide would silently delete the entry the
 * moment the providing connection drops — exactly what durable means it must
 * survive. A live provide dies with the session anyway; eager revocation
 * just removes the offline tombstone.
 */
export class CapabilityProvision extends RpcTarget implements CapabilityProvisionContract {
  readonly #live: boolean;
  readonly #revoke: () => Promise<void>;

  constructor(input: { live: boolean; revoke: () => Promise<void> }) {
    super();
    this.#live = input.live;
    this.#revoke = input.revoke;
  }

  async revoke(): Promise<void> {
    await this.#revoke();
  }

  [Symbol.dispose](): void {
    if (this.#live) void this.#revoke().catch(() => {});
  }
}

/**
 * Normalize a live capability before it crosses to the context node. Bare
 * functions auto-wrap with asPathCallable semantics — an empty remainder
 * calls the function, a deeper remainder errors:
 *
 * - A LOCAL function (prototype Function/AsyncFunction.prototype — never
 *   true of an RPC stub) wraps directly.
 * - A capnweb stub of a REMOTE function is indistinguishable from an object
 *   stub by type (every capnweb stub is a callable proxy), so it is probed:
 *   `await stub.call` is a pure property pull (no user code runs) that
 *   resolves `undefined` only when the remote target is a bare function —
 *   a call-implementing provider yields its method. Probe failures fall
 *   back to the historical call-convention dispatch.
 */
async function resolveLiveCapability(capability: CapabilityTarget): Promise<CapabilityTarget> {
  if (isCapabilityAddress(capability)) return capability;
  if (isLocalBareFunction(capability)) {
    return new BareFunctionCapability(capability) as unknown as CapabilityTarget;
  }
  if (typeof capability === "function" && (capability as object) instanceof RpcStub) {
    const callMember = await Promise.resolve(
      (capability as unknown as { call: unknown }).call,
    ).then(
      (value) => value,
      () => "unprobeable" as const,
    );
    if (callMember === undefined) {
      return new BareFunctionCapability(
        capability as unknown as (...args: never[]) => unknown,
      ) as unknown as CapabilityTarget;
    }
    (callMember as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
  }
  return capability;
}

/**
 * The wrap for a bare-function capability: speaks the one calling convention
 * (`call({ path, args })`) by invoking the function for an empty remainder
 * and refusing anything deeper. Extends RpcTarget so it crosses the
 * worker → context-node hop as a stub while the function (local or a capnweb
 * stub of the provider's process) stays callable right here.
 */
class BareFunctionCapability extends RpcTarget {
  readonly #fn: (...args: never[]) => unknown;

  constructor(fn: (...args: never[]) => unknown) {
    super();
    // Retain a dup when the function is itself a session stub: RPC disposes
    // argument stubs when the provide call returns.
    const dup = (fn as { dup?: () => (...args: never[]) => unknown }).dup;
    this.#fn = typeof dup === "function" ? dup.call(fn) : fn;
  }

  call(input: PathCall): unknown {
    if (input.path.length > 0) {
      throw new Error(
        `This capability is a bare function — it has no member "${input.path.join(".")}"; call it directly.`,
      );
    }
    return this.#fn(...(input.args as never[]));
  }

  onRpcBroken(callback: (error: unknown) => void): void {
    (this.#fn as { onRpcBroken?: (callback: (error: unknown) => void) => void }).onRpcBroken?.(
      callback,
    );
  }

  [Symbol.dispose](): void {
    (this.#fn as Partial<Disposable>)[Symbol.dispose]?.();
  }
}

/** The DO name inside a child-context address (its journal coordinate). */
function addressDoName(address: CapabilityAddress): string {
  if (address.type !== "rpc" || address.worker.type !== "durable-object") {
    throw new Error("Expected a durable-object context address.");
  }
  return address.worker.name;
}

type ProjectStub = DurableObjectStub<ProjectDurableObject>;

function projectStub(env: Env, projectId: string): ProjectStub {
  return env.PROJECT.getByName(getProjectDurableObjectName(projectId)) as unknown as ProjectStub;
}

// ---- projects -------------------------------------------------------------

/**
 * Narrowing lives here, and ONLY here (Law 4): get() checks the simplified
 * access model ("all" | named projects) and returns a NEW project-scoped Itx
 * handle. itx.projects.get("x").streams and a directly connected project
 * handle are the same thing — there is no separate "project object".
 */
export class ItxProjects extends RpcTarget {
  constructor(private readonly runtime: ItxRuntime) {
    super();
  }

  async get(projectIdOrSlug: string): Promise<ItxHandle> {
    const row = await this.requireProjectRow(projectIdOrSlug);
    return new ItxHandle({
      ...this.runtime,
      contextAddress: projectContextAddress(row.id),
      contextId: row.id,
      projectId: row.id,
    });
  }

  async list(input: { limit?: number; offset?: number } = {}) {
    const db = this.db();
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;

    if (this.runtime.access === "all") {
      const [totalRow, rows] = await Promise.all([
        countAllProjects(db),
        listAllProjects(db, { limit, offset }),
      ]);
      return { projects: rows.map(toProjectSummary), total: totalRow?.total ?? 0 };
    }

    const rows = await Promise.all(
      this.runtime.access.slice(offset, offset + limit).map(async (id) => {
        return await getProjectById(db, { id });
      }),
    );
    return {
      projects: rows.filter((row) => row != null).map(toProjectSummary),
      total: this.runtime.access.length,
    };
  }

  /**
   * Admin-only for now: org-membership project creation stays in oRPC until
   * that flow moves over (DECISIONS.md D7).
   */
  async create(input: { id?: string; slug: string }) {
    this.requireAllAccess("create projects");
    const db = this.db();
    // Auth is the canonical minter of the one prj_ id space — even this
    // admin-only operator/recovery path (no owning auth org) round-trips
    // through it. A supplied id must already be a project id (legacy
    // "proj_" still accepted), never a slug.
    if (input.id !== undefined && !isProjectId(input.id)) {
      throw new ItxError({
        code: "BAD_REQUEST",
        details: { id: input.id },
        message: "Project ID must start with prj_ (or legacy proj_).",
      });
    }
    const id =
      input.id ??
      (
        await createAuthWorkerServiceClient({
          config: this.runtime.config,
        }).internal.project.mintProjectId()
      ).id;

    const existingById = await getProjectById(db, { id });
    if (existingById) {
      if (existingById.slug !== input.slug) {
        throw new ItxError({
          code: "CONFLICT",
          details: { existingSlug: existingById.slug, id },
          message: `Project ${id} already exists with slug ${existingById.slug}.`,
        });
      }
      return toProjectSummary(existingById);
    }
    if (await getProjectBySlug(db, { slug: input.slug })) {
      throw new ItxError({
        code: "CONFLICT",
        details: { slug: input.slug },
        message: `A project with slug ${input.slug} already exists.`,
      });
    }

    await insertProject(db, { id, slug: input.slug });
    try {
      await projectStub(this.runtime.env, id).createProject({ projectId: id, slug: input.slug });
    } catch (error) {
      await deleteProject(db, { id }).catch((cleanupError) => {
        console.error(
          `[itx] failed to clean up project ${id} after bootstrap failure`,
          cleanupError,
        );
      });
      throw error;
    }
    const row = await getProjectById(db, { id });
    return toProjectSummary(row ?? { id, slug: input.slug });
  }

  async remove(input: { id: string }) {
    this.requireAllAccess("remove projects");
    await deleteProject(this.db(), { id: input.id });
    return { deleted: true, id: input.id, ok: true as const };
  }

  private async requireProjectRow(projectIdOrSlug: string) {
    const db = this.db();
    const row = isProjectId(projectIdOrSlug)
      ? await getProjectById(db, { id: projectIdOrSlug })
      : await getProjectBySlug(db, { slug: projectIdOrSlug });
    // Existence masking (errors.ts): missing and forbidden are byte-identical
    // NOT_FOUND errors, so access probing cannot reveal which ids/slugs exist.
    const notFound = () =>
      new ItxError({
        code: "NOT_FOUND",
        details: { projectIdOrSlug },
        message: `Project ${projectIdOrSlug} not found.`,
      });
    if (!row) throw notFound();
    if (this.runtime.access !== "all" && !this.runtime.access.includes(row.id)) {
      throw notFound();
    }
    return row;
  }

  private requireAllAccess(action: string) {
    if (this.runtime.access !== "all") {
      throw new ItxError({
        code: "FORBIDDEN",
        message: `This itx handle may not ${action}; it has access to named projects only.`,
      });
    }
  }

  private db() {
    return createD1Client(this.runtime.env.DB);
  }
}

function toProjectSummary(row: { id: string; slug: string; [key: string]: unknown }) {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: typeof row.custom_hostname === "string" ? row.custom_hostname : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}
