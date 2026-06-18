// The itx handle: the ONE thing user code ever touches, identical in the
// browser, Node, the REPL, the project worker, itx scripts, and caps
// themselves (design of record: types.ts).
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
//     core's `fetch` capability (a shadowable default)
//   - a fallthrough Proxy: any unknown name becomes a PathProxy whose
//     terminal call dispatches to the context node's core (node.itx()).
//     itx.slack works because someone provided "slack", not because anything
//     here knows about Slack.

import { RpcTarget } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import { PathProxy } from "./path-proxy.ts";
import { ItxError } from "./errors.ts";
import { ItxStreams } from "./capabilities/streams.ts";
import {
  isCapabilityAddress,
  replayPathCall,
  RESERVED_CAPABILITY_NAMES,
  type CapabilityAddress,
  type CapabilityMeta,
  type CapabilityTarget,
  type ItxStub,
  type PathCall,
} from "./itx.ts";
import { resolveLiveCapability } from "./live-target.ts";
import {
  contextAddress,
  createContext,
  dialContext,
  generatedContextPath,
  isContextNodeAddress,
  projectContextRef,
} from "./coordinates.ts";
import {
  getPlatformContext,
  PLATFORM_PROJECT_CONTEXT_ADDRESS,
  PLATFORM_PROJECT_CONTEXT_ID,
} from "./platform-context.ts";
import type { ProjectAccess } from "./refs.ts";
import type {
  CapabilityProvision as CapabilityProvisionContract,
  KnownCapabilities,
} from "./types.ts";
import type { AppConfig } from "~/config.ts";
import {
  countAllProjects,
  deleteProject,
  getProjectById,
  getProjectBySlug,
  insertProject,
  listAllProjects,
  updateProjectConfig,
} from "~/db/queries/.generated/index.ts";
import type { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object-ref.ts";
import {
  ensureProjectCustomHostname,
  ensureProjectCustomHostnameStatus,
} from "~/domains/projects/cloudflare-custom-hostnames.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
} from "~/lib/project-host-routing.ts";
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
  /** "global", a context ref (`<projectId>:<path>`), or the
   * platform:project chain root. */
  contextRef: string;
  /** How to dial the context node — a projection of the ref for context
   * nodes, the loopback address at the chain root; null only on global
   * handles. */
  contextAddress: CapabilityAddress | null;
  /** The owning project from the ref; null only on global handles. */
  projectId: string | null;
  env: Env;
  /** The parent worker's loopback exports (ctx.exports). */
  exports: Record<string, (options: { props: Record<string, unknown> }) => unknown>;
  /**
   * The connect-time principal — ONLY threaded onto the GLOBAL handle (minted
   * at connect, never restored in an isolate, so this live value never has to
   * serialize). It exists for exactly one job: org-membership project creation
   * (itx.projects.create) for non-admin users, which needs their org claims.
   * Absent everywhere else; the access set is the permission model for all
   * other paths.
   */
  principal?: ItxUserPrincipal | null;
};

/** The slice of the connect-time user principal the global create path needs:
 * the org claims to authorize "create only in an org you're in", and the
 * userId the auth worker mints/adopts as. */
export type ItxUserPrincipal = {
  userId: string;
  organizations: { slug: string }[];
};

/** Whether `prop` resolves through a getter anywhere on the prototype chain. */
function isAccessor(target: object, prop: PropertyKey): boolean {
  for (let node: object | null = target; node; node = Object.getPrototypeOf(node)) {
    const descriptor = Object.getOwnPropertyDescriptor(node, prop);
    if (descriptor) return descriptor.get !== undefined;
  }
  return false;
}

// Declaration-merge the typed cap fallthrough (KnownCapabilities:
// secrets/repos/integrations/agents) onto the runtime class, so a
// RpcStub<ItxHandle> exposes itx.secrets.listSecrets() etc. cast-free. The
// class keeps its own (RpcTarget-extending) projects/streams member types —
// only the fallthrough names are added. The runtime delivers these via the
// constructor's Proxy; this interface is the compile-time mirror.
export interface ItxHandle extends KnownCapabilities {}

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
   * Provide a capability on this handle's context — THE verb for every
   * capability kind, live or durable. Full semantics: Itx.provideCapability
   * (itx.ts); surface docs: types.ts. Returns a {@link CapabilityProvision}
   * (its class doc explains the live-vs-durable dispose asymmetry).
   */
  async provideCapability(input: {
    name?: string;
    path?: string[];
    /** The capability (types.ts): a serializable rpc/url address, or
     * anything live — a plain object of methods (dispatch replays the dotted
     * path onto its members, no wrapper), a bare function (calling the cap
     * calls it), or a target implementing call({ path, args }) itself. */
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
    // The deployment-wide global stream scope stays KERNEL: it is gated on
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
      null,
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
      // spoof another context's identity (e.g. read a sibling extension's
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
    // The explicit egress door — and where any AbortSignal is detached: a
    // signal cannot cross the RPC hop to the context node ("AbortSignal
    // serialization is not enabled"), so the door strips it once for every
    // caller (the MCP SDK attaches one to each request, for example).
    // Per-request aborts don't survive egress; the pipe's bounds do.
    const built = typeof input === "string" ? new Request(input, init) : input;
    const request = new Request(built, { signal: null });
    return (await this.#itx().invoke({ args: [request], path: ["fetch"] })) as Response;
  }

  async describe() {
    const projectId = this.#projectId();
    return {
      access: this.#runtime.access,
      capabilityPath: this.#runtime.capabilityPath,
      capabilities: projectId === null ? [] : await this.#itx().describe(),
      context: this.#runtime.contextRef,
      project: projectId === null ? null : await this.#projectStub().describe(),
    };
  }

  /** Fallthrough target — also reachable explicitly as itx.capability("name").
   * A known cap name (merged into KnownCapabilities) resolves to its typed
   * stub; any other name falls through to `unknown`. */
  capability<K extends keyof KnownCapabilities>(name: K): KnownCapabilities[K];
  capability(name: string): unknown;
  capability(name: string): unknown {
    return new PathProxy(async ({ path, args }) => {
      return await this.#itx().invoke({ args, path: [name, ...path] });
    });
  }

  /**
   * Extend this context with a child (prototype-chain intuition: children
   * extend parents; resolution climbs upward): same anatomy (capability
   * table, parent chain, stream), cheaper and disposable — a session, a
   * REPL scratchpad. Returns a handle, because narrowing is construction
   * (Law 4). Child caps shadow this context's; misses delegate up the chain.
   *
   * The child IS a stream coordinate: pass `path` to put it somewhere
   * meaningful (an agent stream, a run stream), or take the generated
   * `/itx/<id>` catch-all. Extending an existing path is get-or-create —
   * the first creation event wins.
   */
  async extend(opts: { name?: string; path?: string } = {}): Promise<ItxHandle> {
    const projectId = this.#requireProjectId();
    const address = this.#requireContextAddress();
    const created = await createContext({
      env: this.#runtime.env,
      name: opts.name,
      projectId,
      parent: { address, ref: this.#runtime.contextRef },
      path: opts.path ?? generatedContextPath(this.#runtime.config.typeIdPrefix),
    });
    // The child is NARROWER than its parent (Law 4): its access is exactly
    // its owning project, never the parent's wider scope. So a session
    // extended off an admin (access "all") handle still cannot reach sibling
    // projects via itx.projects — same access a reconnect through
    // /api/itx/<ref> would resolve.
    return new ItxHandle({
      ...this.#runtime,
      access: [projectId],
      capabilityPath: undefined,
      contextAddress: created.address,
      contextRef: created.ref,
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
   * context's parent IS the defaults (the chain's code root); the
   * defaults are the end of the line.
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
      if (this.#runtime.contextRef === PLATFORM_PROJECT_CONTEXT_ID) {
        throw new ItxError({
          code: "BAD_REQUEST",
          message: "The defaults are the chain root — they have no parent.",
        });
      }
      // A context's parentage is its creation event, folded from its
      // stream — ask the node. The defaults parent comes back as the
      // loopback address (not a context node), same as the chain dials it.
      const descriptor = await dialContext(this.#runtime.env, address).descriptor();
      const parentAddress = descriptor.parent.address as CapabilityAddress;
      return new ItxHandle({
        ...this.#runtime,
        capabilityPath: undefined,
        contextAddress: isContextNodeAddress(parentAddress)
          ? parentAddress
          : PLATFORM_PROJECT_CONTEXT_ADDRESS,
        contextRef: isContextNodeAddress(parentAddress)
          ? descriptor.parent.ref
          : PLATFORM_PROJECT_CONTEXT_ID,
        projectId: this.#runtime.projectId,
      });
    };
    return new PathProxy(async (call: PathCall) => {
      const handle = await parentHandle();
      // Empty path = `await itx.super` pulled the proxy and called it — not
      // meaningful; surface the handle's members via replay instead.
      return await replayPathCall(handle, call);
    }) as unknown as ItxHandle;
  }

  // ---- wiring -------------------------------------------------------------

  #projectId(): string | null {
    return this.#runtime.projectId;
  }

  /**
   * The core of the context node this handle points at: the
   * ItxDurableObject named with the ref — exposed via itx() (a method, so
   * `node.itx().invoke(...)` pipelines in ONE round trip; workerd does not
   * pipeline calls through property accesses) — or the in-process defaults
   * context at the chain root. The runtime carries the ADDRESS; global
   * handles get the narrow-first error.
   */
  #itx(): ItxStub {
    this.#requireProjectId();
    if (this.#runtime.contextRef === PLATFORM_PROJECT_CONTEXT_ID) {
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
      contextAddress: contextAddress(projectContextRef(row.id)),
      contextRef: projectContextRef(row.id),
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
   * Create a project. Two paths:
   *
   *  - ADMIN handle (access "all"): the operator/recovery path — auth mints a
   *    fresh prj_ id (or an explicit one is adopted), no owning org.
   *  - NON-ADMIN user (org claims threaded onto the GLOBAL handle): the
   *    product path the dashboard uses — create only in an organization the
   *    user belongs to, via the auth worker's createForOrganization (the same
   *    flow the oRPC handler used). Mirrors project-directory.ts.
   *
   * The principal only rides the global handle, so this path needs no project
   * context — it is the one create that runs before any narrowing.
   */
  async create(input: { id?: string; slug: string; organizationSlug?: string }) {
    const db = this.db();

    // Non-admin user with org claims: create in one of their orgs. Auth is the
    // id authority — createForOrganization mints prj_ and we adopt it.
    if (this.runtime.access !== "all") {
      const principal = this.requireUserPrincipalForCreate();
      const organizationSlug = resolveCreateOrganizationSlug(principal, input.organizationSlug);
      const created = await createAuthWorkerServiceClient(
        { config: this.runtime.config },
        { asUserId: principal.userId },
      ).internal.project.createForOrganization({
        name: input.slug,
        organizationSlug,
        slug: input.slug,
      });
      return await this.finishCreate(db, { id: created.id, slug: created.slug });
    }

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
    return await this.finishCreate(db, { id, slug: input.slug });
  }

  /** Shared tail of create: idempotent insert + Project DO bootstrap. */
  private async finishCreate(db: ReturnType<typeof this.db>, input: { id: string; slug: string }) {
    const { id, slug } = input;
    const existingById = await getProjectById(db, { id });
    if (existingById) {
      if (existingById.slug !== slug) {
        throw new ItxError({
          code: "CONFLICT",
          details: { existingSlug: existingById.slug, id },
          message: `Project ${id} already exists with slug ${existingById.slug}.`,
        });
      }
      return toProjectSummary(existingById);
    }
    if (await getProjectBySlug(db, { slug })) {
      throw new ItxError({
        code: "CONFLICT",
        details: { slug },
        message: `A project with slug ${slug} already exists.`,
      });
    }

    await insertProject(db, { id, slug });
    try {
      await projectStub(this.runtime.env, id).createProject({ projectId: id, slug });
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
    return toProjectSummary(row ?? { id, slug });
  }

  private requireUserPrincipalForCreate() {
    const principal = this.runtime.principal;
    if (!principal) {
      // A non-admin handle with no threaded principal cannot create: this is
      // the operator/recovery posture without "all" access, or a narrowed
      // (project) handle that never carries the connect principal.
      throw new ItxError({
        code: "FORBIDDEN",
        message:
          "Creating a project requires either admin access or a connect-time user principal " +
          "with organization membership. Create from the global itx handle while logged in.",
      });
    }
    return principal;
  }

  async remove(input: { id: string }) {
    // Symmetric with create: an admin handle ("all") may delete any project;
    // a non-admin may delete a project its handle holds a claim for. The
    // claim check is requireProjectRow (existence-masked NOT_FOUND otherwise),
    // the same gate every other project-scoped op uses — mirrors the oRPC
    // handler's requireProject. (Bugbot: non-admins must be able to delete
    // the projects they can create.)
    // Non-admins are existence-masked (requireProjectRow throws NOT_FOUND for a
    // project they can't see or that doesn't exist). Admins get an honest
    // idempotent answer: deleting a project that isn't there reports
    // { deleted: false } rather than claiming a phantom delete.
    const row =
      this.runtime.access === "all"
        ? await getProjectById(this.db(), { id: input.id })
        : await this.requireProjectRow(input.id);
    if (!row) {
      return { deleted: false, id: input.id, ok: true as const };
    }
    await deleteProject(this.db(), { id: input.id });
    return { deleted: true, id: input.id, ok: true as const };
  }

  /**
   * Cloudflare custom-hostname status for the project's configured custom
   * hostname. Mirrors the oRPC `projects.customHostnameStatus` handler.
   */
  async customHostnameStatus(input: { id: string }) {
    const row = await this.requireProjectRow(input.id);
    return await ensureProjectCustomHostnameStatus({
      apiToken: this.runtime.config.cloudflare.apiToken?.exposeSecret(),
      customHostname: row.custom_hostname,
      projectHostnameBase: this.runtime.config.projectHostnameBases[0],
    });
  }

  /**
   * Activate a Cloudflare custom hostname (the configured custom hostname or a
   * subdomain of it). Mirrors the oRPC `projects.ensureCustomHostname` handler.
   */
  async ensureCustomHostname(input: { id: string; hostname: string }) {
    const row = await this.requireProjectRow(input.id);
    if (!row.custom_hostname) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message: "Set a custom hostname before activating app hostnames.",
      });
    }

    const hostname = normalizeCustomHostname(input.hostname);
    if (!hostname || !isValidCustomHostname(hostname)) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message: "Hostname must be a valid DNS hostname.",
      });
    }

    return await ensureProjectCustomHostname({
      apiToken: this.runtime.config.cloudflare.apiToken?.exposeSecret(),
      customHostname: row.custom_hostname,
      hostname,
      projectHostnameBase: this.runtime.config.projectHostnameBases[0],
    });
  }

  /**
   * Update the project's config (custom hostname). Mirrors the oRPC
   * `projects.updateConfig` handler; returns the project with its ingress URL.
   */
  async updateConfig(input: { id: string; customHostname?: string | null }) {
    const existing = await this.requireProjectRow(input.id);
    const db = this.db();

    const normalizedCustomHostname = this.normalizeConfigCustomHostname(input.customHostname);
    const nextCustomHostname =
      normalizedCustomHostname === undefined
        ? (existing.custom_hostname ?? null)
        : normalizedCustomHostname;
    try {
      await updateProjectConfig(db, { customHostname: nextCustomHostname }, { id: input.id });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new ItxError({
          code: "CONFLICT",
          message: `Custom hostname ${nextCustomHostname} is already assigned.`,
        });
      }
      throw error;
    }

    const row = await getProjectById(db, { id: input.id });
    if (!row) {
      throw new ItxError({
        code: "INTERNAL",
        message: `Project ${input.id} was not returned after update`,
      });
    }

    if (row.custom_hostname) {
      await ensureProjectCustomHostnameStatus({
        apiToken: this.runtime.config.cloudflare.apiToken?.exposeSecret(),
        customHostname: row.custom_hostname,
        projectHostnameBase: this.runtime.config.projectHostnameBases[0],
      });
    }

    return await this.toProjectWithIngressUrl(row);
  }

  private normalizeConfigCustomHostname(input: string | null | undefined) {
    if (input === undefined) return undefined;

    const customHostname = normalizeCustomHostname(input);
    if (customHostname === null) return null;

    if (!isValidCustomHostname(customHostname)) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message: "Custom hostname must be a valid DNS hostname.",
      });
    }

    if (isReservedProjectHostname(customHostname, this.runtime.config.projectHostnameBases)) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message: "Custom hostname cannot use a reserved OS project hostname.",
      });
    }

    return customHostname;
  }

  private async toProjectWithIngressUrl(row: { id: string; slug: string; [key: string]: unknown }) {
    return {
      ...toProjectSummary(row),
      ingressUrl: await projectStub(this.runtime.env, row.id).ingressUrl(),
    };
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

/** Choose the org to create in: the requested one (must be a member) or, when
 * omitted, the user's single org. Mirrors project-directory.ts'
 * resolveOrganizationSlugForCreate, in ItxError terms. */
function resolveCreateOrganizationSlug(
  principal: ItxUserPrincipal,
  requestedSlug: string | undefined,
): string {
  const organizations = principal.organizations;
  if (requestedSlug) {
    const organization = organizations.find((candidate) => candidate.slug === requestedSlug);
    if (!organization) {
      throw new ItxError({
        code: "FORBIDDEN",
        message: `Organization ${requestedSlug} is not available to this user.`,
      });
    }
    return organization.slug;
  }
  if (organizations.length === 1) return organizations[0]!.slug;
  throw new ItxError({
    code: "BAD_REQUEST",
    message:
      organizations.length === 0
        ? "Project creation requires organization membership."
        : "Pass organizationSlug to choose which organization should own the project.",
  });
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
