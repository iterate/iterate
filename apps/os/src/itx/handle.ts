// The itx handle: the ONE thing user code ever touches, identical in the
// browser, Node, the REPL, the iterate-config worker, itx scripts, and caps
// themselves (spec §5).
//
// A handle is a cheap, ephemeral VIEW over a durable context node. Authority
// is "which context this handle points at" (Law 3) — by construction there
// is nothing here to check: a project handle was either minted by
// connect-time auth, by a global handle narrowing through projects.get()
// (which IS the access check), or by the platform wiring a cap's isolate.
//
// Anatomy:
//   - typed built-ins (the trust kernel): caps, streams, repos, workspace,
//     worker, project, projects, fetch, describe — plus the typed project
//     facades (facades.ts): agents, integrations, mcp, secrets
//   - a fallthrough Proxy: any unknown name becomes a PathProxy whose
//     terminal call dispatches to the context node's registry. itx.slack
//     works because someone provided "slack", not because anything here
//     knows about Slack.

import { RpcTarget } from "cloudflare:workers";
import { typeid } from "@iterate-com/shared/typeid";
import type {
  StreamCursor,
  Event as StreamEvent,
  StreamState,
} from "@iterate-com/shared/streams/types";
import { createD1Client } from "sqlfu";
import { StreamNamespace } from "@iterate-com/shared/streams/types";
import { PathProxyRpcTarget } from "./path-proxy.ts";
import { ItxError } from "./errors.ts";
import {
  GLOBAL_CONTEXT_ID,
  isChildContextId,
  RESERVED_CAP_NAMES,
  type CapInvoke,
  type CapMeta,
  type ProjectAccess,
  type SerializableCapTarget,
} from "./protocol.ts";
import type { ContextDO } from "./context-do.ts";
import { createShareToken, SHARE_TOKEN_PARAM } from "./http.ts";
import type { LiveCapTarget } from "./registry.ts";
import { ItxAgents, ItxIntegrations, ItxMcp, ItxSecrets, rethrowAsItxError } from "./facades.ts";
import type { AppConfig } from "~/config.ts";
import { adminPrincipal, getUserPrincipal, type Principal } from "~/auth/principal.ts";
import {
  countAllProjects,
  deleteProject,
  getProjectById,
  getProjectBySlug,
  listAllProjects,
} from "~/db/queries/.generated/index.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import { isProjectId } from "~/domains/projects/project-id.ts";
import { ProjectsCapability } from "~/domains/projects/project-directory.ts";
import { getStreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
import { getReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";

/**
 * Everything a handle needs, resolved once by the restorer
 * (entrypoint.ts/fetch.ts) from `{ context, access }` props. Live values
 * only — this never serializes (Law 2: the serializable form is ItxProps).
 */
export type ItxRuntime = {
  access: ProjectAccess;
  /** Attribution: which capability's isolate holds this handle, if any. */
  cap?: string;
  config: AppConfig;
  /** "global", a project id, or a ctx_… child context id. */
  contextId: string;
  /** The owning project; null only on global handles. For project contexts
   * this equals contextId; for child contexts the restorer resolved it from
   * the ContextDO's descriptor. */
  projectId: string | null;
  /** The connect-time principal, threaded by the auth boundary (fetch.ts) and
   * absent on platform-wired handles (cap isolates — props are serializable,
   * principals are not). Its org claims authorize projects.create; its userId
   * attributes OAuth flows. Authority stays `access` — this is identity. */
  principal?: Principal;
  env: Env;
  /** The parent worker's loopback exports (ctx.exports). */
  exports: Record<string, (options: { props: Record<string, unknown> }) => unknown>;
};

/**
 * Project contexts share one workspace ("itx"); child contexts each get
 * their own, derived from the context id — an agent session's repo clones
 * and files are isolated per context.
 */
function itxWorkspaceId(contextId: string): string {
  return isChildContextId(contextId) ? `itx:${contextId}` : "itx";
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
          return typeof value === "function" ? value.bind(target) : value;
        }
        if (RESERVED_CAP_NAMES.has(prop)) return undefined;
        return target.cap(prop);
      },
    });
  }

  // ---- the trust kernel ---------------------------------------------------

  get caps(): ItxCaps {
    return new ItxCaps(this.#registryStub(), this.#runtime, () => this.#projectStub());
  }

  get streams(): ItxStreams {
    // Project handles read/write their project's namespace. A GLOBAL handle
    // gets the deployment-wide "global" namespace instead — but only with
    // access "all" (the admin API secret / admin cookie); a user's global
    // handle must narrow to a project first, otherwise any logged-in user
    // could read platform-level streams through /api/itx.
    const projectId = this.#projectId();
    if (projectId !== null) {
      return new ItxStreams(this.#runtime, projectId);
    }
    if (this.#runtime.access !== "all") {
      throw new ItxError({
        code: "FORBIDDEN",
        message:
          "Global streams need admin access. Narrow to a project first: itx.projects.get(idOrSlug).",
      });
    }
    return new ItxStreams(this.#runtime, GLOBAL_CONTEXT_ID);
  }

  get repos() {
    // The repos domain entrypoint is already a clean project-scoped
    // capability; hand it out directly rather than wrapping it.
    return getReposCapability({
      exports: this.#runtime.exports as unknown as Parameters<
        typeof getReposCapability
      >[0]["exports"],
      props: { projectId: this.#requireProjectId() },
    });
  }

  get workspace() {
    // Like itx.repos: the workspace domain entrypoint already exposes the
    // exact surface we want (readFile/writeFile and the flat
    // gitClone/gitAdd/gitCommit/gitPush/gitStatus methods), so hand it out
    // directly rather than re-wrapping it. workspaceId is fixed to "itx" —
    // one workspace per project context.
    const factory = this.#runtime.exports.WorkspaceCapability;
    if (typeof factory !== "function") {
      throw new Error("WorkspaceCapability export is not available.");
    }
    return factory({
      props: {
        projectId: this.#requireProjectId(),
        workspaceId: itxWorkspaceId(this.#runtime.contextId),
      },
    });
  }

  /**
   * The project's iterate-config worker. The dynamic worker entrypoint itself
   * can never cross an RPC boundary (workerd forbids transferring loader
   * entrypoints), so the path is replayed against it INSIDE the Project DO —
   * every public method/getter is proxied automatically, at any depth:
   * itx.worker.someTool(args), itx.worker.group.tool(args). `fetch` is the
   * one special case (the project's ingress fetch).
   */
  get worker(): unknown {
    const project = this.#projectStub();
    return new PathProxyRpcTarget(async ({ path, args }) => {
      if (path.length === 1 && path[0] === "fetch") {
        return await project.fetch(args[0] as Request);
      }
      return await project.callConfigWorkerFunction({ args, path });
    });
  }

  /**
   * The project's own (cap #0) surface IS the Project Durable Object stub.
   * Workers RPC proxies every public method/getter automatically, so adding a
   * method to ProjectDurableObject makes it instantly callable as
   * itx.project.newMethod() — zero forwarder code, nothing to keep in sync.
   *
   * This is a deliberate, owner-chosen posture (reverses the round-1 facade,
   * DECISIONS D17): the access model is project-level — if your handle is on
   * this project's context at all, you get its whole surface. The dangerous
   * direction (a hand-built `path` into reserved/prototype names via
   * itxInvoke) is still gated server-side in replayPathCall.
   */
  get project(): ProjectStub {
    return this.#projectStub();
  }

  get projects(): ItxProjects {
    return new ItxProjects(this.#runtime);
  }

  // Typed project facades (facades.ts): wiring, not logic — each method is one
  // delegation to the domain function the oRPC router calls.

  get agents(): ItxAgents {
    return new ItxAgents(this.#requireProjectId());
  }

  get integrations(): ItxIntegrations {
    return new ItxIntegrations(this.#runtime, this.#requireProjectId());
  }

  get mcp(): ItxMcp {
    return new ItxMcp(this.#requireProjectId());
  }

  get secrets(): ItxSecrets {
    return new ItxSecrets(this.#runtime, this.#requireProjectId());
  }

  /**
   * Explicit project egress (Law 5). Secrets are substituted inside the
   * Project DO's egress hop — `fetch("https://api.x.com", { headers: {
   * authorization: 'getSecret("X_TOKEN")' } })` never sees the material.
   * Isolates the platform loads get this same pipe bound as global fetch.
   */
  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;
    return await this.#projectStub().egressFetch(request);
  }

  async describe() {
    const projectId = this.#projectId();
    return {
      access: this.#runtime.access,
      cap: this.#runtime.cap,
      caps: projectId === null ? [] : await this.#registryStub().itxDescribe(),
      context: this.#runtime.contextId,
      project: projectId === null ? null : await this.#projectStub().describe(),
    };
  }

  /** Fallthrough target — also reachable explicitly as itx.cap("name"). */
  cap(name: string): unknown {
    const registry = this.#registryStub();
    return new PathProxyRpcTarget(async ({ path, args }) => {
      return await registry.itxInvoke({ args, name, path });
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
      parent: this.#runtime.contextId,
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
      cap: undefined,
      contextId: childId,
      projectId,
    });
  }

  // ---- wiring -------------------------------------------------------------

  #projectId(): string | null {
    return this.#runtime.projectId;
  }

  /**
   * The context node that owns this handle's registry: the Project DO for
   * project contexts, a ContextDO for children. Both speak the same itx*
   * registry surface; a child node delegates misses up the chain itself.
   */
  #registryStub(): RegistryStub {
    if (isChildContextId(this.#runtime.contextId)) {
      return contextStub(this.#runtime.env, this.#runtime.contextId);
    }
    return this.#projectStub();
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
 * fallthrough), so callers cast: `itx.cap("slack") as
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
  "itxDefine" | "itxDescribe" | "itxInvoke" | "itxProvide" | "itxRevoke"
>;

function projectStub(env: Env, projectId: string): ProjectStub {
  return env.PROJECT.getByName(getProjectDurableObjectName(projectId)) as unknown as ProjectStub;
}

function contextStub(env: Env, contextId: string): ContextStub {
  return env.ITX_CONTEXT.getByName(contextId) as unknown as ContextStub;
}

// ---- caps -----------------------------------------------------------------

/**
 * Registry verbs. provide = live (session-bound, dies with your connection);
 * define = durable (source stored, loaded on demand). Promotion from a REPL
 * is `define` with the source you just wrote — durable means the code moved
 * server-side, which is physics, not API design.
 */
export class ItxCaps extends RpcTarget {
  constructor(
    private readonly registry: RegistryStub,
    private readonly runtime: ItxRuntime,
    private readonly project: () => ProjectStub,
  ) {
    super();
  }

  async provide(input: {
    name: string;
    target: LiveCapTarget;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }) {
    return await this.registry.itxProvide(input);
  }

  async define(input: {
    name: string;
    /** The capability's target (types.ts). Serializable kinds only — for a
     * live stub use provide(). */
    target: SerializableCapTarget;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }) {
    return await this.registry.itxDefine(input);
  }

  async revoke(input: { name: string }) {
    return await this.registry.itxRevoke(input);
  }

  async describe() {
    return await this.registry.itxDescribe();
  }

  /**
   * "Let me show you something real quick": a signed, expiring URL for one
   * HTTP-exposed cap. Possession grants exactly that cap's fetch surface
   * until expiry — nothing else (spec §8).
   */
  async shareUrl(input: { name: string; path?: string; ttlSeconds?: number }): Promise<string> {
    const secret = this.runtime.config.adminApiSecret?.exposeSecret();
    if (!secret) throw new Error("Share URLs need an admin API secret configured.");
    const projectId = this.runtime.projectId;
    if (!projectId) {
      throw new ItxError({
        code: "BAD_REQUEST",
        message: "Share URLs are project-scoped; narrow to a project first.",
      });
    }

    const ingress = new URL(await this.project().ingressUrl());
    const expiresAtMs = Date.now() + (input.ttlSeconds ?? 3600) * 1000;
    const token = await createShareToken({ cap: input.name, expiresAtMs, projectId, secret });

    const url = new URL(ingress);
    url.hostname = `${input.name}--${ingress.hostname}`;
    url.pathname = input.path ?? "/";
    url.searchParams.set(SHARE_TOKEN_PARAM, token);
    return url.toString();
  }
}

// ---- streams --------------------------------------------------------------

type StreamsClient = ReturnType<typeof getStreamsCapability>;

/**
 * Project-scoped streams. Thin: every method resolves the streams domain
 * entrypoint with this project's id in props and forwards. The append
 * policies are decided here (collection-level appends may target any path in
 * the project; a single stream handle is pinned to its path).
 */
export class ItxStreams extends RpcTarget {
  constructor(
    private readonly runtime: ItxRuntime,
    private readonly projectId: string,
  ) {
    super();
  }

  /**
   * Relative or absolute (itx-next.md §3). `"/path"` resolves in this
   * handle's namespace; `"ns:/path"` and `{ namespace, path }` are absolute
   * refs. Sugar rule: absolute forms construct the narrowed collection and
   * call through — ONE code path, so the access check never forks.
   */
  get(ref: string | { namespace?: string; path: string }): ItxStream {
    const { namespace, path } = parseStreamRef(ref);
    if (namespace === undefined || namespace === this.projectId) {
      return new ItxStream(this.runtime, this.projectId, path);
    }
    return this.namespace(namespace).get(path);
  }

  namespace(namespace: string): ItxStreams {
    const parsed = StreamNamespace.parse(namespace);
    // Resolution checks access (§3 rule 2): refs are pure names, restoring
    // them is the capability. Masked as NOT_FOUND like projects.get — a
    // caller can never probe which namespaces exist. A project handle
    // cannot fully-qualify its way out of its access set.
    if (this.runtime.access !== "all" && !this.runtime.access.includes(parsed)) {
      throw new ItxError({
        code: "NOT_FOUND",
        message: `No stream namespace ${JSON.stringify(parsed)} for this handle.`,
      });
    }
    return new ItxStreams(this.runtime, parsed);
  }

  async create(input: { streamPath: string }) {
    return await this.client().create(input);
  }

  private client(): StreamsClient {
    return getStreamsCapability({
      exports: this.runtime.exports as unknown as Parameters<
        typeof getStreamsCapability
      >[0]["exports"],
      props: { appendPolicy: { mode: "any" }, projectId: this.projectId },
    });
  }
}

/**
 * The two absolute StreamRef spellings, plus the relative one:
 * `"/path"` (relative), `"ns:/path"` (absolute string), and
 * `{ namespace?, path }` (absolute structured). Refs are unauthenticated
 * names — authority comes from who restores them, never from their content.
 */
function parseStreamRef(ref: string | { namespace?: string; path: string }): {
  namespace?: string;
  path: string;
} {
  if (typeof ref !== "string") {
    return { namespace: ref.namespace, path: ref.path };
  }
  if (ref.startsWith("/")) return { path: ref };
  const colon = ref.indexOf(":");
  if (colon > 0 && ref[colon + 1] === "/") {
    return { namespace: ref.slice(0, colon), path: ref.slice(colon + 1) };
  }
  throw new ItxError({
    code: "BAD_REQUEST",
    message: `Stream ref ${JSON.stringify(ref)} must be "/path", "namespace:/path", or { namespace?, path }.`,
  });
}

export class ItxStream extends RpcTarget {
  constructor(
    private readonly runtime: ItxRuntime,
    private readonly projectId: string,
    private readonly path: string,
  ) {
    super();
  }

  describe() {
    return { namespace: this.projectId, path: this.path };
  }

  async append(event: unknown) {
    return await this.client().append({ event } as never);
  }

  async appendBatch(events: unknown[]) {
    return await this.client().appendBatch({ events } as never);
  }

  async read(input: Record<string, unknown> = {}) {
    return await this.client().read(input as never);
  }

  async getState() {
    return await this.client().getState({} as never);
  }

  async listChildren() {
    return await this.client().listChildren({} as never);
  }

  /**
   * Live tail: catch-up from `afterOffset` ("start" replays everything,
   * "end" is live-only), then every committed batch, pushed to `onEventBatch`
   * until unsubscribed. The callback crosses whatever boundary the caller
   * came in over (capnweb from a browser/Node session, Workers RPC from a cap
   * isolate); the streams capability holds the actual DO subscription, so the
   * same append-policy props gate it. If the callback's far end goes away,
   * the subscription is torn down on the next failed delivery — offline means
   * offline; durability is the stream itself, re-subscribe from the last
   * offset you saw.
   *
   * The ONE reactive primitive: every batch also carries `state` — the same
   * public shape `getState()` returns, as of `streamMaxOffset` — and every
   * subscription gets an immediate first batch (current state plus any
   * replayed events), so a subscriber paints its first render from the
   * subscription alone. `events: false` is state-only mode: batches arrive
   * with `events: []` on every state change, implicitly live-from-now
   * (`afterOffset` is ignored — replay without events is meaningless).
   */
  async subscribe(
    onEventBatch: (batch: {
      events: StreamEvent[];
      state: StreamState;
      streamMaxOffset: number;
    }) => unknown,
    opts: { afterOffset: StreamCursor; events?: boolean },
  ): Promise<ItxStreamSubscription> {
    // Callback retention lives in StreamsCapability.subscribe: RPC layers
    // implicitly dispose stubs received as parameters when the call
    // completes, so the capability dup()s the callback its wrapper outlives
    // — without that, replay (delivered in-call) works but the first LIVE
    // batch hits a disposed stub. Verified both ways by
    // itx-subscribe.e2e.test.ts against a live deployment.
    const handle = await this.client().subscribe(
      { afterOffset: opts.afterOffset, events: opts.events },
      onEventBatch,
    );
    return new ItxStreamSubscription(handle);
  }

  /**
   * Reactive sugar over {@link subscribe}: a state-only subscription that
   * calls `onState` with the stream's public state (the `getState()` shape)
   * once immediately on open — the first render — and again after every
   * append. `stream.onStateChange(setState)` is the whole browser story.
   */
  async onStateChange(onState: (state: StreamState) => unknown): Promise<ItxStreamSubscription> {
    // `onState` is an RPC parameter stub disposed when THIS call returns, but
    // deliveries (including the initial push) arrive later through the local
    // wrapper below. dup() it (no-op for plain functions) and hand the
    // wrapper a Symbol.dispose so the capability's unsubscribe/teardown
    // releases the retained stub with everything else.
    const retained = (onState as { dup?(): typeof onState }).dup?.() ?? onState;
    const forwardState = Object.assign((batch: { state: StreamState }) => retained(batch.state), {
      [Symbol.dispose]: () => (retained as Partial<Disposable>)[Symbol.dispose]?.(),
    });
    return await this.subscribe(forwardState, { afterOffset: "end", events: false });
  }

  private client(): StreamsClient {
    return getStreamsCapability({
      exports: this.runtime.exports as unknown as Parameters<
        typeof getStreamsCapability
      >[0]["exports"],
      props: {
        appendPolicy: { mode: "stream" },
        projectId: this.projectId,
        streamPath: this.path,
      },
    });
  }
}

/** Disposer for ItxStream.subscribe — callable from any execution mode. */
export class ItxStreamSubscription extends RpcTarget {
  constructor(private readonly handle: { unsubscribe(): void }) {
    super();
  }

  unsubscribe() {
    this.handle.unsubscribe();
  }
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
   * The same org-membership flow as the dashboard's oRPC projects.create
   * (project-directory.ts): a user creates through an auth organization they
   * belong to — the auth worker mints the canonical prj_ id — and is FORBIDDEN
   * outside their orgs; an access-"all" handle takes the operator path (OS
   * mints, no owning org). Supersedes D7's admin-only posture (DECISIONS D22).
   */
  async create(input: { id?: string; slug: string; organizationSlug?: string }) {
    // Authority: the connect-time user principal, or the operator path on an
    // access-"all" handle. Anything else (cap isolates, a project-narrowed
    // admin-cookie handle) may not mint projects — narrowing must hold.
    const principal =
      getUserPrincipal(this.runtime.principal) ??
      (this.runtime.access === "all" ? adminPrincipal : null);
    if (!principal) {
      throw new ItxError({
        code: "FORBIDDEN",
        message: "This itx handle may not create projects.",
      });
    }
    return await rethrowAsItxError(() =>
      new ProjectsCapability({
        context: { config: this.runtime.config, db: this.db(), principal },
      }).create(input),
    );
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
