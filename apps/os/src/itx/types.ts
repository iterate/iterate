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
 * **A context** is an addressable node that holds named capabilities — and
 * a context IS a stream coordinate: its identity is the ref
 * `<projectId>:<path>` of an ordinary event stream (the project context is
 * the project's root stream; an agent's context is the agent's stream).
 * Contexts form a prototype chain: capability lookup walks child → parent
 * with shadowing, writes land on the node your handle points at, and
 * `extend()` is `Object.create(parent)` — at a path you choose, or a
 * generated `/itx/<id>` catch-all.
 *
 * **A capability** is a name plus a {@link CapabilityTarget}: either a live stub
 * someone connected and handed us (inbound, lives as long as their
 * connection), or a serializable description of where to find the
 * implementation (outbound — an RPC target in some worker). The serializable
 * kind is this realm's sturdy ref: a pure name that grants nothing by
 * possession and is restored to a live object on demand.
 *
 * **An Itx** is the capability CORE a context node embeds — "an Itx holds
 * capabilities; everything else holds a stub of one". It owns the path-keyed
 * entry map, the live-stub table, longest-prefix dispatch, and parent-chain
 * delegation, with exactly four verbs: `provideCapability`,
 * `revokeCapability`, `describe`, `invoke` (see {@link Itx}).
 *
 * **An itx HANDLE** ({@link ItxHandle}) is the live view user code touches —
 * identical in the browser, Node, the REPL, the project worker (the worker
 * built from the project's own repo), itx scripts, and capabilities
 * themselves. A handle is an address, an access set, and five verbs: the
 * core's four plus `extend` and `super` (and a few built-in members — `projects`,
 * `streams`, `fetch`); every other property falls through to the context's
 * core. Authority is the handle itself: auth happens once at connect, and
 * which context you hold — plus the access set it was minted with — is the
 * whole permission model. Narrowing is construction: a weaker handle is a
 * new handle on a narrower context, never a flag on a wider one.
 *
 * ## Thirty seconds of itx
 *
 * ```ts
 * // You are handed an `itx` — in the REPL, from withItx(), or inside
 * // any platform-loaded isolate via `await env.ITERATE.context`.
 *
 * await itx.describe();                    // what am I holding? what can I call?
 *
 * await itx.slack.chat.postMessage({       // call a capability someone provided —
 *   channel: "C123", text: "hi",           // works because "slack" is in the
 * });                                      // capability table, not because itx knows Slack
 *
 * await itx.fetch("https://api.stripe.com/v1/charges", {
 *   headers: { authorization: 'Bearer getSecret({ key: "STRIPE_KEY" })' },
 * });                                      // egress: the secret is substituted
 *                                          // server-side; this code never sees it
 *
 * await itx.provideCapability({            // teach this context a new trick:
 *   name: "ai",                            // itx.ai.run(model, input)
 *   capability: { type: "rpc", worker: { type: "binding", binding: "AI" } },
 * });
 *
 * using child = await itx.extend({ name: "agent-run-42" });
 * // a cheap, disposable child context: its caps shadow the project's,
 * // misses delegate up the chain.
 * ```
 *
 * One honest caveat on typing: there is ONE `ItxHandle` type, but a live
 * handle is bound to something — a project, a child context, or nothing (a
 * global handle). Members that need a project (`repos`, `workspace`,
 * `worker`, `project`, `fetch`) throw on a global handle until you narrow
 * via `itx.projects.get(...)`. The type system does not yet encode that
 * split; `describe()` is the runtime truth. (Splitting `GlobalItx` /
 * `ProjectItx` is an open design question — see itx-next.md.)
 */

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

/**
 * The capability CORE a context node embeds (src/itx/itx.ts): pure
 * structure — entries, live stubs, longest-prefix dispatch, chain
 * delegation — with every effect injected as one `dial` function. Each
 * context node (the Project DO for a project context, an ItxDurableObject
 * for an extended child) exposes its core via an `itx()` method; handles,
 * ingress, and chain delegation all speak to a stub of it. `invoke`'s
 * `origin` is the chain's trusted identity channel (the context a delegated
 * call STARTED at): nodes set it; handles never forward it.
 */
export interface Itx {
  /** The journaled write; the HANDLE builds the CapabilityProvision its
   * callers hold. */
  provideCapability(input: {
    name?: string;
    path?: string[];
    capability: CapabilityTarget;
    instructions?: string;
    types?: string;
    meta?: CapabilityMeta;
  }): void | Promise<void>;
  revokeCapability(input: { name?: string; path?: string[] }): void | Promise<void>;
  describe(): Promise<CapabilityDescription[]>;
  invoke(input: { path: string[]; args: unknown[]; origin?: ItxOrigin }): Promise<unknown>;
}

/**
 * The trusted identity a delegated call carries up the chain: the context
 * the call STARTED at, as id (attribution, workspace-style scoping) AND
 * address (origin dial-back: an inherited source capability's isolate is
 * wired to the ORIGIN, so its bare fetch() climbs the origin's chain).
 * Set by delegating nodes only — handles never forward it.
 */
export type ItxOrigin = { ref: string; address: CapabilityAddress };

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

/**
 * A live handle on a context — a cheap view over the context node's core.
 *
 * Unknown property names fall through to the context's core at runtime:
 * `itx.slack.chat.postMessage(...)` works because someone provided `slack`.
 * Property access accumulates a path locally (zero round trips); the
 * terminal call dispatches once. Type known caps via
 * {@link KnownCapabilities} merging, or reach anything untyped via
 * `itx.capability(name)`.
 */
export type ItxHandle = ItxBuiltins & KnownCapabilities;

/**
 * The built-in surface of every handle — the trust kernel. Everything else
 * you see on an `itx` is a capability that fell through to the capability table.
 *
 * Child contexts inherit all of this: an extended child's `repos`,
 * `workspace`, and `streams` resolve through its owning project — the child
 * adds a capability table of its own, not a different kernel.
 */
export interface ItxBuiltins {
  /**
   * Provide a capability on this handle's context — THE verb for every
   * provider kind, durable or live: live providers are session-bound
   * (provide again on reconnect); rpc/url addresses are durable. The entry lives at a
   * PATH: `name` is the common 1-segment case, `path` the multi-segment form
   * (exactly one of the two). Dispatch is longest-prefix per context:
   * `provideCapability({ path: ["slack", "chat", "postMessage"], … })`
   * shadows ONE method of an inherited cap while every other `slack.*` call
   * falls through the chain.
   *
   * ```ts
   * // From a laptop/sandbox (inbound, lives while connected): a live
   * // capability is the stub itself — a bare function (auto-wrapped:
   * // calling the cap calls the function; it has no member tree), an
   * // object, or an RpcTarget.
   * await itx.provideCapability({
   *   name: "runSwiftOnMyMac",
   *   capability: async (src) => runSwift(src),
   *   instructions: "Compile-and-run Swift on Jonas's Mac.",
   * });
   *
   * // A raw platform binding (outbound, durable):
   * await itx.provideCapability({
   *   name: "ai",
   *   capability: { type: "rpc", worker: { type: "binding", binding: "AI" } },
   * });
   *
   * // First-party MCP client, parameterized per server (see CapabilityTarget):
   * await itx.provideCapability({
   *   name: "docs",
   *   capability: {
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
   * // Shadow one method of an inherited cap on an extension:
   * await extension.provideCapability({
   *   path: ["workspace", "gitPush"],
   *   capability: approvalGate,
   * });
   * ```
   */
  provideCapability(input: {
    name?: string;
    path?: string[];
    capability: CapabilityTarget;
    /** A sentence for the human/agent who finds this cap. Stored as the
     * `instructions` meta convention field and lifted by describe(). */
    instructions?: string;
    /** TypeScript declarations for the cap's surface — the machine/editor
     * counterpart of `instructions`. Stored as the `types` meta convention
     * field and lifted by describe(). */
    types?: string;
    meta?: CapabilityMeta;
  }): Promise<CapabilityProvision>;

  /** Remove an entry — exact path match, never prefix; `name`/`path` as in
   * {@link provideCapability}. The defaults cannot be revoked, only
   * shadowed (revoking a shadow resurfaces the default). */
  revokeCapability(input: { name?: string; path?: string[] }): Promise<void>;

  /**
   * The explicit dispatch form of the fallthrough: one core dispatch
   * with the full call path. `itx.invoke({ path: ["slack", "chat",
   * "postMessage"], args: [msg] })` ≡ `itx.slack.chat.postMessage(msg)`.
   * Useful when the path is computed.
   */
  invoke(input: { path: string[]; args: unknown[] }): Promise<unknown>;

  /**
   * Event streams, keyed by `{ projectId, path }`. On a PROJECT handle this
   * is a default cap (StreamsCapability loopback, shadowable) pinned to
   * the project; on a GLOBAL handle it is kernel — the
   * deployment-wide global stream scope gated on the connect-time access
   * set, which no cap definition can express. See {@link StreamRef} for
   * the relative/absolute addressing forms.
   */
  readonly streams: ItxStreams;

  /** Narrow to a project — the access check, returning a NEW handle. There
   * is no separate "project object"; a narrowed itx IS the project. */
  readonly projects: ItxProjects;

  /** A DEFAULT, not kernel (§8 shipped): the project's git repos —
   * an ordinary `platform:project` cap definition (ReposCapability
   * loopback), shadowable like any inherited cap. Surface unchanged. */
  readonly repos: unknown;

  /** A DEFAULT, not kernel: workspace readFile/writeFile and the
   * flat git methods (gitClone/gitAdd/gitCommit/gitPush/gitStatus — nested
   * RpcTargets do not survive RPC boundaries). Context-scoped: chain
   * delegation carries the ORIGINATING context, so an extended child context
   * gets its own isolated workspace even though the definition lives on
   * `platform:project`. */
  readonly workspace: unknown;

  /** A DEFAULT, not kernel: the project's own worker — an ordinary
   * `{ type: "repo" }` source provide pointed at the project repo, built
   * per commit. `itx.worker.someTool(args)` reaches any public method of
   * its default export. */
  readonly worker: unknown;

  /** The Project Durable Object stub, whole surface ("cap #0"). If your
   * handle is on this project's context at all, you get all of it. */
  readonly project: unknown;

  /**
   * A DEFAULT, not kernel: explicit project egress, as sugar over the
   * context's `fetch` capability (`platform:project` defines the default).
   * The default pipe substitutes secret placeholders inside the project's
   * egress hop — `'Bearer getSecret({ key: "X_TOKEN" })'` in a header never
   * sees the material. Isolates the platform loads get this same dispatch
   * bound as their global `fetch`, so inside a capability or itx script,
   * bare `fetch()` and `itx.fetch()` are the same door.
   *
   * Because it is a capability, it is SHADOWABLE: provide your own `fetch`
   * (e.g. a live provider implementing `call({ path: [], args: [request] })
   * → Response`) and ALL project egress flows through your provider while it
   * is connected; revoke it and the default resurfaces. A shadow provider
   * receives `getSecret(...)` placeholders UNSUBSTITUTED — substitution only
   * happens in the default pipe, so an interceptor never sees secret
   * material.
   */
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;

  /**
   * Who/what am I holding? `describe()` always works, on every handle, and
   * endeavors to return every breadcrumb you need to explore from here:
   * the context, the access set, and the merged capability chain — each cap
   * with its provenance and its provider-supplied `instructions`. When in
   * doubt, describe.
   */
  describe(): Promise<ItxDescription>;

  /** Explicit form of the fallthrough: `itx.capability("slack")` ≡
   * `itx.slack`. A known cap name (merged into {@link KnownCapabilities})
   * resolves to its typed stub; any other name falls through to `unknown`.
   * Useful when the name is computed or shadowed by a built-in. */
  capability<K extends keyof KnownCapabilities>(name: K): KnownCapabilities[K];
  capability(name: string): unknown;

  /**
   * Extend this context with a child: same anatomy, cheaper, disposable —
   * a session, a REPL scratchpad. The child's caps shadow this context's;
   * misses delegate up the chain (prototype semantics: children extend
   * parents, resolution climbs upward). The child's authority is exactly
   * its owning project, even if this handle was wider.
   *
   * The child IS a stream coordinate: pass `path` to put it on a meaningful
   * stream (an MCP session's, a run's), or take the generated `/itx/<id>`
   * catch-all. Extending an existing path is get-or-create.
   */
  extend(opts?: { name?: string; path?: string }): Promise<ItxHandle>;

  /**
   * A handle on the PARENT context — the "call next()" of middleware: a
   * `fetch` shadow delegates to the unshadowed pipe via
   * `itx.super.fetch(request)`. A context's parent comes from its creation
   * event; the project context's parent is the defaults (the chain's
   * read-only code root).
   */
  readonly super: ItxHandle;
}

/**
 * What `provideCapability` returns. `revoke()` removes the entry;
 * `Symbol.dispose` auto-revokes ONLY live provides — a live capability dies
 * with its session anyway, while a durable provide must survive the session
 * that created it (session teardown disposes every returned handle), so a
 * durable provision's disposer is deliberately a no-op.
 */
export interface CapabilityProvision {
  revoke(): Promise<void>;
  [Symbol.dispose](): void;
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
 *   interface KnownCapabilities {
 *     slack: Stubify<import("@slack/web-api").WebClient>;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- empty on purpose: this is the declaration-merge point
export interface KnownCapabilities {}

/** What `describe()` returns. Aspirational contract: as many breadcrumbs as
 * we can possibly give you — this should always be the best starting point
 * for exploring what exists. */
export type ItxDescription = {
  /** "global", or the context's stream coordinate (`<projectId>:<path>` —
   * the project context is `<projectId>:/`). */
  context: ContextRef;
  /** What this handle may narrow to: "all" (admin) or named project ids. */
  access: ProjectAccess;
  /** Attribution: which capability's isolate holds this handle, if any
   * (the dotted route). */
  capabilityPath?: string;
  /** The merged capability chain (own caps first, ancestors' after —
   * inherited entries carry `from`), including each cap's `instructions`. */
  capabilities: CapabilityDescription[];
  /** The bound project's own description, if this handle has one. */
  project: unknown | null;
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * THE capability target. Two kinds:
 *
 * - live — inbound. Something connected to this context and handed us a
 *   stub; the cap exists exactly as long as that connection does. The one
 *   non-serializable kind, and it has NO wrapper: the target IS the stub
 *   (a function, an object of functions, an RpcTarget). Discrimination is
 *   structural — a serializable target is a plain data object carrying
 *   `type: "rpc"`; anything else is live.
 * - `rpc` — outbound, inside the Workers RPC universe. "There is an RPC
 *   target in some worker; here is how to reach it." The worker may be a
 *   platform binding, the platform worker's own exports, the project
 *   worker, a Durable Object, or a dynamic worker materialized from stored
 *   source — see {@link WorkerRef}.
 *
 * Deliberately NOT here: MCP and OpenAPI. Those are not transports — they
 * are client implementations, i.e. ordinary RPC targets. The platform ships
 * an `McpClient` entrypoint (reach it via
 * `worker: { type: "loopback" }`, parameterized by `props`), and nothing
 * stops you from shipping your own version as a module in your project's
 * repo (an ordinary `{ type: "repo" }` source). If a first-party client
 * needs to be special, the design has failed.
 *
 * (Possible later kind, deliberately absent until needed: a re-export of a
 * cap registered on another context.)
 */
export type CapabilityTarget = LiveStub | CapabilityAddress;

/**
 * The serializable kinds of {@link CapabilityTarget} — this realm's sturdy
 * refs, and (per the address unification) also how context nodes themselves
 * are addressed. The non-serializable live kind never appears here: live
 * stubs exist only in the core's in-memory table.
 */
export type CapabilityAddress = {
  type: "rpc";
  worker: WorkerRef;
  /** Named export to use; defaults to the worker's default export (or,
   * for `binding` workers, the binding object itself). */
  entrypoint?: string;
  /** Instantiation props for the entrypoint (the ProjectEgress
   * pattern): serializable parameterization like a server URL or a
   * gateway choice. The dial adds `{ context, capabilityPath }` attribution at
   * dial time. */
  props?: Record<string, unknown>;
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
   * `McpClient` and thin policy wrappers around bindings, parameterized
   * per provide via `props`. */
  | { type: "loopback" }
  /** A Durable Object, addressed by namespace binding + instance name. The
   * dial scopes the instance name under the owning project —
   * `getByName(\`itx:<projectId>:<name>\`)` — so a name only ever reaches
   * instances belonging to this project, never a sibling's. */
  | { type: "durable-object"; binding: string; name: string }
  /** A dynamic worker materialized on demand from a stored source: code
   * carried inline in the record itself, or code living in one of the
   * project's repos. The project's own worker is exactly this — a repo
   * source — not a special kind. */
  | { type: "source"; source: WorkerSource };

/**
 * Stored source for a `{ type: "source" }` worker. The platform materializes
 * it into an isolate on demand. Inside it: bare `fetch()` IS project egress
 * (secrets substituted server-side, never visible to this code), and
 * `env.ITERATE` is an itx scoped to the cap's home context — a capability
 * can never reach wider than where it is provided.
 */
export type WorkerSource = (
  | {
      /** The code travels in the capability record itself. The loader
       * caches the materialized isolate by `cacheKey`, so it MUST change
       * whenever `modules` change; a content hash is the ideal value. */
      type: "inline";
      cacheKey: string;
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      /** The code lives in one of the project's repos. Built per COMMIT —
       * never per call — through @cloudflare/worker-bundler, memoized in R2
       * by hash(repoPath, sha, path, bundle). A pinned commit sha makes the
       * journal entry fully determine behavior; "latest" tracks pushes
       * (the platform `worker` default uses it). With no `bundle`, the
       * file at `path` IS the worker, verbatim. */
      type: "repo";
      repoPath: string;
      commit: string | "latest";
      path: string;
      bundle?: { minify?: boolean; externals?: string[] };
    }
) & {
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
 * The kernel knows exactly ONE calling convention: every capability is
 * dispatched as `target.call({ path, args })`. Whether a dotted path is
 * replayed onto a real member tree is decided at the EDGE where the
 * concrete object lives, never by core data — and the default is always
 * "your object IS the capability":
 *
 * - A LIVE provider is just the value you pass: a plain object of methods
 *   (nested as deep as you like) has the dotted path replayed onto its
 *   members, back in the process where they live; a bare function is called
 *   directly. No wrapper, no client library:
 *
 * ```ts
 * await itx.provideCapability({
 *   name: "answer",
 *   capability: { ultimate: () => 42, deep: { thought: (q) => think(q) } },
 * });
 * itx.answer.deep.thought("…")   // replays ["deep","thought"] on YOUR object
 * ```
 *
 * - A live provider that implements `call` itself owns its whole
 *   method-tree semantics instead (the SDK shape — the public SDK docs
 *   become the tool docs, with a ten-line forwarder):
 *
 * ```ts
 * // provider: class { call({ path, args }) { return slackApi(path.join("."), args[0]); } }
 * itx.slack.chat.postMessage({ … })   // → ONE call: call({ path: ["chat","postMessage"], … })
 * ```
 *
 * - The dial wraps the objects it resolves itself — env bindings, loader
 *   entrypoints, facets — with its own plain in-process wrapper (dial.ts),
 *   so a source cap just exports methods and its whole public surface is
 *   replayed: `itx.myCap.add({ a: 1, b: 2 })` replays ["add"] on the
 *   entrypoint.
 */
export type PathCall = { path: string[]; args: unknown[] };

/** What every dispatched capability target implements. */
export type PathCallable = { call(input: PathCall): unknown };

/**
 * A live provider's stub: a function, an object of functions, or an
 * RpcTarget. Structural and opaque — it may arrive over Cap'n Web (a
 * browser tab, a Node process, an agent's sandbox) or Workers RPC; the
 * core relies only on protocol-level controls (`dup`, `onRpcBroken`,
 * `Symbol.dispose`) when present.
 */
export type LiveStub = object;

/**
 * Arbitrary metadata on a provide. The journal stores it verbatim and
 * surfaces it in `describe()` — there is no schema. Two conventions worth
 * following, a pair: `instructions` for the human/agent (a sentence on what
 * the cap does and how to call it) and `types` for the machine/editor
 * (TypeScript declarations of the cap's surface). Both are LIFTED to the
 * entry's top level by `describe()` and removed from the projected meta —
 * each fact appears once (the journal record keeps the full meta).
 */
export type CapabilityMeta = {
  /** Shown in describe(); write it for the agent who finds this cap. */
  instructions?: string;
  /** TypeScript declarations for the cap's surface (completion/typecheck
   * material; the machine-facing counterpart of `instructions`). */
  types?: string;
  /** Provenance convention: who appended the provide. */
  providedBy?: { type: "user" | "agent" | "system"; id: string };
  /** HTTP routing flag (capability ingress): an exposed cap is publicly
   * routable at its own `{cap}--{project}` hostname; an unexposed cap does
   * not exist as a hostname at all. */
  http?: { expose: boolean };
  [key: string]: unknown;
};

/** A capability's kind is its provider's kind. */
export type CapabilityKind = "live" | "rpc";

/** How describe() labels entries inherited from the defaults — the
 * code-rooted final link of every chain (platform-context.ts). The internal
 * chain id stays internal plumbing; handles, agents, and the REPL see plain
 * `from: "defaults"`: an inherited default you can shadow. */
export const DEFAULTS_DESCRIBE_FROM = "defaults";

/** A capability entry as reported by `describe()`. Never contains live stubs. */
export type CapabilityDescription = {
  name: string;
  /** The target's kind: "live" | "rpc". */
  kind: CapabilityKind;
  /** INHERITED entries only: which chain link the entry comes from — a
   * context id, or `"defaults"` ({@link DEFAULTS_DESCRIBE_FROM}) for the
   * code-rooted defaults. The described context's own entries carry no
   * provenance field at all. */
  from?: string;
  /** Live caps only: is the provider currently connected? */
  connected?: boolean;
  /** Lifted from meta: the one thing to read first. */
  instructions?: string;
  /** Lifted from meta: TypeScript declarations for the cap's surface. */
  types?: string;
  /** The provide's remaining meta (e.g. `http`); `instructions`/`types`
   * live at the top level, not in here. */
  meta: CapabilityMeta;
  updatedAtMs: number;
};

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * How a stream is addressed. Streams are keyed by `{ projectId, path }`;
 * `projectId: null` is the deployment-wide global scope. All of these reach
 * the same project stream:
 *
 * ```ts
 * itx.streams.get("proj_123:/chat")                         // absolute, string
 * itx.streams.get({ projectId: "proj_123", path: "/chat" }) // absolute, structured
 * itx.projects.get("proj_123").streams.get("/chat")         // narrow, then relative
 * ```
 *
 * Absolute forms are sugar: they internally construct the narrowed handle
 * and call through — one code path, and resolution is always checked
 * against the handle's authority (a project handle cannot fully-qualify its
 * way out).
 */
export type StreamRef = string | { projectId: string | null; path: string };

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

export type StreamCoreProcessorState = unknown;
export type StreamRuntimeState = {
  coreProcessorState: StreamCoreProcessorState;
  runtime: { connections: Record<string, unknown> };
};
export type ProcessorRuntimeState = {
  snapshot: {
    offset: number;
    state: unknown;
  };
  runtime?: Record<string, unknown>;
};
export type StreamSubscriptionHandle = { unsubscribe(): void };
export type StreamSubscriberDescriptor = { description?: string; [key: string]: unknown };
export type StreamSubscriptionBatch = {
  events: StreamEvent[];
  state: StreamCoreProcessorState;
  streamMaxOffset: number;
};

/** A handle pinned to one stream. */
export interface ItxStream {
  append(args: { streamPath?: string; event: StreamEventInput }): Promise<StreamEvent>;
  appendBatch(args: { streamPath?: string; events: StreamEventInput[] }): Promise<StreamEvent[]>;
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined>;
  getEvents(args?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): Promise<StreamEvent[]>;
  waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate(event: StreamEvent): boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent>;
  runtimeState(): Promise<StreamRuntimeState>;
  getProcessorRuntimeState(args: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null>;
  kill(): Promise<void>;
  reset(): Promise<void>;
  reduce(args: {
    event: StreamEvent;
    coreProcessorState?: StreamCoreProcessorState;
  }): Promise<StreamCoreProcessorState>;
  subscribe(args: {
    subscriptionKey?: string;
    processEventBatch(batch: StreamSubscriptionBatch): unknown;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    events?: boolean;
    subscriber?: StreamSubscriberDescriptor;
  }): Promise<StreamSubscriptionHandle>;
}

/** The streams collection, project-bound by the handle. */
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
  get(projectIdOrSlug: string): Promise<ItxHandle>;
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
  /**
   * Create a project. An ADMIN handle takes the operator/recovery path
   * (optional explicit `id`, no owning org). A non-admin USER handle (the
   * global handle minted with the connect principal's org claims) creates in
   * an organization the user belongs to — `organizationSlug` chooses which, or
   * is inferred when the user has exactly one org.
   */
  create(input: {
    id?: string;
    slug: string;
    organizationSlug?: string;
  }): Promise<{ id: string; slug: string }>;
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
export type ItxFn<R = unknown> = (itx: ItxHandle) => Promise<R> | R;

/**
 * Map an SDK's type surface onto its itx stub: every function becomes
 * async, everything else recurses. With this, {@link KnownCapabilities} merging
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
 * A context's sturdy ref: `"global"`, or the context's stream coordinate
 * `<projectId>:<path>` — identity, stream, and node address as one string
 * (the project context is `<projectId>:/`; an agent's is
 * `<projectId>:<agentPath>`).
 */
export type ContextRef = "global" | `${string}:/${string}`;

/**
 * The simplified access model: which projects a handle may narrow to —
 * `"all"` (the admin API secret / an admin session) or a list of project
 * ids exactly as connect-time auth resolved them. Nothing finer-grained
 * exists. (The wire home of this shape is src/itx/refs.ts; it is declared
 * inline here because this file imports nothing.)
 */
export type ProjectAccess = "all" | string[];

/**
 * The ONE serializable parameterization in the system — what crosses a
 * boundary when the platform wires a handle into an isolate. Props carry
 * identity, never composition or authority-by-content:
 *
 * - `context`: which context — the ref IS the coordinate, so the node
 *   address and owning project are projections of it; nothing resolves
 *   through a directory. The restorer turns it into a live handle.
 * - `access`: honored on global handles only; a context handle is always
 *   bound to exactly its own project regardless of what props claim.
 * - `capabilityPath`: pure attribution — which capability's isolate holds
 *   this handle (the dotted route). It grants nothing; it labels egress and
 *   records.
 */
export type ItxProps = {
  context: ContextRef;
  access?: ProjectAccess;
  capabilityPath?: string;
};
