// The itx CORE: an Itx holds capabilities; everything else holds a stub of
// one (itx-next.md, "The address unification" — the LOCKED final shape).
//
// ONE class: `Itx extends StreamProcessor`. The context's JOURNAL (an
// ordinary event stream) is the only authority — provides and revokes APPEND
// events and self-ingest them; `reduce` folds the journal into the
// capability table; the checkpoint is a disposable cache of that fold. The
// record and the state cannot disagree, because events are the only writes
// (docs/domain-objects-and-stream-processors.md).
//
// The pure pieces stay module-level so they are provable without workerd or
// streams: `reduceItxJournalEvent` (the fold), `resolveLongestProvidedPrefix`
// (dispatch), path validation, and the live-vs-address discriminator.
//
// Everything effectful is injected: `dial` turns a CapabilityAddress into
// something speaking `call({ path, args })` (dial.ts builds it; the core
// never touches env or a project id), `parentItx` is a stub of the parent
// context's core (chain delegation — the platform defaults are simply the
// chain's code-rooted final link, platform-context.ts), and the journal
// append/read pair rides in as the processor's iterate context.
//
// Hosts: the Project DO and ItxDurableObject expose the core via an `itx()`
// method — a method, not a property, because workerd does not pipeline calls
// through property accesses, so the method form keeps `node.itx().invoke(…)`
// a single pipelined round trip.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import { ItxContract, ITX_EVENT_TYPES, type ItxState } from "./contract.ts";
import {
  replayPathCall,
  RESERVED_PATH_SEGMENTS,
  type PathCall,
  type PathCallable,
} from "./path-proxy.ts";

// Server-side one-stop: the calling-convention pieces live in path-proxy.ts
// only because Node/browser providers import them at runtime. Server code
// imports them from here.
export {
  asPathCallable,
  replayPathCall,
  RESERVED_PATH_SEGMENTS,
  type PathCall,
  type PathCallable,
} from "./path-proxy.ts";
export { ItxContract, ITX_EVENT_TYPES, type ItxState } from "./contract.ts";

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
       * `{ capabilityPath, context, projectId }` attribution at dial time. */
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
 * What can be provided as a capability (the locked provide signature):
 * a bare function (live by nature — auto-wrapped with asPathCallable
 * semantics), any live stub/RpcTarget, or a serializable CapabilityAddress.
 */
export type Capability = CapabilityAddress | LiveProvider | ((...args: never[]) => unknown);

/**
 * Arbitrary metadata, stored verbatim in the journal and surfaced by
 * describe(). There is no schema — the named fields below are conventions:
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
  capability: Capability;
  instructions?: string;
  types?: string;
  meta?: CapabilityMeta;
};

/**
 * What a provide returns. `revoke()` removes the entry; `Symbol.dispose`
 * auto-revokes ONLY live provides (a durable provide's disposer is a no-op —
 * see Itx.provideCapability for why).
 */
export type ProvidedCapabilityHandle = {
  revoke(): Promise<void>;
  [Symbol.dispose](): void;
};

/** One entry of the folded capability table. `owner` is provenance: which
 * context appended the provide. */
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

/**
 * The trusted identity a delegated call carries up the chain: the context
 * the call STARTED at, as id (attribution, workspace-style scoping) AND
 * address (origin dial-back: an inherited source capability's isolate is
 * wired to the ORIGIN, so its bare fetch() climbs the origin's chain).
 * Set by delegating nodes only — handles never forward it.
 */
export type ItxOrigin = { id: string; address: CapabilityAddress };

/** The one effect injected into the core: turn an address into something
 * speaking call({ path, args }) for THIS call. `attribution` is the per-call
 * knowledge only the core has — the entry's dotted path and the originating
 * context — which the dial injects as `{ capabilityPath, context }` props
 * (the owning projectId rides in the dial's own closure). */
export type CapabilityDial = (
  address: CapabilityAddress,
  attribution: { capabilityPath: string; origin: ItxOrigin },
) => PathCallable;

/** What a stub of an Itx answers — the context protocol. Context-node DOs
 * return their core from `itx()`; the platform context (platform-context.ts)
 * answers the same protocol from code. */
export type ItxStub = {
  provideCapability(input: ProvideCapabilityInput): Promise<unknown>;
  revokeCapability(input: { name?: string; path?: string[] }): Promise<void>;
  describe(): Promise<CapabilityDescription[]>;
  invoke(input: { path: string[]; args: unknown[]; origin?: ItxOrigin }): Promise<unknown>;
};

export class CapabilityOfflineError extends Error {
  constructor(name: string) {
    super(
      `Capability "${name}" is registered but its provider is not connected. ` +
        `Live capabilities last as long as the provider's session; the provider must reconnect and provide() again.`,
    );
  }
}

/**
 * The pure fold: one journal event into the next state. Module-level so the
 * workshop and unit tests can run it without workerd, streams, or the class.
 * Defensive by design: a malformed payload keeps the current state — replay
 * must never wedge on a pre-deploy event shape.
 */
export function reduceItxJournalEvent(
  state: ItxState,
  event: { type: string; payload?: unknown },
): ItxState {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case ITX_EVENT_TYPES.contextCreated: {
      // The first birth certificate wins; later ones are inert (retried
      // appends, replays) — exactly-once as a property of the fold.
      if (state.context !== null) return state;
      if (typeof payload.id !== "string") return state;
      const context = {
        id: payload.id,
        name: typeof payload.name === "string" ? payload.name : null,
        parent: payload.parent ?? null,
      } as NonNullable<ItxState["context"]>;
      return { ...state, context };
    }
    case ITX_EVENT_TYPES.capabilityProvided: {
      const path = payload.path;
      if (!Array.isArray(path) || path.length === 0) return state;
      const kind = payload.kind;
      if (kind !== "live" && kind !== "rpc" && kind !== "url") return state;
      const name = path.join(".");
      const entry = {
        address: payload.address ?? null,
        kind,
        meta: payload.meta ?? {},
        name,
        owner: typeof payload.owner === "string" ? payload.owner : (state.context?.id ?? ""),
        updatedAtMs: typeof payload.providedAtMs === "number" ? payload.providedAtMs : 0,
      } as ItxState["capabilities"][string];
      return {
        ...state,
        capabilities: { ...state.capabilities, [name]: entry },
      };
    }
    case ITX_EVENT_TYPES.capabilityRevoked: {
      const path = payload.path;
      if (!Array.isArray(path) || path.length === 0) return state;
      const name = path.join(".");
      if (!(name in state.capabilities)) return state;
      const capabilities = { ...state.capabilities };
      delete capabilities[name];
      return { ...state, capabilities };
    }
    case ITX_EVENT_TYPES.scriptExecutionRequested: {
      if (payload.enqueued !== true || typeof payload.executionId !== "string") return state;
      return {
        ...state,
        pendingExecutions: { ...state.pendingExecutions, [payload.executionId]: true },
      };
    }
    case ITX_EVENT_TYPES.scriptExecutionCompleted: {
      if (typeof payload.executionId !== "string") return state;
      if (!(payload.executionId in state.pendingExecutions)) return state;
      const pendingExecutions = { ...state.pendingExecutions };
      delete pendingExecutions[payload.executionId];
      return { ...state, pendingExecutions };
    }
    default:
      return state;
  }
}

// ---- the class ------------------------------------------------------------------

/** The journal surface a host hands the core: its own stream's append/read. */
export type ItxJournal = {
  append(event: { type: string; payload: Record<string, unknown> }): Promise<{ offset: number }>;
  read(input: { afterOffset: number }): Promise<StreamEvent[]>;
};

export type ItxIterateContext = {
  journal: ItxJournal;
};

export type ItxDeps = {
  /** This context's identity — describe() owner label, origin id. */
  contextId: string;
  /** This context's own address — stamped as origin when delegating. */
  selfAddress: CapabilityAddress;
  /** THE only dial effect: address → something speaking call({ path, args }). */
  dial: CapabilityDial;
  /** The parent context's core, or null at the chain root. A function
   * because a generic context learns its parent from its own birth
   * certificate (state), which exists only after the journal is consumed. */
  parentItx: () => ItxStub | null;
  /** Processor-mode execution: run one enqueued script-execution-requested
   * event (the runner appends the completed event to this journal). */
  runScript?: (input: { code: string; executionId: string }) => Promise<unknown>;
};

export class Itx extends StreamProcessor<typeof ItxContract, ItxDeps, ItxIterateContext> {
  readonly contract = ItxContract;

  /** Session-bound, dup-retained live provider stubs keyed by dotted path.
   * In-memory on purpose: a connection cannot be persisted (workerd#6087
   * may change this) — replay marks live entries disconnected. */
  #liveStubs = new Map<string, LiveProvider>();
  #materialized = false;
  // eslint-disable-next-line no-unused-private-class-members -- oxlint false positive: read and assigned via ??=.
  #syncing: Promise<void> | null = null;

  /**
   * Register a capability — ONE verb for every capability kind, and ONE
   * write path: append `capability-provided` to the journal, then
   * self-ingest it (read-your-writes through the one consumption door;
   * the checkpoint's offset bookkeeping makes any later delivery of the
   * same offsets a no-op). A CapabilityAddress registers durably-shaped;
   * anything else is LIVE — the EVENT is journaled (the record outlives the
   * session) while the stub stays an instance field. A bare local FUNCTION
   * is live by nature and auto-wraps with asPathCallable semantics (empty
   * remainder calls the function; a deeper remainder errors).
   *
   * Returns the provision handle: `revoke()` removes the entry;
   * `Symbol.dispose` auto-revokes ONLY live provides — a live capability
   * dies with its session anyway, while a durable provide must outlive the
   * session that created it (session teardown disposes every returned
   * handle, so a revoking disposer would silently undo it on disconnect).
   */
  async provideCapability(input: ProvideCapabilityInput): Promise<ProvidedCapabilityHandle> {
    await this.#materialize();
    const path = capabilityPathFrom(input);
    assertValidCapabilityPath(path);
    const name = path.join(".");
    const meta: CapabilityMeta = {
      ...(input.meta ?? {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.types !== undefined ? { types: input.types } : {}),
    };

    let kind: CapabilityKind;
    if (isCapabilityAddress(input.capability)) {
      assertWellFormedCapabilityAddress(name, input.capability);
      kind = input.capability.type;
      this.#dropLiveStub(name, { record: false });
    } else {
      // A PLAIN object carrying a string `type` is a malformed address
      // (typo, unknown kind), not a live provider — fail loudly instead of
      // registering something that looks like an offline live cap.
      const type = isPlainObject(input.capability)
        ? (input.capability as { type?: unknown }).type
        : undefined;
      if (typeof type === "string") {
        throw new Error(
          `Capability "${name}": unknown target type ${JSON.stringify(type)} — ` +
            `addresses are "rpc" or "url"; anything else must be a live capability.`,
        );
      }
      kind = "live";
      const live = isLocalBareFunction(input.capability)
        ? localFunctionCapability(input.capability)
        : (input.capability as LiveProvider);
      this.#registerLiveStub(name, live);
    }

    try {
      await this.#append(ITX_EVENT_TYPES.capabilityProvided, {
        address: kind === "live" ? null : (input.capability as CapabilityAddress),
        kind,
        meta: meta as Record<string, unknown>,
        owner: this.deps.contextId,
        path,
        providedAtMs: Date.now(),
      });
    } catch (error) {
      if (kind === "live") this.#dropLiveStub(name, { record: false });
      throw error;
    }

    const revoke = async () => {
      await this.revokeCapability({ path });
    };
    return {
      revoke,
      [Symbol.dispose]: () => {
        if (kind === "live") void revoke().catch(() => {});
      },
    };
  }

  /**
   * Remove an entry (exact path match, never prefix) by appending
   * `capability-revoked`. Only this context's OWN entries can be revoked:
   * inherited entries (platform defaults, ancestors') resolve through the
   * chain, so "revoking" one here would lie — shadow it instead. Revoking a
   * shadow resurfaces whatever the chain resolves, by construction.
   */
  async revokeCapability(input: { name?: string; path?: string[] }): Promise<void> {
    await this.#materialize();
    const path = capabilityPathFrom(input);
    const name = path.join(".");
    if (!(name in this.state.capabilities)) {
      // Distinguish "never existed" (a no-op, matching the old semantics)
      // from "inherited through the chain" (refuse with the shadowing hint).
      const inherited = (await this.deps.parentItx()?.describe())?.find(
        (description) => description.name === name,
      );
      if (inherited) {
        throw new Error(
          `Capability "${name}" is not provided on this context — it is inherited from ` +
            `${inherited.owner} (e.g. a platform default) and cannot be revoked here; ` +
            `provide your own "${name}" to shadow it.`,
        );
      }
      return;
    }
    await this.#append(ITX_EVENT_TYPES.capabilityRevoked, { path });
    this.#dropLiveStub(name, { record: false });
  }

  /**
   * The merged chain view: own entries (each with its `owner` provenance),
   * then the parent chain's — the platform defaults arrive from the chain's
   * code-rooted final link like any other ancestor's. Suppression is
   * deliberately EXACT-match only: a path provide ("sdk.chat.postMessage")
   * shadows just its subtree — the parent's "sdk" stays live for every other
   * path, so hiding it here would lie about what longest-prefix dispatch
   * actually resolves.
   */
  async describe(): Promise<CapabilityDescription[]> {
    await this.#materialize();
    const own = Object.values(this.state.capabilities)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry): CapabilityDescription => {
        const meta = entry.meta as CapabilityMeta;
        return {
          connected: entry.kind === "live" ? this.#liveStubs.has(entry.name) : undefined,
          instructions: typeof meta.instructions === "string" ? meta.instructions : undefined,
          kind: entry.kind,
          meta,
          name: entry.name,
          owner: entry.owner,
          types: typeof meta.types === "string" ? meta.types : undefined,
          updatedAtMs: entry.updatedAtMs,
        };
      });
    const parent = this.deps.parentItx();
    if (!parent) return own;
    const shadowed = new Set(own.map((description) => description.name));
    const inherited = await parent.describe();
    return [...own, ...inherited.filter((description) => !shadowed.has(description.name))];
  }

  /**
   * The only dispatch in the system. `path` is the FULL call path (entry
   * path + member path); the longest provided prefix wins and is dialed with
   * the REMAINDER as the call path. A miss delegates the whole path up the
   * chain, carrying `origin` — the context the call STARTED at, as
   * {id, address} — so context-scoped dial-back (an inherited capability's
   * bare fetch()) resolves against the caller's chain. Absent origin means
   * the call originated here.
   */
  async invoke(input: { path: string[]; args: unknown[]; origin?: ItxOrigin }): Promise<unknown> {
    await this.#materialize();
    const origin = input.origin ?? { address: this.deps.selfAddress, id: this.deps.contextId };
    const resolved = resolveLongestProvidedPrefix(this.state.capabilities, input.path);
    if (!resolved) {
      const parent = this.deps.parentItx();
      if (parent) {
        return await parent.invoke({ ...input, origin });
      }
      throw new Error(
        `No capability named "${input.path[0] ?? ""}" in context ${this.deps.contextId}` +
          (input.path.length > 1 ? ` (call path "${input.path.join(".")}").` : `.`),
      );
    }
    // Every dispatch works on a BORROW disposed when the call ends — a
    // .dup() of the live stub (the stored one stays callable for the next
    // caller), or whatever the dial minted for this call.
    const { entry, remainder } = resolved;
    const borrowed = this.#borrow(entry, origin);
    try {
      return await borrowed.call({ args: input.args, path: remainder });
    } catch (error) {
      // Log at the supervisor: errors crossing RPC back to the caller can be
      // masked as "internal error; reference = …", so the only place the
      // real failure is visible is here.
      console.error(
        `[itx] cap "${entry.name}" (${entry.kind}) failed in ${this.deps.contextId} ` +
          `at path ${remainder.join(".") || "<call>"}:`,
        error,
      );
      throw error;
    } finally {
      disposeIfPossible(borrowed);
    }
  }

  /** The birth certificate, as folded from the journal (null for contexts
   * born in code, like the project context). Hosts derive descriptor()
   * and parentage from this — there is no other record. */
  async contextRecord(): Promise<ItxState["context"]> {
    await this.#materialize();
    return this.state.context;
  }

  // ---- processor hooks ------------------------------------------------------

  protected override reduce(args: Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]) {
    return reduceItxJournalEvent(args.state, args.event);
  }

  /**
   * Processor-mode execution: an `enqueued: true` script-execution-requested
   * event IS a request for work — run it through the host's runner (which
   * appends the completed event back onto this journal). Batch-level so the
   * dedupe can consult the BATCH-FINAL state: a requested event whose
   * completed is already in the same batch (or in history) is a replay, not
   * an obligation. Runs detached (`runInBackground`): the script's own
   * provides re-enter this processor's serialized ingest, so blocking the
   * batch on it would deadlock.
   */
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<typeof ItxContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const run = this.deps.runScript;
    if (!run) return;
    for (const { event } of args.reducedEvents) {
      if (event.offset <= args.sideEffectsAfterOffset) continue;
      if (event.type !== ITX_EVENT_TYPES.scriptExecutionRequested) continue;
      const payload = event.payload as {
        code?: unknown;
        enqueued?: unknown;
        executionId: string;
      };
      if (payload.enqueued !== true || typeof payload.code !== "string") continue;
      if (args.state.pendingExecutions[payload.executionId] !== true) continue;
      const code = payload.code;
      const executionId = payload.executionId;
      args.runInBackground(() => run({ code, executionId }));
    }
  }

  // ---- the write/consume seam -------------------------------------------------

  /** Append one journal event, then catch up THROUGH the one consumption
   * door — never reduce directly. Reading from the checkpoint (instead of
   * ingesting just the appended event) keeps consumption contiguous when
   * concurrent writers interleave offsets. */
  async #append(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.ctx.journal.append({ payload, type });
    await this.#catchUp();
  }

  /** Lazy materialization: the context comes alive by consuming its journal.
   * Once per instance — afterwards self-appends keep the fold current, and
   * events written by OTHER writers (the /api/itx/run record door) are
   * picked up by the next append's catch-up or the next wake. */
  async #materialize(): Promise<void> {
    if (this.#materialized) return;
    await this.#catchUp();
    this.#materialized = true;
  }

  async #catchUp(): Promise<void> {
    // Single-flight; ingest's own offset bookkeeping makes overlap benign.
    this.#syncing ??= (async () => {
      try {
        const { offset } = await this.snapshot();
        const events = await this.ctx.journal.read({ afterOffset: offset });
        if (events.length > 0) {
          await this.ingest({ events, streamMaxOffset: events.at(-1)!.offset });
        }
      } finally {
        this.#syncing = null;
      }
    })();
    await this.#syncing;
  }

  // ---- live stubs ----------------------------------------------------------------

  #registerLiveStub(name: string, provider: LiveProvider): void {
    // RPC disposes argument stubs when the call returns; keep a duplicate
    // (and hand further dups to borrowers) — both directions of the dup()
    // discipline from the original capnweb learnings.
    const retained = provider.dup ? provider.dup() : provider;
    this.#dropLiveStub(name, { record: false });
    this.#liveStubs.set(name, retained);
    // Best-effort teardown registration: capnweb stubs implement onRpcBroken
    // locally, but Workers-RPC stubs proxy EVERY property as a remote method,
    // so on a provider that doesn't implement it the call rejects with "does
    // not implement" instead of reading undefined — swallow that; the
    // connection still dies with the session either way.
    const teardown = () => {
      if (this.#liveStubs.get(name) === retained) this.#dropLiveStub(name, { record: true });
    };
    void Promise.resolve(retained.onRpcBroken?.(teardown) as unknown).catch(() => {});
  }

  /** Drop a live stub. `record: true` (session teardown) appends the
   * capability-disconnected event — the entry survives as "offline"; a
   * replace/revoke drops silently because its own event IS the record. */
  #dropLiveStub(name: string, opts: { record: boolean }): void {
    const stub = this.#liveStubs.get(name);
    if (!stub) return;
    this.#liveStubs.delete(name);
    if (opts.record) {
      void this.ctx.journal
        .append({
          payload: { path: name.split(".") },
          type: ITX_EVENT_TYPES.capabilityDisconnected,
        })
        .catch((error) => {
          console.error(`[itx] capability-disconnected append failed for "${name}":`, error);
        });
    }
    stub[Symbol.dispose]?.();
  }

  /** The two-case shape: a capability is either held up by a live connection
   * (borrow a dup), or its address is dialed at invoke time. */
  #borrow(entry: ItxState["capabilities"][string], origin: ItxOrigin): PathCallable {
    if (entry.kind === "live") {
      const stub = this.#liveStubs.get(entry.name);
      if (!stub) throw new CapabilityOfflineError(entry.name);
      return (stub.dup ? stub.dup() : stub) as unknown as PathCallable;
    }
    return this.deps.dial(entry.address! as CapabilityAddress, {
      capabilityPath: entry.name,
      origin,
    });
  }
}

// ---- resolution + validation --------------------------------------------------

/**
 * Longest-prefix resolution: among the provided entries — keyed by
 * dot-joined path — the longest one prefixing the call path wins; the
 * REMAINDER becomes the dispatched call path. One exact lookup per candidate
 * depth, longest first, so resolution stays deterministic and never
 * traverses targets.
 */
export function resolveLongestProvidedPrefix<Entry>(
  capabilities: Record<string, Entry>,
  path: string[],
): { entry: Entry; remainder: string[] } | null {
  for (let depth = path.length; depth >= 1; depth--) {
    const entry = capabilities[path.slice(0, depth).join(".")];
    if (entry !== undefined) return { entry, remainder: path.slice(depth) };
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
  "extend",
  "invoke",
  "parent",
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
 * Definitions live at PATHS: a name is a 1-segment path. Every segment must
 * be a flat JS identifier so `itx.<a>.<b>` works via the fallthrough proxy
 * and the dot-joined form stays unambiguous as the map key. The two reserved
 * sets split by position: the FIRST segment must not shadow the trust
 * kernel; deeper segments only need the protocol-level path filter — the
 * built-in names are perfectly good method names there.
 */
export function assertValidCapabilityPath(path: string[]): void {
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
export function capabilityPathFrom(input: { name?: string; path?: string[] }): string[] {
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
 * capability. The plainness check MUST come before any `.type` probe:
 * property access on a capnweb stub returns a truthy pipelined stub, so
 * reading `.type` first would misclassify every live capability.
 */
export function isCapabilityAddress(capability: Capability): capability is CapabilityAddress {
  if (!isPlainObject(capability)) return false;
  const type = (capability as { type?: unknown }).type;
  return type === "rpc" || type === "url";
}

const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async () => {}) as object;

/**
 * A bare LOCAL function (same isolate): prototype Function.prototype or
 * AsyncFunction.prototype. RPC stubs never match — a capnweb stub's
 * prototype is RpcStub.prototype and a Workers-RPC stub's is its own class —
 * so remote functions are wrapped at the boundary that received them (the
 * handle), never here.
 */
export function isLocalBareFunction(
  capability: Capability,
): capability is (...args: never[]) => unknown {
  if (typeof capability !== "function") return false;
  const proto = Object.getPrototypeOf(capability) as object | null;
  return proto === Function.prototype || proto === ASYNC_FUNCTION_PROTOTYPE;
}

/** Wrap a bare local function so it speaks the one calling convention:
 * empty remainder calls the function, a deeper remainder errors (the
 * asPathCallable semantics, replayed in-process). */
function localFunctionCapability(fn: (...args: never[]) => unknown): LiveProvider {
  return { call: (input: PathCall) => replayPathCall(fn, input) } as LiveProvider;
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

/** Dispose a borrowed RPC stub if it is disposable (in-process targets aren't). */
function disposeIfPossible(target: unknown): void {
  const dispose = (target as Partial<Disposable> | null)?.[Symbol.dispose];
  if (typeof dispose === "function") Reflect.apply(dispose, target, []);
}
