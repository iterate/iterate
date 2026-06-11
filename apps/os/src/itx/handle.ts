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
//     revokeCapability, describe, fork, invoke — plus streams, project,
//     projects, and `fetch`, which is sugar dispatching through the
//     registry's `fetch` capability (a shadowable platform default)
//   - a fallthrough Proxy: any unknown name becomes a PathProxy whose
//     terminal call dispatches to the context node's registry. itx.slack
//     works because someone provided "slack", not because anything here
//     knows about Slack.

import { RpcTarget } from "cloudflare:workers";
import { typeid } from "@iterate-com/shared/typeid";
import { createD1Client } from "sqlfu";
import { PathProxyRpcTarget, replayPathCall } from "./path-proxy.ts";
import { ItxError } from "./errors.ts";
import { ItxStreams } from "./caps/streams.ts";
import {
  GLOBAL_CONTEXT_ID,
  RESERVED_CAPABILITY_NAMES,
  type CapabilityMeta,
  type ProjectAccess,
  type SerializableCapabilityTarget,
} from "./protocol.ts";
import { contextAddressOf, dialContext } from "./addresses.ts";
import type { ContextDO } from "./context-do.ts";
import { createShareToken, SHARE_TOKEN_PARAM } from "./http.ts";
import type { LiveCapabilityTarget } from "./registry.ts";
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
  /** Attribution: which capability's isolate holds this handle, if any. */
  capability?: string;
  config: AppConfig;
  /** "global", a project id, or a ctx_… child context id. */
  contextId: string;
  /** The owning project; null only on global handles. For project contexts
   * this equals contextId; for child contexts the restorer resolved it from
   * the ContextDO's descriptor. */
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

export class Itx extends RpcTarget {
  readonly #runtime: ItxRuntime;

  constructor(runtime: ItxRuntime) {
    super();
    this.#runtime = runtime;
    // Unknown names fall through to the context's capability registry. The
    // Proxy wraps the RpcTarget instance (workerd supports this since
    // workerd#3184); real members always win, and registration-time name
    // validation (protocol.ts) guarantees caps cannot shadow them.
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
   * Provide a capability on this handle's context — THE verb: the target
   * kind carries everything else (durable or live). A live stub is
   * session-bound (dies with your connection), an rpc/url target is durable.
   * The entry lives at a PATH: `name` is the 1-segment sugar, `path` shadows
   * one subtree of an inherited cap (longest-prefix dispatch) — exactly one
   * of the two.
   */
  async provideCapability(input: {
    name?: string;
    path?: string[];
    /** The capability's target (types.ts): serializable rpc/url data, or
     * anything live — a stub implementing call({ path, args }) itself, or a
     * plain object/function wrapped client-side with asPathCallable. */
    target: SerializableCapabilityTarget | LiveCapabilityTarget;
    /** TypeScript declarations for the cap's surface — the machine-facing
     * counterpart of meta.instructions; lifted by describe(). */
    types?: string;
    meta?: CapabilityMeta;
  }) {
    return await this.#registryStub().itxProvideCapability(input);
  }

  /** Remove an entry (exact path match, never prefix; defaults can only be shadowed). */
  async revokeCapability(input: { name?: string; path?: string[] }) {
    return await this.#registryStub().itxRevokeCapability(input);
  }

  /**
   * The explicit dispatch form of the fallthrough: one registry dispatch with
   * the full call path. `itx.invoke({ path: ["slack", "chat", "postMessage"],
   * args: [msg] })` ≡ `itx.slack.chat.postMessage(msg)`.
   */
  async invoke(input: { path: string[]; args: unknown[] }): Promise<unknown> {
    return await this.#registryStub().itxInvoke({ args: input.args, path: input.path });
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
    return new PathProxyRpcTarget((call) => {
      // The itx* verbs (itxInvoke, itxProvideCapability, itxProjectWorkerCall, …) are
      // node-to-node plumbing: chain delegation passes a TRUSTED `origin`
      // and the forwarder passes registry-merged props. Reachable here,
      // they would let any handle holder spoof another context's identity
      // (e.g. read a sibling fork's workspace by faking origin). The proper
      // doors are the root verbs (provideCapability/revokeCapability) and the
      // caps themselves.
      const head = call.path[0] ?? "";
      if (/^itx[A-Z]/.test(head)) {
        throw new ItxError({
          code: "FORBIDDEN",
          message: `${head} is internal registry plumbing, not part of the project surface — use itx.provideCapability / itx.<cap> instead.`,
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
    return (await this.#registryStub().itxInvoke({
      args: [request],
      path: ["fetch"],
    })) as Response;
  }

  async describe() {
    const projectId = this.#projectId();
    return {
      access: this.#runtime.access,
      capability: this.#runtime.capability,
      caps: projectId === null ? [] : await this.#registryStub().itxDescribe(),
      context: this.#runtime.contextId,
      project: projectId === null ? null : await this.#projectStub().describe(),
    };
  }

  /** Fallthrough target — also reachable explicitly as itx.capability("name"). */
  capability(name: string): unknown {
    const registry = this.#registryStub();
    return new PathProxyRpcTarget(async ({ path, args }) => {
      return await registry.itxInvoke({ args, path: [name, ...path] });
    });
  }

  /**
   * Create a child context under this one: same anatomy (registry, parent
   * chain, audit stream), cheaper and disposable — an agent session, a REPL
   * scratchpad. Returns a handle, because narrowing is construction (Law 4).
   * Child caps shadow this context's; misses delegate up the chain.
   */
  async fork(opts: { name?: string } = {}): Promise<Itx> {
    const projectId = this.#requireProjectId();
    const childId = typeid({
      env: { TYPEID_PREFIX: this.#runtime.config.typeIdPrefix },
      prefix: "ctx",
    });
    await contextStub(this.#runtime.env, childId).initialize({
      id: childId,
      name: opts.name,
      // Identity AND address: the child audits/scopes by the parent's id and
      // dials chain delegation through the parent's address.
      parent: {
        id: this.#runtime.contextId,
        address: contextAddressOf(this.#runtime.contextId),
      },
      projectId,
    });
    // The child is NARROWER than its parent (Law 4): its access is exactly
    // its owning project, never the parent's wider scope. So a session forked
    // off an admin (access "all") handle still cannot reach sibling projects
    // via itx.projects — same access a reconnect through /api/itx/ctx_… would
    // resolve. (Matches the cursor/bugbot finding on fork scope.)
    return new Itx({
      ...this.#runtime,
      access: [projectId],
      capability: undefined,
      contextId: childId,
      projectId,
    });
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
   * The context node that owns this handle's registry: the Project DO for
   * project contexts, a ContextDO for children. Both speak the same itx*
   * registry surface; a child node delegates misses up the chain itself.
   * The id→address mapping (addresses.ts) picks the node — no prefix
   * sniffing here; global handles get the narrow-first error.
   */
  #registryStub(): RegistryStub {
    this.#requireProjectId();
    return dialContext(
      this.#runtime.env,
      contextAddressOf(this.#runtime.contextId),
    ) as unknown as RegistryStub;
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

/** Itx scripts are plain functions of the handle: `async (itx) => …`.
 * Parameterization is the caller's concern — bake values into the source
 * (the /api/itx/run endpoint does this for its `vars` API). */
export type ItxFn<R = unknown> = (itx: Itx) => Promise<R> | R;

/**
 * Map an SDK's type surface onto its itx stub: every function becomes async,
 * everything else recurses. Cap lookups are untyped at runtime (the Proxy
 * fallthrough), so callers cast: `itx.capability("slack") as
 * Stubify<import("@slack/web-api").WebClient>` gives the real SDK types while
 * the runtime stays a ten-line path-call forwarder.
 */
export type Stubify<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object
    ? { [K in keyof T]: Stubify<T[K]> }
    : never;

type ProjectStub = DurableObjectStub<ProjectDurableObject>;
type ContextStub = DurableObjectStub<ContextDO>;

/** The registry verbs every context node (project or child) exposes. */
type RegistryStub = Pick<
  ProjectStub,
  "itxDescribe" | "itxInvoke" | "itxProvideCapability" | "itxRevokeCapability"
>;

function projectStub(env: Env, projectId: string): ProjectStub {
  return env.PROJECT.getByName(getProjectDurableObjectName(projectId)) as unknown as ProjectStub;
}

function contextStub(env: Env, contextId: string): ContextStub {
  return env.ITX_CONTEXT.getByName(contextId) as unknown as ContextStub;
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

  async get(projectIdOrSlug: string): Promise<Itx> {
    const row = await this.requireProjectRow(projectIdOrSlug);
    return new Itx({ ...this.runtime, contextId: row.id, projectId: row.id });
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
