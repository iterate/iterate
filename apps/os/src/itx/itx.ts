// The itx CORE: an Itx holds capabilities; everything else holds a stub of
// one (itx-next.md §5, "the address unification" step (c)).
//
// One pure class owns the STRUCTURE of the capability system — the path-keyed
// entry map, the session-bound live-stub table, longest-prefix dispatch,
// describe/provide/revoke/invoke, and parent-chain delegation through
// `parentItx` (literally a stub of the parent node's core). Everything
// effectful is injected as ONE function: `dial`, which turns a
// CapabilityAddress into something speaking `call({ path, args })`
// (durable-itx.ts builds it; the core never touches env, SQLite, streams, or
// a project id). Reachability (the dialable allowlists) is the dial's
// concern and surfaces at FIRST CALL; the core's provideCapability does only
// structural validation — path legality, the live-vs-address discriminator,
// address well-formedness.
//
// Hosts: both context-node DOs (Project DO, ContextDO) expose the core via an
// `itx()` method — a property getter was the design's first choice, but
// workerd does not pipeline calls through property accesses (see
// ProjectDurableObject.processor), so the method form keeps
// `node.itx().invoke(...)` a single pipelined round trip. Persistence is the
// host's wrapper (DurableItx, durable-itx.ts) — interim until the
// ItxProcessor journal (wave f) replaces it.

import { RpcTarget } from "cloudflare:workers";
import {
  replayPathCall,
  RESERVED_PATH_SEGMENTS,
  type PathCall,
  type PathCallable,
} from "./path-proxy.ts";
import { GLOBAL_CONTEXT_ID, isChildContextId } from "./refs.ts";
import type { ContextDescriptor } from "./context-do.ts";

// Server-side one-stop: the calling-convention pieces live in path-proxy.ts
// only because Node/browser providers import them at runtime and THIS module
// imports cloudflare:workers. Server code imports them from here.
export {
  asPathCallable,
  replayPathCall,
  RESERVED_PATH_SEGMENTS,
  type PathCall,
  type PathCallable,
} from "./path-proxy.ts";

export class Itx extends RpcTarget {
  /** Dotted path → entry. ONE layer: constructor defaults and runtime
   * provides share it, last-write-wins per path. */
  #capabilities = new Map<string, ProvidedCapability>();
  /** Session-bound, dup-retained live provider stubs. In-memory on purpose:
   * a connection cannot be persisted (workerd#6087 may change this). */
  #liveStubs = new Map<string, LiveProvider>();
  /** Constructor defaults by path, retained so a revoked shadow resurfaces
   * the default and the default itself refuses revocation. */
  readonly #defaults = new Map<string, ProvidedCapability>();
  /** A stub of the parent node's core: misses delegate the WHOLE path up. */
  readonly parentItx?: ItxStub;
  /** describe() owner label for runtime provides + the default origin. */
  readonly contextId: string;
  /** THE only effect: address → something speaking call({ path, args }). */
  readonly #dial: CapabilityDial;

  constructor(input: {
    contextId: string;
    dial: CapabilityDial;
    parentItx?: ItxStub;
    /** Constructor defaults, applied in order (last-write-wins per path). */
    capabilities?: ProvideCapabilityInput[];
    /** describe() provenance for the constructor defaults. */
    owner?: string;
  }) {
    super();
    this.contextId = input.contextId;
    this.#dial = input.dial;
    this.parentItx = input.parentItx;
    const owner = input.owner ?? "platform:project";
    for (const capability of input.capabilities ?? []) {
      const entry = this.#provide(capability, { owner, updatedAtMs: 0 });
      this.#defaults.set(entry.name, entry);
    }
  }

  /**
   * Register a capability — ONE verb for every provider kind. A
   * CapabilityAddress (plain data carrying type "rpc" | "url") registers
   * durably-shaped; anything else is a LIVE provider stub, session-bound:
   * the entry survives (describe() reports "registered but offline") but the
   * stub dies with the provider's session. The entry lives at a PATH —
   * `name` is the 1-segment sugar, `path` shadows one subtree of an
   * inherited cap (longest-prefix dispatch); exactly one of the two.
   */
  provideCapability(input: ProvideCapabilityInput): void {
    this.#provide(input, { owner: this.contextId, updatedAtMs: Date.now() });
  }

  /** Remove an entry (exact path match, never prefix). A revoked shadow
   * resurfaces the constructor default; the default itself can only be
   * shadowed — revoking it would lie (the next construction re-applies it). */
  revokeCapability(input: { name?: string; path?: string[] }): void {
    const name = capabilityPathFrom(input).join(".");
    const fallback = this.#defaults.get(name);
    if (fallback && this.#capabilities.get(name) === fallback) {
      throw new Error(
        `Capability "${name}" is a platform default (${fallback.owner}); ` +
          `it cannot be revoked — provide your own "${name}" to shadow it.`,
      );
    }
    this.#dropLiveStub(name);
    this.#capabilities.delete(name);
    if (fallback) this.#capabilities.set(name, fallback);
  }

  /**
   * The merged chain view: own entries (each with its `owner` provenance —
   * defaults carry the constructor owner, runtime provides this contextId),
   * then the parent chain's. Suppression is deliberately EXACT-match only: a
   * path define ("sdk.chat.postMessage") shadows just its subtree — the
   * parent's "sdk" stays live for every other path, so hiding it here would
   * lie about what longest-prefix dispatch actually resolves.
   */
  async describe(): Promise<CapabilityDescription[]> {
    const own = [...this.#capabilities.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (entry): CapabilityDescription => ({
          connected: entry.kind === "live" ? this.#liveStubs.has(entry.name) : undefined,
          instructions:
            typeof entry.meta.instructions === "string" ? entry.meta.instructions : undefined,
          kind: entry.kind,
          meta: entry.meta,
          name: entry.name,
          owner: entry.owner,
          types: typeof entry.meta.types === "string" ? entry.meta.types : undefined,
          updatedAtMs: entry.updatedAtMs,
        }),
      );
    if (!this.parentItx) return own;
    const shadowed = new Set(own.map((description) => description.name));
    const inherited = await this.parentItx.describe();
    return [...own, ...inherited.filter((description) => !shadowed.has(description.name))];
  }

  /**
   * The only dispatch in the system (spec §4.4). `path` is the FULL call
   * path (entry path + member path); the longest provided prefix wins and is
   * dialed with the REMAINDER as the call path. A miss delegates the whole
   * path up the chain, carrying `origin` — the context the call STARTED at —
   * so context-scoped caps (the workspace) resolve against the caller's
   * context, not the node the definition lives on. Absent origin means the
   * call originated here.
   */
  async invoke(input: { path: string[]; args: unknown[]; origin?: string }): Promise<unknown> {
    const resolved = resolveLongestProvidedPrefix(this.#capabilities, input.path);
    if (!resolved) {
      if (this.parentItx) {
        return await this.parentItx.invoke({
          ...input,
          origin: input.origin ?? this.contextId,
        });
      }
      throw new Error(
        `No capability named "${input.path[0] ?? ""}" in context ${this.contextId}` +
          (input.path.length > 1 ? ` (call path "${input.path.join(".")}").` : `.`),
      );
    }
    // Every dispatch works on a BORROW disposed when the call ends — a
    // .dup() of the live stub (the stored one stays callable for the next
    // caller), or whatever the dial minted for this call.
    const { entry, remainder } = resolved;
    const borrowed = this.#borrow(entry, input.origin ?? this.contextId);
    try {
      return await borrowed.call({ args: input.args, path: remainder });
    } catch (error) {
      // Log at the supervisor: errors crossing RPC back to the caller can be
      // masked as "internal error; reference = …", so the only place the
      // real failure is visible is here.
      console.error(
        `[itx] cap "${entry.name}" (${entry.kind}) failed in ${this.contextId} ` +
          `at path ${remainder.join(".") || "<call>"}:`,
        error,
      );
      throw error;
    } finally {
      disposeIfPossible(borrowed);
    }
  }

  // ---- protected doors for the durable host wrapper (DurableItx) ----------
  // Interim surface: wave (f) replaces DurableItx with the ItxProcessor
  // journal and these go with it.

  /** Re-seat a persisted entry verbatim — applied AFTER constructor defaults
   * so stored rows win per last-write-wins. No validation, no stub: restored
   * live entries are disconnected until their provider reconnects. */
  protected restoreCapability(entry: ProvidedCapability): void {
    this.#capabilities.set(entry.name, entry);
  }

  /** The entry a provide just wrote (the persistence wrapper reads it back). */
  protected providedCapability(name: string): ProvidedCapability | undefined {
    return this.#capabilities.get(name);
  }

  /** Host hook: a live provider's session broke (or it was replaced/revoked).
   * The entry stays — describe() reports it offline. */
  protected capabilityDisconnected(_name: string): void {}

  // ---- internals -----------------------------------------------------------

  #provide(
    input: ProvideCapabilityInput,
    provenance: { owner: string; updatedAtMs: number },
  ): ProvidedCapability {
    const path = capabilityPathFrom(input);
    assertValidCapabilityPath(path);
    const name = path.join(".");
    const meta: CapabilityMeta = {
      ...(input.meta ?? {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.types !== undefined ? { types: input.types } : {}),
    };

    let entry: ProvidedCapability;
    if (isCapabilityAddress(input.provider)) {
      assertWellFormedCapabilityAddress(name, input.provider);
      entry = { address: input.provider, kind: input.provider.type, meta, name, ...provenance };
      this.#dropLiveStub(name);
    } else {
      // A PLAIN object carrying a string `type` is a malformed address
      // (typo, unknown kind), not a live provider — fail loudly instead of
      // registering something that looks like an offline live cap.
      const type = isPlainObject(input.provider)
        ? (input.provider as { type?: unknown }).type
        : undefined;
      if (typeof type === "string") {
        throw new Error(
          `Capability "${name}": unknown target type ${JSON.stringify(type)} — ` +
            `addresses are "rpc" or "url"; anything else must be a live provider stub.`,
        );
      }
      entry = { address: null, kind: "live", meta, name, ...provenance };
      this.#registerLiveStub(name, input.provider as LiveProvider);
    }
    this.#capabilities.set(name, entry);
    return entry;
  }

  #registerLiveStub(name: string, provider: LiveProvider): void {
    // RPC disposes argument stubs when the call returns; keep a duplicate
    // (and hand further dups to borrowers) — both directions of the dup()
    // discipline from the original capnweb learnings.
    const retained = provider.dup ? provider.dup() : provider;
    this.#dropLiveStub(name);
    this.#liveStubs.set(name, retained);
    // Best-effort teardown registration: capnweb stubs implement onRpcBroken
    // locally, but Workers-RPC stubs proxy EVERY property as a remote method,
    // so on a provider that doesn't implement it the call rejects with "does
    // not implement" instead of reading undefined — swallow that; the
    // connection still dies with the session either way.
    const teardown = () => {
      if (this.#liveStubs.get(name) === retained) this.#dropLiveStub(name);
    };
    void Promise.resolve(retained.onRpcBroken?.(teardown) as unknown).catch(() => {});
  }

  #dropLiveStub(name: string): void {
    const stub = this.#liveStubs.get(name);
    if (!stub) return;
    this.#liveStubs.delete(name);
    this.capabilityDisconnected(name);
    stub[Symbol.dispose]?.();
  }

  /** The two-case shape: a capability is either held up by a live connection
   * (borrow a dup), or its address is dialed at invoke time. */
  #borrow(entry: ProvidedCapability, origin: string): PathCallable {
    if (entry.kind === "live") {
      const stub = this.#liveStubs.get(entry.name);
      if (!stub) throw new CapabilityOfflineError(entry.name);
      return (stub.dup ? stub.dup() : stub) as unknown as PathCallable;
    }
    return this.#dial(entry.address!, { capability: entry.name, origin });
  }
}

// ---- the capability data model ----------------------------------------------

/** A capability's kind is its provider's kind (design of record: types.ts). */
export type CapabilityKind = "live" | "rpc" | "url";

/**
 * The serializable capability addresses — this realm's sturdy refs, and (per
 * the address unification) also how context nodes themselves are addressed.
 * The non-serializable live kind never appears here: live stubs exist only
 * in the core's in-memory table.
 */
export type CapabilityAddress =
  | {
      type: "rpc";
      worker: WorkerRef;
      /** Named export to instantiate (loopback refs require it). For
       * `source` refs the export is named by `source.entrypoint` instead. */
      entrypoint?: string;
      /** Instantiation props (the ProjectEgress pattern). The dial adds
       * `{ capability, context, projectId }` attribution at dial time. */
      props?: Record<string, unknown>;
    }
  | {
      /** A remote Cap'n Web server. The dial terminates in the UrlDial
       * stateless worker (Law 7); `headers` ride the WebSocket handshake and
       * pass through egress getSecret() substitution (Law 5). */
      type: "url";
      url: string;
      headers?: Record<string, string>;
    };

/** Where an rpc address's worker lives (design of record: types.ts). The
 * project worker is NOT a kind: it is the `ProjectWorker` loopback
 * forwarder (user export + inner invoke mode ride in props). */
export type WorkerRef =
  | { type: "binding"; binding: string }
  | { type: "loopback" }
  | { type: "durable-object"; binding: string; name: string }
  | { type: "source"; source: CapabilitySource };

/**
 * Source for a `{ type: "source" }` worker ref. `cacheKey` MUST change
 * whenever the module contents change — the Worker Loader caches the
 * materialized isolate by it (a content hash is the ideal value).
 */
export type CapabilitySource = {
  cacheKey?: string;
  mainModule: string;
  modules: Record<string, string>;
  /** Named export to use; defaults to the default export. */
  entrypoint?: string;
  /**
   * What the entrypoint export IS: "worker-entrypoint" (default; stateless,
   * fresh isolate per call) or "durable-object" (stateful; a NAMED export
   * extending DurableObject, instantiated as a facet of the hosting context
   * node with its own private SQLite).
   */
  exportType?: "worker-entrypoint" | "durable-object";
  compatibilityDate?: string;
};

export function capabilitySourceCacheKey(source: CapabilitySource): string {
  const key = source.cacheKey;
  if (!key) {
    throw new Error(
      "CapabilitySource needs a cacheKey (rotate it whenever modules change; a content hash is ideal).",
    );
  }
  return key;
}

/**
 * A live provider's stub as the core sees it. Structural because the stub
 * may arrive over Cap'n Web (browser/Node provider) or Workers RPC and we
 * only rely on the protocol-level controls.
 */
export type LiveProvider = {
  dup?: () => LiveProvider;
  onRpcBroken?: (callback: (error: unknown) => void) => void;
  [Symbol.dispose]?: () => void;
} & Record<string, unknown>;

/**
 * Arbitrary metadata, stored verbatim and surfaced by describe(). There is
 * no schema — the named fields below are conventions:
 * - `instructions`: a sentence for the human/agent who finds this cap.
 * - `types`: TypeScript declarations for the cap's surface — the
 *   machine/editor counterpart of the human-facing `instructions`.
 * - `http`: HTTP routing flags (spec §8).
 */
export type CapabilityMeta = {
  instructions?: string;
  types?: string;
  providedBy?: { type: "user" | "agent" | "system"; id: string };
  http?: { expose: boolean; public?: boolean };
  [key: string]: unknown;
};

/** provideCapability's input — `instructions`/`types` are sugar for the meta
 * convention fields of the same names (the explicit meta spelling wins). */
export type ProvideCapabilityInput = {
  name?: string;
  path?: string[];
  provider: LiveProvider | CapabilityAddress;
  instructions?: string;
  types?: string;
  meta?: CapabilityMeta;
};

/** One entry of the core's capability map. `owner` is provenance: which
 * context (or code-defined default set) put it there. */
export type ProvidedCapability = {
  name: string;
  kind: CapabilityKind;
  /** null iff kind is "live" — the stub lives in the session table instead. */
  address: CapabilityAddress | null;
  owner: string;
  meta: CapabilityMeta;
  updatedAtMs: number;
};

/** An entry as reported by describe(); never contains live stubs. */
export type CapabilityDescription = {
  name: string;
  kind: CapabilityKind;
  /** Which context owns the entry — provenance for shadowing visibility. */
  owner: string;
  /** Live caps only: is the provider currently connected? */
  connected?: boolean;
  /** Lifted from meta for convenience: the one thing to read first. */
  instructions?: string;
  /** Lifted from meta: TypeScript declarations for the cap's surface. */
  types?: string;
  meta: CapabilityMeta;
  updatedAtMs: number;
};

/** The one effect injected into the core: turn an address into something
 * speaking call({ path, args }) for THIS call. `attribution` is the per-call
 * knowledge only the core has — the entry name and the originating context —
 * which the dial injects as `{ capability, context }` props (the owning
 * projectId rides in the dial's own closure; the core never touches it). */
export type CapabilityDial = (
  address: CapabilityAddress,
  attribution: { capability: string; origin: string },
) => PathCallable;

/** What a stub of an Itx answers — the context protocol. Both context-node
 * DOs return their core from `itx()`; ContextDO hands its core a parentItx
 * satisfying this type that re-dials the parent node per call (Workers RPC
 * stubs are request-scoped, so a held stub would go stale). */
export type ItxStub = {
  provideCapability(input: ProvideCapabilityInput): Promise<void>;
  revokeCapability(input: { name?: string; path?: string[] }): Promise<void>;
  describe(): Promise<CapabilityDescription[]>;
  invoke(input: { path: string[]; args: unknown[]; origin?: string }): Promise<unknown>;
};

export class CapabilityOfflineError extends Error {
  constructor(name: string) {
    super(
      `Capability "${name}" is registered but its provider is not connected. ` +
        `Live capabilities last as long as the provider's session; the provider must reconnect and provide() again.`,
    );
  }
}

// ---- resolution + validation --------------------------------------------------

/**
 * Longest-prefix resolution (itx-next.md §4): among the provided entries —
 * keyed by dot-joined path — the longest one prefixing the call path wins;
 * the REMAINDER becomes the dispatched call path. One exact lookup per
 * candidate depth, longest first, so resolution stays deterministic and
 * never traverses targets.
 */
function resolveLongestProvidedPrefix(
  capabilities: ReadonlyMap<string, ProvidedCapability>,
  path: string[],
): { entry: ProvidedCapability; remainder: string[] } | null {
  for (let depth = path.length; depth >= 1; depth--) {
    const entry = capabilities.get(path.slice(0, depth).join("."));
    if (entry) return { entry, remainder: path.slice(depth) };
  }
  return null;
}

/**
 * Names that may never be FIRST path segments: a cap must not shadow the
 * trust kernel (it is reachable as `itx.<name>`, so it competes with the
 * handle's built-ins). `fetch` is deliberately NOT here: project egress is a
 * platform default capability and providing your own `fetch` is how egress
 * interception works — the handle's real `fetch` method still wins property
 * lookup; it routes through the core anyway.
 */
const ITX_BUILTIN_NAMES = [
  "capability",
  "describe",
  "fork",
  "invoke",
  "project",
  "projects",
  "provideCapability",
  "revokeCapability",
] as const;

/** A cap name may shadow neither an itx built-in nor a reserved path segment. */
export const RESERVED_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  ...ITX_BUILTIN_NAMES,
  ...RESERVED_PATH_SEGMENTS,
]);

/**
 * Definitions live at PATHS (itx-next.md §4): a name is a 1-segment path.
 * Every segment must be a flat JS identifier so `itx.<a>.<b>` works via the
 * fallthrough proxy and the dot-joined form stays unambiguous as the map
 * key. The two reserved sets split by position: the FIRST segment must not
 * shadow the trust kernel; deeper segments only need the protocol-level path
 * filter — the built-in names are perfectly good method names there.
 */
function assertValidCapabilityPath(path: string[]): void {
  if (path.length === 0) throw new Error("A capability path needs at least one segment.");
  path.forEach((segment, index) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(segment)) {
      throw new Error(
        `Capability path segment ${JSON.stringify(segment)} must be a plain JavaScript identifier.`,
      );
    }
    const reserved = index === 0 ? RESERVED_CAPABILITY_NAMES : RESERVED_PATH_SEGMENTS;
    if (reserved.has(segment)) {
      throw new Error(
        index === 0
          ? `Capability name ${JSON.stringify(segment)} is reserved.`
          : `Capability path segment ${JSON.stringify(segment)} is reserved.`,
      );
    }
  });
}

/**
 * provideCapability/revokeCapability address an entry by `name` (the common
 * case — one segment) OR `path` (multi-segment). Exactly one must be present;
 * both normalize to segments here.
 */
function capabilityPathFrom(input: { name?: string; path?: string[] }): string[] {
  if ((input.name === undefined) === (input.path === undefined)) {
    throw new Error("Provide exactly one of `name` or `path`.");
  }
  return input.path ? [...input.path] : [input.name!];
}

/**
 * The live-vs-address discriminator: an ADDRESS is plain data — an object
 * whose prototype is Object.prototype (or null) carrying `type: "rpc" |
 * "url"`. Everything else — capnweb RpcStubs (callable function-proxies),
 * workers-RPC stubs, RpcTarget instances, plain functions — is a LIVE
 * provider. The plainness check MUST come before any `.type` probe: property
 * access on a capnweb stub returns a truthy pipelined stub, so reading
 * `.type` first would misclassify every live provider.
 */
function isCapabilityAddress(
  provider: LiveProvider | CapabilityAddress,
): provider is CapabilityAddress {
  if (!isPlainObject(provider)) return false;
  const type = (provider as { type?: unknown }).type;
  return type === "rpc" || type === "url";
}

function isPlainObject(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const proto = Object.getPrototypeOf(target);
  return proto === Object.prototype || proto === null;
}

/**
 * STRUCTURAL address validation only — URL parseability, required fields.
 * Reachability (the dialable allowlists) is deliberately NOT checked here:
 * it is the dial's authority and surfaces at first invoke, so a deployment
 * widening its allowlists never strands rows provided before the widening.
 */
function assertWellFormedCapabilityAddress(name: string, address: CapabilityAddress): void {
  if (address.type === "url") {
    let protocol: string;
    try {
      protocol = new URL(address.url).protocol;
    } catch {
      throw new Error(`Capability "${name}": ${JSON.stringify(address.url)} is not a valid URL.`);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) {
      throw new Error(
        `Capability "${name}": url targets must be http(s) or ws(s), got ${JSON.stringify(address.url)}.`,
      );
    }
    return;
  }
  const worker = address.worker;
  switch (worker.type) {
    case "binding":
      if (address.entrypoint) {
        throw new Error(
          `Capability "${name}": binding refs take no entrypoint — the binding object itself is the target.`,
        );
      }
      return;
    case "loopback":
      if (!address.entrypoint) {
        throw new Error(
          `Capability "${name}": loopback refs need an entrypoint (the export name).`,
        );
      }
      return;
    case "source":
      if (worker.source.exportType === "durable-object" && !worker.source.entrypoint) {
        // Default-export DO classes make workerd's facet instantiation fail
        // with an opaque internal error; a NAMED export works (DECISIONS D12).
        throw new Error(
          `Capability "${name}" needs source.entrypoint naming an exported ` +
            `"class X extends DurableObject" (default exports do not work as facet classes).`,
        );
      }
      capabilitySourceCacheKey(worker.source);
      return;
    case "durable-object":
      if (!worker.name) {
        throw new Error(`Capability "${name}": durable-object refs need a non-empty name.`);
      }
      return;
  }
}

// ---- dialable allowlists ------------------------------------------------------

/**
 * Which env bindings / loopback exports an rpc address may dial. Binding and
 * loopback refs reach PLATFORM resources, so an open list would let any
 * project handle reach e.g. the deployment D1, or mint itx handles on
 * arbitrary projects via ItxEntrypoint props. Checked at dial time (= first
 * invoke; provide is structural only). A deployment widens the lists via
 * config (`APP_CONFIG_ITX` → {@link DialableTargets}); the hardcoded
 * defaults always apply.
 */
const DIALABLE_BINDINGS: ReadonlySet<string> = new Set(["AI"]);
/**
 * Loopback entrypoints listed here MUST scope strictly by the dial-time
 * props the dial injects ({ capability, context, projectId }) — never by
 * provider-supplied props — because anyone with a handle on a context can
 * provide a cap dialing them.
 */
const DIALABLE_LOOPBACKS: ReadonlySet<string> = new Set([
  "AgentCapability",
  "AgentToolsCapability",
  "BindingCapability",
  "EgressPipe",
  "GmailCapability",
  "McpClient",
  "OrpcCapability",
  "ProjectWorker",
  "ReposCapability",
  "SlackCapability",
  "StreamsCapability",
  "WorkspaceCapability",
]);

/**
 * Durable Object namespace bindings dialable via `{ type: "durable-object" }`
 * refs. The dial scopes every instance name under the owning project
 * (`itx:<projectId>:<name>`), so an allowlisted namespace's itx-reachable
 * instances are disjoint per project. Still empty by default: namespaces
 * whose EXISTING instances matter (PROJECT, STREAM, …) must not be
 * allowlisted — itx-created instances would be fresh/empty objects under the
 * scoped name, not the real ones.
 */
const DIALABLE_DURABLE_OBJECTS: ReadonlySet<string> = new Set();

/** The dial allowlists a host resolves once (defaults ∪ deployment config). */
export type DialableTargets = {
  bindings: ReadonlySet<string>;
  durableObjects: ReadonlySet<string>;
  loopbacks: ReadonlySet<string>;
};

const DEFAULT_DIALABLE_TARGETS: DialableTargets = {
  bindings: DIALABLE_BINDINGS,
  durableObjects: DIALABLE_DURABLE_OBJECTS,
  loopbacks: DIALABLE_LOOPBACKS,
};

/**
 * Merge the hardcoded defaults with a deployment's config additions
 * (`APP_CONFIG_ITX`). Config can only WIDEN — the defaults always apply, so
 * a misconfigured deployment never loses first-party caps.
 */
export function resolveDialableTargets(config?: {
  dialableBindings?: readonly string[];
  dialableDurableObjects?: readonly string[];
  dialableLoopbacks?: readonly string[];
}): DialableTargets {
  if (
    !config?.dialableBindings?.length &&
    !config?.dialableDurableObjects?.length &&
    !config?.dialableLoopbacks?.length
  ) {
    return DEFAULT_DIALABLE_TARGETS;
  }
  return {
    bindings: new Set([...DIALABLE_BINDINGS, ...(config.dialableBindings ?? [])]),
    durableObjects: new Set([
      ...DIALABLE_DURABLE_OBJECTS,
      ...(config.dialableDurableObjects ?? []),
    ]),
    loopbacks: new Set([...DIALABLE_LOOPBACKS, ...(config.dialableLoopbacks ?? [])]),
  };
}

// ---- context addresses ---------------------------------------------------------

// A context is anything answering the context protocol (ItxStub via the
// node's itx()); its ADDRESS is a CapabilityAddress — "how to dial the node
// that owns this identity". Identity (the string id: "global", a project id,
// "ctx_…") stays identity — audit, workspace scoping, and origin-carrying
// keep using ids; this is THE one place the id→address mapping lives.

/** The Durable Object namespace bindings that host context nodes today. */
const CHILD_CONTEXT_BINDING = "ITX_CONTEXT";
const PROJECT_CONTEXT_BINDING = "PROJECT";

/** What a dialed context NODE answers: its core (the itx() method — a method,
 * not a property, so `node.itx().invoke(...)` pipelines in one round trip),
 * plus, on child-context nodes (ContextDO) only, the descriptor — the one
 * lookup a sturdy ref costs to learn the owning project. Gate on
 * {@link isChildContextAddress} before calling descriptor. */
export type ContextNodeStub = {
  itx(): ItxStub;
  descriptor?(): Promise<ContextDescriptor>;
};

/** The id→address mapping — the save() half of the SturdyRef story. */
export function contextAddressOf(contextId: string): CapabilityAddress {
  if (contextId === GLOBAL_CONTEXT_ID) {
    throw new Error(
      "The global context has no node to dial yet — global handles are minted " +
        "at connect time (itx-next.md, address unification step (c)).",
    );
  }
  if (isChildContextId(contextId)) {
    return {
      type: "rpc",
      worker: { type: "durable-object", binding: CHILD_CONTEXT_BINDING, name: contextId },
    };
  }
  // Anything else is a project id: the Project DO hosts the project context,
  // addressed by the plain project id (getProjectDurableObjectName's rule,
  // inlined here so the pure core never imports the DO module).
  return {
    type: "rpc",
    worker: { type: "durable-object", binding: PROJECT_CONTEXT_BINDING, name: contextId },
  };
}

/** Does this address dial a child-context node (a ContextDO)? Keyed off the
 * structured address, never an id prefix. */
export function isChildContextAddress(address: CapabilityAddress): boolean {
  return (
    address.type === "rpc" &&
    address.worker.type === "durable-object" &&
    address.worker.binding === CHILD_CONTEXT_BINDING
  );
}

/**
 * The restore() half: resolve an address to a live context-node stub. This
 * dial is KERNEL plumbing for addresses written by trusted code (fork, the
 * restorer) — it is deliberately NOT gated by the dialable allowlists:
 * provider-supplied cap addresses stay gated inside the capability dial;
 * parent addresses are written only by kernel code, never by handle holders.
 */
export function dialContext(env: Env, address: CapabilityAddress): ContextNodeStub {
  if (address.type === "url") {
    throw new Error("url context addresses are not dialable yet (federation is a later wave).");
  }
  const worker = address.worker;
  switch (worker.type) {
    case "durable-object": {
      const namespace = (env as unknown as Record<string, unknown>)[worker.binding] as
        | { getByName(name: string): unknown }
        | undefined;
      if (typeof namespace?.getByName !== "function") {
        throw new Error(
          `Context address binding "${worker.binding}" is not a Durable Object namespace on this host.`,
        );
      }
      return namespace.getByName(worker.name) as ContextNodeStub;
    }
    case "loopback":
      throw new Error(
        "Loopback context addresses are not dialable yet — the stateless global/defaults " +
          "contexts land with itx-next.md address unification step (c).",
      );
    case "binding":
    case "source":
      throw new Error(`"${worker.type}" worker refs cannot address a context node.`);
  }
}

// ---- audit event types ----------------------------------------------------------

/** Audit event types appended to the context stream by HOSTS (DurableItx
 * today; the ItxProcessor journal replaces this in wave f). */
export const ITX_EVENT_TYPES = {
  /**
   * ONE provide event for every provider kind: `kind` in the payload records
   * what was provided — "live" (a session-bound provider stub) vs "rpc"/"url"
   * (a durable address). Durable payloads also carry the worker ref type
   * and, for source refs, the cacheKey.
   */
  capabilityProvided: "events.iterate.com/itx/capability-provided",
  capabilityRevoked: "events.iterate.com/itx/capability-revoked",
  capabilityDisconnected: "events.iterate.com/itx/capability-disconnected",
  contextForked: "events.iterate.com/itx/context-forked",
  /**
   * Script execution record (itx-next.md §4, record-only mode): the runner
   * appends `scriptExecutionRequested` before the script starts and
   * `scriptExecutionCompleted` when it settles. The events are the durable
   * record, not the transport — everything between them is invisible to the
   * stream.
   */
  scriptExecutionRequested: "events.iterate.com/itx/script-execution-requested",
  scriptExecutionCompleted: "events.iterate.com/itx/script-execution-completed",
} as const;

/** Dispose a borrowed RPC stub if it is disposable (in-process targets aren't). */
function disposeIfPossible(target: unknown): void {
  const dispose = (target as Partial<Disposable> | null)?.[Symbol.dispose];
  if (typeof dispose === "function") Reflect.apply(dispose, target, []);
}
