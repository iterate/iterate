/**
 * # itx — the iterate context surface
 *
 * This file is handwritten, import-free, and is the design of record: the
 * implementation in this directory conforms to THIS file, not the other way
 * around. It is also the completion source for the REPL editor and the
 * document you hand an agent ("you have an `itx`; this is what it is").
 * Roadmap: `apps/os/docs/itx-next.md`. History: `DECISIONS.md`.
 *
 * ## The three concepts
 *
 * **A context** is an addressable node that holds named capabilities.
 * Contexts form a prototype chain: capability lookup walks child → parent
 * with shadowing, writes land on the node your handle points at, and
 * `fork()` is `Object.create(parent)`. A context MAY be durable (a project's
 * context lives in its Durable Object; a forked child gets its own node so
 * others can address it later) — but durability is not part of the concept:
 * a context that nothing else needs to re-address can live entirely in a
 * connection, like the global handle does today.
 *
 * **A capability** is a name plus a {@link CapTarget}: either a live stub
 * someone connected and handed us (inbound, lives as long as their
 * connection), or a serializable description of where to find the
 * implementation (outbound — an RPC target in some worker, or a URL across
 * the internet). The serializable kinds are this realm's sturdy refs: pure
 * names that grant nothing by possession and are restored to live objects
 * on demand.
 *
 * **An itx** is a live handle on one context — the only thing user code
 * ever touches, identical in the browser, Node, the REPL, the project
 * worker (the worker built from the project's own repo), itx scripts, and
 * capabilities themselves. Built-in
 * members (`caps`, `streams`, `fetch`, `fork`, …) are the trust kernel;
 * every other property falls through to the context's capability registry.
 * Authority is the handle itself: auth happens once at connect, and which
 * context you hold — plus the principal it was minted for — is the whole
 * permission model. Narrowing is construction: a weaker handle is a new
 * handle on a narrower context, never a flag on a wider one.
 *
 * ## Thirty seconds of itx
 *
 * ```ts
 * // You are handed an `itx` — in the REPL, from connectItx(), or inside
 * // any platform-loaded isolate via `await env.ITERATE.context`.
 *
 * await itx.describe();                    // what am I holding? what can I call?
 *
 * await itx.slack.chat.postMessage({       // call a capability someone defined —
 *   channel: "C123", text: "hi",           // works because "slack" is in the
 * });                                      // registry, not because itx knows Slack
 *
 * await itx.fetch("https://api.stripe.com/v1/charges", {
 *   headers: { authorization: 'Bearer getSecret({ key: "STRIPE_KEY" })' },
 * });                                      // egress: the secret is substituted
 *                                          // server-side; this code never sees it
 *
 * await itx.caps.define({                  // teach this context a new trick:
 *   name: "ai",                            // itx.ai.run(model, input)
 *   target: { type: "rpc", worker: { type: "binding", binding: "AI" } },
 * });
 *
 * const session = await itx.fork({ name: "agent-run-42" });
 * // a cheap, disposable child context: its caps shadow the project's,
 * // misses delegate up the chain. (This is what a "codemode session" is.)
 * ```
 *
 * One honest caveat on typing: there is ONE `Itx` type, but a live handle is
 * bound to something — a project, a child context, or nothing (a global
 * handle). Members that need a project (`repos`, `workspace`, `worker`,
 * `project`, `fetch`) throw on a global handle until you narrow via
 * `itx.projects.get(...)`. The type system does not yet encode that split;
 * `describe()` is the runtime truth. (Splitting `GlobalItx` / `ProjectItx`
 * is an open design question — see itx-next.md.)
 */

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

/**
 * A live handle on a context.
 *
 * Unknown property names fall through to the context's capability registry
 * at runtime: `itx.slack.chat.postMessage(...)` works because someone
 * defined `slack`. Property access accumulates a path locally (zero round
 * trips); the terminal call dispatches once. Type known caps via
 * {@link KnownCaps} merging, or reach anything untyped via `itx.cap(name)`.
 */
export type Itx = ItxBuiltins & KnownCaps;

/**
 * The built-in surface of every handle — the trust kernel. Everything else
 * you see on an `itx` is a capability that fell through to the registry.
 *
 * Child contexts inherit all of this: a forked session's `repos`,
 * `workspace`, and `streams` resolve through its owning project — the child
 * adds a capability registry of its own, not a different kernel.
 */
export interface ItxBuiltins {
  /** Register, revoke, inspect, and share capabilities on this context. */
  readonly caps: ItxCaps;

  /**
   * Event streams. Streams are keyed by `(namespace, path)`; this handle's
   * binding picks the default namespace (the project id on a project
   * handle; `"global"` on a global handle). See {@link StreamRef} for the
   * relative/absolute addressing forms.
   */
  readonly streams: ItxStreams;

  /** Narrow to a project — the access check, returning a NEW handle. There
   * is no separate "project object"; a narrowed itx IS the project. */
  readonly projects: ItxProjects;

  /** The project's git repos. (Direction: becomes a defined capability
   * rather than a hardwired built-in; surface unchanged.) */
  readonly repos: unknown;

  /** The project's workspace: readFile/writeFile and the flat git methods
   * (gitClone/gitAdd/gitCommit/gitPush/gitStatus — nested RpcTargets do not
   * survive RPC boundaries). (Same direction as `repos`.) */
  readonly workspace: unknown;

  /** The project worker. Every public method/getter is reachable at any
   * depth: `itx.worker.someTool(args)`. */
  readonly worker: unknown;

  /** The Project Durable Object stub, whole surface ("cap #0"). If your
   * handle is on this project's context at all, you get all of it. */
  readonly project: unknown;

  /**
   * Explicit project egress. Secret placeholders are substituted inside the
   * project's egress hop — `'Bearer getSecret({ key: "X_TOKEN" })'` in a
   * header never sees the material. Isolates the platform loads get this
   * same pipe bound as their global `fetch`, so inside a capability or itx
   * script, bare `fetch()` and `itx.fetch()` are the same door.
   */
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;

  /**
   * Who/what am I holding? `describe()` always works, on every handle, and
   * endeavors to return every breadcrumb you need to explore from here:
   * the context, the principal, and the merged capability chain — each cap
   * with its provenance and its provider-supplied `instructions`. When in
   * doubt, describe.
   */
  describe(): Promise<ItxDescription>;

  /** Explicit form of the fallthrough: `itx.cap("slack")` ≡ `itx.slack`.
   * Useful when the name is computed or shadowed by a built-in. */
  cap(name: string): unknown;

  /**
   * Create a child context under this one: same anatomy, cheaper,
   * disposable — an agent session, a REPL scratchpad. The child's caps
   * shadow this context's; misses delegate up the chain. The child's
   * authority is exactly its owning project, even if this handle was wider.
   */
  fork(opts?: { name?: string }): Promise<Itx>;
}

/**
 * Declaration-merge point for caps you expect to exist, so they complete
 * and type-check. This is a compile-time convenience that is GLOBAL to the
 * codebase compiling against it — it cannot vary per project or per
 * context, and the runtime neither reads nor enforces it. The runtime truth
 * is always `describe()`.
 *
 * ```ts
 * declare module "~/itx/types.ts" {
 *   interface KnownCaps {
 *     slack: Stubify<import("@slack/web-api").WebClient>;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- empty on purpose: this is the declaration-merge point
export interface KnownCaps {}

/** What `describe()` returns. Aspirational contract: as many breadcrumbs as
 * we can possibly give you — this should always be the best starting point
 * for exploring what exists. */
export type ItxDescription = {
  /** "global", a project id, or a ctx_… child context id. */
  context: ContextRef;
  /** Who this handle was minted for. */
  principal: ItxPrincipal;
  /** Attribution: which capability's isolate holds this handle, if any. */
  cap?: string;
  /** The merged capability chain (own caps first, ancestors' after,
   * shadowed names carry `owner` provenance), including each cap's
   * `instructions`. */
  caps: CapDescription[];
  /** The bound project's own description, if this handle has one. */
  project: unknown | null;
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Registry verbs. All registration is `define`; the target kind carries
 * everything else (direction, durability, statefulness). */
export interface ItxCaps {
  /**
   * Register a capability on this handle's context: a flat-identifier name
   * plus a target. Live targets are session-bound (re-define on reconnect);
   * rpc/url targets are durable. Nested names are not a thing — nesting
   * belongs to the provided object, not the registry.
   *
   * ```ts
   * // From a laptop/sandbox (inbound, lives while connected):
   * await itx.caps.define({
   *   name: "runSwiftOnMyMac",
   *   target: { type: "live", stub: async (src) => runSwift(src) },
   *   meta: { instructions: "Compile-and-run Swift on Jonas's Mac." },
   * });
   *
   * // A raw platform binding (outbound, durable):
   * await itx.caps.define({
   *   name: "ai",
   *   target: { type: "rpc", worker: { type: "binding", binding: "AI" } },
   * });
   *
   * // First-party MCP client, parameterized per server (see CapTarget):
   * await itx.caps.define({
   *   name: "docs",
   *   invoke: "path-call",
   *   target: {
   *     type: "rpc",
   *     worker: { type: "loopback" },
   *     entrypoint: "McpClient",
   *     props: {
   *       serverUrl: "https://docs.example.com/mcp",
   *       headers: { authorization: 'Bearer getSecret({ key: "DOCS_TOKEN" })' },
   *     },
   *   },
   * });
   *
   * // User-space: a class YOU export from your project worker:
   * await itx.caps.define({
   *   name: "petstore",
   *   target: {
   *     type: "rpc",
   *     worker: { type: "project-worker" },
   *     entrypoint: "OpenApiClient",
   *     props: { specUrl: "https://petstore.example.com/openapi.json" },
   *   },
   * });
   * ```
   */
  define(input: {
    name: string;
    target: CapTarget;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }): Promise<{ name: string; ok: true }>;

  /** Legacy alias: `provide({ name, target: stub })` ≡
   * `define({ name, target: { type: "live", stub } })`. */
  provide(input: {
    name: string;
    target: LiveStub;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }): Promise<{ name: string; ok: true }>;

  revoke(input: { name: string }): Promise<{ name: string; ok: true }>;

  /** The merged chain view — same data `itx.describe()` embeds. */
  describe(): Promise<CapDescription[]>;

  /**
   * "Let me show you something real quick": a signed, expiring URL for one
   * HTTP-exposed cap. Possession grants exactly that cap's fetch surface
   * until expiry — the realm's one deliberate bearer-token edge case.
   */
  shareUrl(input: { name: string; path?: string; ttlSeconds?: number }): Promise<string>;
}

/**
 * THE capability target. Three kinds:
 *
 * - `live` — inbound. Something connected to this context and handed us a
 *   stub; the cap exists exactly as long as that connection does. The one
 *   non-serializable kind.
 * - `rpc` — outbound, inside the Workers RPC universe. "There is an RPC
 *   target in some worker; here is how to reach it." The worker may be a
 *   platform binding, the platform worker's own exports, the project
 *   worker, a Durable Object, or a dynamic worker materialized from stored
 *   source — see {@link WorkerRef}.
 * - `url` — outbound, across the internet: a Cap'n Web server somewhere.
 *   The dial is ONE WebSocket session per call, terminating in the
 *   stateless `UrlDial` worker (Law 7; HTTP batch sessions are banned
 *   repo-wide). Headers ride the handshake and pass through egress secret
 *   substitution, so they may carry `getSecret(...)` placeholders.
 *
 * Deliberately NOT here: MCP and OpenAPI. Those are not transports — they
 * are client implementations, i.e. ordinary RPC targets. The platform ships
 * `McpClient` / `OpenApiClient` entrypoints (reach them via
 * `worker: { type: "loopback" }`, parameterized by `props`), and nothing
 * stops you from shipping your own version as an export of your project
 * worker (the `ProjectWorker` loopback forwarder). If a first-party client
 * needs to be special, the design has failed.
 *
 * (Possible later kind, deliberately absent until needed: a re-export of a
 * cap registered on another context.)
 */
export type CapTarget =
  | { type: "live"; stub: LiveStub }
  | {
      type: "rpc";
      worker: WorkerRef;
      /** Named export to use; defaults to the worker's default export (or,
       * for `binding` workers, the binding object itself). */
      entrypoint?: string;
      /** Instantiation props for the entrypoint (the ProjectEgress
       * pattern): serializable parameterization like a server URL or a
       * gateway choice. The registry adds `{ context, cap }` attribution at
       * dial time. */
      props?: Record<string, unknown>;
    }
  | {
      type: "url";
      url: string;
      /** Sent on connect; values pass through project egress secret
       * substitution (`'Bearer getSecret({ key: "X" })'`). */
      headers?: Record<string, string>;
    };

/**
 * Where an `rpc` target's worker lives. One shape for every way code is
 * reachable over Workers RPC — first-party and user-space are deliberately
 * symmetric (same shape, different `type`).
 */
export type WorkerRef =
  /** Anything on the platform worker's `env`: a service binding, env.AI,
   * env.BROWSER, a queue. With no `entrypoint`, the binding object itself
   * is the target (`itx.ai.run(...)` replays straight onto `env.AI`). */
  | { type: "binding"; binding: string }
  /** The platform worker's own exports (ctx.exports) — first-party code:
   * `McpClient`, thin policy wrappers around bindings, and `ProjectWorker`,
   * the forwarder that makes YOUR repo's worker exports dialable (user
   * space: `entrypoint: "ProjectWorker", props: { export: "MyClass" }` —
   * the call replays inside the Project DO because loader entrypoints
   * cannot cross an RPC boundary). */
  | { type: "loopback" }
  /** A Durable Object, addressed by namespace binding + instance name. */
  | { type: "durable-object"; binding: string; name: string }
  /** A dynamic worker materialized on demand from stored source — code that
   * lives in the registry itself rather than in any deployed artifact. */
  | { type: "source"; source: CapSource };

/**
 * Stored source for a `{ type: "source" }` worker. The platform materializes
 * it into an isolate on demand. Inside it: bare `fetch()` IS project egress
 * (secrets substituted server-side, never visible to this code), and
 * `env.ITERATE` is an itx scoped to the cap's home context — a capability
 * can never reach wider than where it is defined.
 */
export type CapSource = {
  /**
   * The loader caches the materialized isolate by this string, so it MUST
   * change whenever `modules` change; a content hash is the ideal value.
   * (Replaces the old `codeId` field — it was never an id, and "id" in this
   * codebase means typeid.)
   */
  cacheKey: string;
  mainModule: string;
  modules: Record<string, string>;
  /** Named export to load; defaults to the default export. */
  entrypoint?: string;
  /**
   * What the entrypoint export IS — this is where statefulness lives:
   *
   * - `"worker-entrypoint"` (default): stateless; a fresh isolate per call.
   * - `"durable-object"`: stateful; a NAMED export extending
   *   `DurableObject`, instantiated as a facet OF the Durable Object
   *   hosting this context (the Project DO, or the child context's DO). It
   *   gets its own private SQLite, physically stored inside that host, and
   *   the database survives code upgrades.
   */
  exportType?: "worker-entrypoint" | "durable-object";
  compatibilityDate?: string;
};

/**
 * How a capability is called once the supervisor holds its target.
 *
 * `"members"` (default) — replay the property path on the target and call
 * the terminal method on its parent, receiver-preserving. Use when the
 * target is a real object whose methods exist:
 *
 * ```ts
 * // target: { todos: { add(item) {…} } }
 * itx.myCap.todos.add({ text: "x" })  // → replays ["todos","add"] on the target
 * ```
 *
 * `"path-call"` — the target implements ONE method, `call({ path, args })`,
 * and owns its own method-tree semantics. Use for SDK-shaped surfaces whose
 * tree you don't predeclare; the public SDK docs become the tool docs:
 *
 * ```ts
 * // provider: class { call({ path, args }) { return slackApi(path.join("."), args[0]); } }
 * itx.slack.chat.postMessage({ … })   // → ONE call: call({ path: ["chat","postMessage"], … })
 * ```
 */
export type CapInvoke = "members" | "path-call";

/** The wire shape of one dynamic-surface invocation. */
export type PathCall = { path: string[]; args: unknown[] };

/** What a `"path-call"` capability provider implements. */
export type PathCallTarget = { call(input: PathCall): unknown };

/**
 * A live provider's stub: a function, an object of functions, or an
 * RpcTarget. Structural and opaque — it may arrive over Cap'n Web (a
 * browser tab, a Node process, an agent's sandbox) or Workers RPC; the
 * registry relies only on protocol-level controls (`dup`, `onRpcBroken`,
 * `Symbol.dispose`) when present.
 */
export type LiveStub = object;

/**
 * Arbitrary metadata on a registration. The registry stores it verbatim and
 * surfaces it in `describe()` — there is no schema. One convention worth
 * following: `instructions`, a human/agent-readable sentence on what the
 * cap does and how to call it, shown by `describe()`.
 */
export type CapMeta = {
  /** Shown in describe(); write it for the agent who finds this cap. */
  instructions?: string;
  [key: string]: unknown;
};

/** A registry entry as reported by `describe()`. Never contains live stubs. */
export type CapDescription = {
  name: string;
  /** The target's kind: "live" | "rpc" | "url". */
  kind: CapTarget["type"];
  invoke: CapInvoke;
  /** Which context owns the entry — provenance for shadowing visibility. */
  owner: string;
  /** Live caps only: is the provider currently connected? */
  connected?: boolean;
  /** Lifted from meta for convenience: the one thing to read first. */
  instructions?: string;
  meta: CapMeta;
  updatedAtMs: number;
};

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * How a stream is addressed. Streams are keyed by `(namespace, path)`; a
 * project's id happens to be usable as a namespace, and `"global"` is the
 * deployment-wide namespace. All of these reach the same stream:
 *
 * ```ts
 * itx.streams.get("proj_123:/chat")                         // absolute, string
 * itx.streams.get({ namespace: "proj_123", path: "/chat" }) // absolute, structured
 * itx.projects.get("proj_123").streams.get("/chat")         // narrow, then relative
 * itx.projects.get("proj_123").streams.get({ path: "/chat" })
 * ```
 *
 * Absolute forms are sugar: they internally construct the narrowed handle
 * and call through — one code path, and resolution is always checked
 * against the handle's authority (a project handle cannot fully-qualify its
 * way out).
 */
export type StreamRef = string | { namespace?: string; path: string };

/** An event as read back from a stream. */
export type StreamEvent = {
  type: string;
  payload?: unknown;
  /** 1-based durable offset — the resume cursor. */
  offset: number;
};

/** An event as appended. */
export type StreamEventInput = {
  type: string;
  payload?: unknown;
  /** Appends with the same key are dropped instead of duplicated. */
  idempotencyKey?: string;
};

/** The public state of one stream — what `getState()` returns and what every
 * subscription batch carries as `state`. */
export type StreamState = {
  namespace: string;
  path: string;
  eventCount: number;
  childPaths: string[];
  metadata: Record<string, unknown>;
};

/** A handle pinned to one stream. */
export interface ItxStream {
  describe(): { namespace: string; path: string };
  append(event: StreamEventInput): Promise<StreamEvent>;
  appendBatch(events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(input?: {
    afterOffset?: number | "start" | "end";
    beforeOffset?: number | "start" | "end";
  }): Promise<StreamEvent[]>;
  getState(): Promise<unknown>;
  listChildren(): Promise<unknown>;
  /**
   * The ONE reactive primitive. Catch-up from `afterOffset`, then every
   * committed batch, pushed until unsubscribed. Every batch carries `state`
   * (the `getState()` shape as of `streamMaxOffset`), and every subscription
   * receives an immediate first batch so the first render needs no separate
   * getState call. `events: false` = state-only: batches with `events: []`
   * on every state change, implicitly live-from-now (`afterOffset` ignored).
   */
  subscribe(
    onEventBatch: (batch: {
      events: StreamEvent[];
      state: StreamState;
      streamMaxOffset: number;
    }) => unknown,
    opts: { afterOffset: number | "start" | "end"; events?: boolean },
  ): Promise<{ unsubscribe(): void }>;
  /** Sugar: subscribe(batch => onState(batch.state), { events: false, afterOffset: "end" }). */
  onStateChange(onState: (state: StreamState) => unknown): Promise<{ unsubscribe(): void }>;
}

/** The streams collection, namespace-bound by the handle. */
export interface ItxStreams {
  /** Resolve a stream ref — relative or absolute, see {@link StreamRef}. */
  get(ref: StreamRef): ItxStream;
  create(input: { streamPath: string }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Narrowing lives here: `get()` checks the principal's grants and returns
 * a NEW project-scoped handle. */
export interface ItxProjects {
  get(projectIdOrSlug: string): Promise<Itx>;
  list(input?: { limit?: number; offset?: number }): Promise<{
    projects: {
      id: string;
      slug: string;
      customHostname: string | null;
      createdAt: string | null;
      updatedAt: string | null;
    }[];
    total: number;
  }>;
  /** Admin principals only. */
  create(input: { id?: string; slug: string }): Promise<{ id: string; slug: string }>;
  /** Admin principals only. */
  remove(input: { id: string }): Promise<{ deleted: boolean; id: string; ok: true }>;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/**
 * An itx script: a plain function of the handle — `async (itx) => …` —
 * runnable identically from every execution mode: the browser REPL, a Node
 * process, `POST /api/itx/run`, the project worker, and capabilities
 * themselves. There is ONE shape; parameterization is the caller's concern
 * (helpers that take a `vars` object bake it into the source before
 * submitting, which is exactly what the /api/itx/run endpoint does).
 */
export type ItxFn<R = unknown> = (itx: Itx) => Promise<R> | R;

/**
 * Map an SDK's type surface onto its itx stub: every function becomes
 * async, everything else recurses. With this, {@link KnownCaps} merging
 * gives `itx.slack` the real @slack/web-api types while the runtime stays a
 * ten-line path-call forwarder.
 */
export type Stubify<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object
    ? { [K in keyof T]: Stubify<T[K]> }
    : never;

// ---------------------------------------------------------------------------
// Wire types: refs, principals, props
// ---------------------------------------------------------------------------

/**
 * A context's sturdy ref: `"global"`, a project id, or a child context id.
 * (Type-safe-ish via prefixes; `proj_` is the legacy project prefix, `prj_`
 * the canonical one minted by the auth worker.)
 */
export type ContextRef = "global" | `prj_${string}` | `proj_${string}` | `ctx_${string}`;

/**
 * Who a handle was minted for — typed out BY HAND from the auth system
 * (`~/auth/principal.ts` + `@iterate-com/shared/auth-claims`), minus the
 * `can()` helper, so that drift becomes a type error at the conformance
 * seam rather than an invented parallel access model. Only fields itx
 * actually uses appear here.
 *
 * - `admin`: the admin API secret, or a user token carrying Better Auth's
 *   admin-plugin role claim. Sees everything.
 * - `user`: organization memberships and project grants exactly as the auth
 *   worker issued them. May do project-scoped things iff the project is in
 *   `projects`. Nothing finer-grained exists (the seam does; the
 *   implementation deliberately does not).
 */
export type ItxPrincipal =
  | { type: "admin" }
  | {
      type: "user";
      userId: string;
      sessionId?: string;
      organizations: {
        id: string;
        slug: string;
        role: "member" | "admin" | "owner";
        name?: string;
      }[];
      projects: { id: string; slug: string; organizationId: string }[];
    };

/**
 * The ONE serializable parameterization in the system — what crosses a
 * boundary when the platform wires a handle into an isolate. Props carry
 * identity, never composition or authority-by-content:
 *
 * - `context`: which context. The restorer turns it into a live handle.
 * - `principal`: honored on global handles only; a project-context handle
 *   is always bound to exactly its own project regardless of what props
 *   claim.
 * - `cap`: pure attribution — which capability's isolate holds this handle.
 *   It grants nothing; it labels egress and audit records.
 */
export type ItxProps = {
  context: ContextRef;
  principal?: ItxPrincipal;
  cap?: string;
};
