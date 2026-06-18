// The itx CORE: an Itx holds capabilities; everything else holds a stub of
// one (itx-next.md, "The address unification" — the LOCKED final shape).
//
// ONE class: `Itx extends StreamProcessor`. The context's STREAM is the only
// authority — provides and revokes APPEND events and self-ingest them;
// `reduce` folds the stream into the capability table; the checkpoint is a
// disposable cache of that fold. The record and the state cannot disagree,
// because events are the only writes
// (docs/domain-objects-and-stream-processors.md).
//
// The pure pieces stay module-level so they are provable without workerd or
// streams: `reduceItxEvent` (the fold), `resolveLongestProvidedPrefix`
// (dispatch), path validation, and the live-vs-address discriminator.
//
// Everything effectful is injected: `dial` turns a CapabilityAddress into
// something speaking `call({ path, args })` (dial.ts builds it; the core
// never touches env or a project id), `parentItx` is a stub of the parent
// context's core (chain delegation — the defaults are simply the chain's
// code-rooted final link, platform-context.ts), and the stream's
// append/read pair rides in as the processor's iterate context.
//
// ONE host: ItxDurableObject (the generic context host) exposes the core via
// an `itx()` method — a method, not a property, because workerd does not
// pipeline calls through property accesses, so the method form keeps
// `node.itx().invoke(…)` a single pipelined round trip.

import { ItxContract, ITX_EVENT_TYPES, type ItxState } from "./contract.ts";
import {
  replayPathCall,
  RESERVED_PATH_SEGMENTS,
  SELF_DESCRIPTION_METHOD,
  type PathCall,
  type PathCallable,
} from "./path-proxy.ts";
import {
  DEFAULTS_DESCRIBE_FROM,
  type CapabilityAddress,
  type CapabilityDescription,
  type CapabilityKind,
  type CapabilityMeta,
  type CapabilityTarget,
  type ItxOrigin,
  type WorkerRef,
  type WorkerSource,
} from "./types.ts";
import {
  StreamProcessor,
  type StreamProcessorDeps,
} from "~/domains/streams/engine/stream-processor.ts";

// Server-side one-stop: the calling-convention pieces live in path-proxy.ts
// only because Node/browser providers import them at runtime, and the data
// model lives in types.ts (the import-free design of record). Server code
// imports all of it from here.
export {
  replayPathCall,
  RESERVED_PATH_SEGMENTS,
  SELF_DESCRIPTION_METHOD,
  type PathCall,
  type PathCallable,
} from "./path-proxy.ts";
export { ItxContract, ITX_EVENT_TYPES, type ItxState } from "./contract.ts";
export { DEFAULTS_DESCRIBE_FROM } from "./types.ts";
export type {
  CapabilityAddress,
  CapabilityDescription,
  CapabilityKind,
  CapabilityMeta,
  CapabilityProvision,
  CapabilityTarget,
  ItxOrigin,
  WorkerRef,
  WorkerSource,
} from "./types.ts";

// ---- the capability data model (shapes: types.ts) -----------------------------

/**
 * A live provider's stub as the core sees it. Structural because the stub
 * may arrive over Cap'n Web (browser/Node provider) or Workers RPC and we
 * only rely on the protocol-level controls. (The design-of-record spelling
 * is types.ts's opaque `LiveStub`; this is the core's working view of one.)
 */
export type LiveProvider = {
  dup?: () => LiveProvider;
  onRpcBroken?: (callback: (error: unknown) => void) => void;
  [Symbol.dispose]?: () => void;
} & Record<string, unknown>;

/** provideCapability's input — `instructions`/`types` are sugar for the meta
 * convention fields of the same names (the explicit meta spelling wins). */
export type ProvideCapabilityInput = {
  name?: string;
  path?: string[];
  capability: CapabilityTarget;
  instructions?: string;
  types?: string;
  meta?: CapabilityMeta;
};

/** One entry of the folded capability table. `owner` is provenance: which
 * context appended the provide. */
export type ProvidedCapability = {
  name: string;
  kind: CapabilityKind;
  /** null iff kind is "live" — the stub lives in the live-stub table instead. */
  address: CapabilityAddress | null;
  owner: string;
  meta: CapabilityMeta;
  updatedAtMs: number;
};

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
  provideCapability(input: ProvideCapabilityInput): Promise<void>;
  revokeCapability(input: { name?: string; path?: string[] }): Promise<void>;
  describe(): Promise<CapabilityDescription[]>;
  invoke(input: { path: string[]; args: unknown[]; origin?: ItxOrigin }): Promise<unknown>;
};

export class CapabilityOfflineError extends Error {
  constructor(name: string) {
    super(
      `Capability "${name}" is registered but its provider is not connected. ` +
        `Live capabilities last as long as the provider's session; the provider must ` +
        `reconnect and call provideCapability() again.`,
    );
  }
}

/**
 * The pure fold: one stream event into the next state. Module-level so the
 * workshop and unit tests can run it without workerd, streams, or the class.
 * Defensive by design: a malformed payload keeps the current state — replay
 * must never wedge on a pre-deploy event shape.
 */
export function reduceItxEvent(
  state: ItxState,
  event: { type: string; payload?: unknown },
): ItxState {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case ITX_EVENT_TYPES.contextCreated: {
      // The first birth certificate wins; later ones are inert (retried
      // appends, re-creates) — exactly-once as a property of the fold, which
      // is what makes creation get-or-create.
      if (state.context !== null) return state;
      const context = {
        name: typeof payload.name === "string" ? payload.name : null,
        parent: payload.parent ?? null,
      } as NonNullable<ItxState["context"]>;
      return { ...state, context };
    }
    case ITX_EVENT_TYPES.capabilityProvided: {
      const path = payload.path;
      if (!Array.isArray(path) || path.length === 0) return state;
      const kind = payload.kind;
      if (kind !== "live" && kind !== "rpc") return state;
      const name = path.join(".");
      const entry = {
        address: payload.address ?? null,
        kind,
        meta: payload.meta ?? {},
        name,
        owner: typeof payload.owner === "string" ? payload.owner : "",
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

export type ItxDeps = StreamProcessorDeps<
  typeof ItxContract,
  {
    /** This context's identity — its coordinate ref (`<projectId>:<path>`),
     * stamped as the owner of provides and as origin when delegating. */
    contextRef: string;
    /** This context's own address — stamped as origin when delegating. */
    selfAddress: CapabilityAddress;
    /** THE only dial effect: address → something speaking call({ path, args }). */
    dial: CapabilityDial;
    /** The parent context's link, or null at the chain root. A function
     * because a generic context learns its parent from its own birth
     * certificate (state), which exists only after the stream is consumed.
     * `from` is how describe() labels entries inherited through this link —
     * the parent's context id, or "defaults" at the code root (the internal
     * platform:project id never leaves the chain). */
    parentItx: () => { from: string; stub: ItxStub } | null;
    /** Processor-mode execution: run one enqueued script-execution-requested
     * event (the runner appends the completed event to this context's stream). */
    runScript?: (input: { code: string; executionId: string }) => Promise<unknown>;
  }
>;

export class Itx extends StreamProcessor<typeof ItxContract, ItxDeps> {
  readonly contract = ItxContract;

  /** Session-bound, dup-retained live provider stubs keyed by dotted path.
   * In-memory on purpose: a connection cannot be persisted (workerd#6087
   * may change this) — replay marks live entries disconnected. */
  #liveStubs = new Map<string, LiveProvider>();
  /** Releases everything a live registration dup-retained (the provider's
   * own dup, or every member dup of a plain-object provider). */
  #liveStubReleases = new Map<string, () => void>();
  #materialized = false;
  /** Monotonic append counter; #catchUp compares it against the counter a
   * sync STARTED at to guarantee read-your-writes. */
  #appendCount = 0;
  // eslint-disable-next-line no-unused-private-class-members -- oxlint false positive: read and assigned via ??=.
  #syncing: { done: Promise<void>; startedAtAppendCount: number } | null = null;

  /**
   * Register a capability — ONE verb for every capability kind, and ONE
   * write path: append `capability-provided` to the context's stream, then
   * self-ingest it (read-your-writes through the one consumption door;
   * the checkpoint's offset bookkeeping makes any later delivery of the
   * same offsets a no-op). A CapabilityAddress registers durably-shaped;
   * anything else is LIVE — the EVENT is appended (the record outlives the
   * session) while the stub stays an instance field. A live target needs no
   * wrapper: a plain object (or bare function) IS the capability — dispatch
   * replays paths onto its members; a target that implements `call({ path,
   * args })` itself owns its whole method-tree semantics instead (#borrow).
   *
   * Returns nothing: the HANDLE (handle.ts) builds the CapabilityProvision
   * its callers hold — the core's provide is just the appended write.
   */
  async provideCapability(input: ProvideCapabilityInput): Promise<void> {
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
            `addresses are "rpc"; anything else must be a live capability.`,
        );
      }
      kind = "live";
      const live = isLocalBareFunction(input.capability)
        ? localFunctionCapability(input.capability, name)
        : (input.capability as LiveProvider);
      this.#registerLiveStub(name, live);
    }

    // provide is a PURE STREAM APPEND — it never calls into provider code.
    // (An earlier provide-time `describeItx` probe dialed the target to
    // auto-fill `types`; it was removed after it broke agents in prod: an
    // agent re-providing its tool caps re-entered its own Durable Object
    // mid-wake through the probe. Self-description stays caller-supplied:
    // pass `instructions`/`types` at provide time. `describeItx` remains a
    // reserved protocol name.)
    try {
      await this.#append(ITX_EVENT_TYPES.capabilityProvided, {
        address: kind === "live" ? null : (input.capability as CapabilityAddress),
        kind,
        meta: meta as Record<string, unknown>,
        owner: this.deps.contextRef,
        path,
        providedAtMs: Date.now(),
      });
    } catch (error) {
      if (kind === "live") this.#dropLiveStub(name, { record: false });
      throw error;
    }
  }

  /**
   * Remove an entry (exact path match, never prefix) by appending
   * `capability-revoked`. Only this context's OWN entries can be revoked:
   * inherited entries (the defaults, ancestors') resolve through the
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
      const parent = this.deps.parentItx();
      const inherited = (await parent?.stub.describe())?.find(
        (description) => description.name === name,
      );
      if (inherited) {
        const from = inherited.from ?? parent!.from;
        throw new Error(
          `Capability "${name}" is not provided on this context — it is inherited from ` +
            `${from === DEFAULTS_DESCRIBE_FROM ? "the defaults" : `context ${from}`} and cannot ` +
            `be revoked here; provide your own "${name}" on this context to take its place; ` +
            `the original stays on the parent.`,
        );
      }
      return;
    }
    await this.#append(ITX_EVENT_TYPES.capabilityRevoked, { path });
    this.#dropLiveStub(name, { record: false });
  }

  /**
   * The merged chain view: own entries first (no provenance field — they are
   * yours), then the parent chain's, each carrying `from` (the context the
   * entry actually lives on; the defaults read `from: "defaults"`).
   * Suppression is deliberately EXACT-match only: a path provide
   * ("sdk.chat.postMessage") shadows just its subtree — the parent's "sdk"
   * stays live for every other path, so hiding it here would lie about what
   * longest-prefix dispatch actually resolves.
   */
  async describe(): Promise<CapabilityDescription[]> {
    await this.#materialize();
    const own = Object.values(this.state.capabilities)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry): CapabilityDescription => {
        // `instructions`/`types` are LIFTED to the entry's top level and
        // removed from the projected meta — one place to read each fact.
        // (The stream keeps the full meta verbatim; this is projection.)
        const { instructions, types, ...meta } = entry.meta as CapabilityMeta;
        return {
          connected: entry.kind === "live" ? this.#liveStubs.has(entry.name) : undefined,
          instructions: typeof instructions === "string" ? instructions : undefined,
          kind: entry.kind,
          meta,
          name: entry.name,
          types: typeof types === "string" ? types : undefined,
          updatedAtMs: entry.updatedAtMs,
        };
      });
    const parent = this.deps.parentItx();
    if (!parent) return own;
    const shadowed = new Set(own.map((description) => description.name));
    const inherited = await parent.stub.describe();
    return [
      ...own,
      ...inherited
        .filter((description) => !shadowed.has(description.name))
        // Stamp `from` exactly one level below the owner: the parent's OWN
        // entries arrive unstamped (own entries carry no provenance) and get
        // this link's label; deeper ancestors' already carry theirs.
        .map((description) =>
          description.from === undefined ? { ...description, from: parent.from } : description,
        ),
    ];
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
    const origin = input.origin ?? { address: this.deps.selfAddress, ref: this.deps.contextRef };
    const resolved = resolveLongestProvidedPrefix(this.state.capabilities, input.path);
    if (!resolved) {
      const parent = this.deps.parentItx();
      if (parent) {
        return await parent.stub.invoke({ ...input, origin });
      }
      throw new Error(
        `No capability named "${input.path[0] ?? ""}" in context ${this.deps.contextRef}` +
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
        `[itx] cap "${entry.name}" (${entry.kind}) failed in ${this.deps.contextRef} ` +
          `at path ${remainder.join(".") || "<call>"}:`,
        error,
      );
      throw error;
    } finally {
      disposeIfPossible(borrowed);
    }
  }

  /** The birth certificate, as folded from the stream (null for contexts
   * born in code, like the project context). Hosts derive descriptor()
   * and parentage from this — there is no other record. */
  async contextRecord(): Promise<ItxState["context"]> {
    await this.#materialize();
    return this.state.context;
  }

  // ---- processor hooks ------------------------------------------------------

  protected override reduce(args: Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]) {
    return reduceItxEvent(args.state, args.event);
  }

  /**
   * Processor-mode execution: an `enqueued: true` script-execution-requested
   * event IS a request for work — run it through the host's runner (which
   * appends the completed event back onto this stream). Batch-level so the
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

  /** Append one event to the context's stream, then catch up THROUGH the one
   * door — never reduce directly. Reading from the checkpoint (instead of
   * ingesting just the appended event) keeps consumption contiguous when
   * concurrent writers interleave offsets. */
  async #append(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.stream.append({ event: { payload, type } });
    this.#appendCount += 1;
    await this.#catchUp();
  }

  /** Lazy materialization: the context comes alive by consuming its stream.
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
    // The invariant: the record and the state cannot disagree — a provide
    // must observe its own event. A joined in-flight sync may have started
    // BEFORE this caller's append landed, so loop until a sync that started
    // at (or after) the current append count has completed.
    while (true) {
      const sync = (this.#syncing ??= this.#startSync());
      await sync.done;
      if (sync.startedAtAppendCount >= this.#appendCount) return;
    }
  }

  #startSync(): { done: Promise<void>; startedAtAppendCount: number } {
    const startedAtAppendCount = this.#appendCount;
    const done = (async () => {
      try {
        const { offset } = await this.snapshot();
        const events = await this.deps.stream.getEvents({ afterOffset: offset });
        if (events.length > 0) {
          await this.ingest({ events, streamMaxOffset: events.at(-1)!.offset });
        }
      } finally {
        this.#syncing = null;
      }
    })();
    return { done, startedAtAppendCount };
  }

  // ---- live stubs ----------------------------------------------------------------

  #registerLiveStub(name: string, provider: LiveProvider): void {
    // RPC disposes argument stubs when the call returns; keep a duplicate
    // (and hand further dups to borrowers) — both directions of the dup()
    // discipline from the original capnweb learnings. A PLAIN-object provider
    // crosses RPC by value with its function members as stubs, so retention
    // walks it and dups every member (retainLiveProvider).
    const { onRpcBroken, release, retained } = retainLiveProvider(provider);
    this.#dropLiveStub(name, { record: false });
    this.#liveStubs.set(name, retained);
    this.#liveStubReleases.set(name, release);
    // Best-effort teardown registration: capnweb stubs implement onRpcBroken
    // locally, but Workers-RPC stubs proxy EVERY property as a remote method,
    // so on a provider that doesn't implement it the call rejects with "does
    // not implement" instead of reading undefined — swallow that; the
    // connection still dies with the session either way.
    const teardown = () => {
      if (this.#liveStubs.get(name) === retained) this.#dropLiveStub(name, { record: true });
    };
    void Promise.resolve(onRpcBroken?.(teardown) as unknown).catch(() => {});
  }

  /** Drop a live stub. `record: true` (session teardown) appends the
   * capability-disconnected event — the entry survives as "offline"; a
   * replace/revoke drops silently because its own event IS the record. */
  #dropLiveStub(name: string, opts: { record: boolean }): void {
    const stub = this.#liveStubs.get(name);
    if (!stub) return;
    this.#liveStubs.delete(name);
    const release = this.#liveStubReleases.get(name);
    this.#liveStubReleases.delete(name);
    if (opts.record) {
      void this.deps.stream
        .append({
          event: {
            payload: { path: name.split(".") },
            type: ITX_EVENT_TYPES.capabilityDisconnected,
          },
        })
        .catch((error) => {
          console.error(`[itx] capability-disconnected append failed for "${name}":`, error);
        });
    }
    release?.();
  }

  /** The two-case shape: a capability is either held up by a live connection
   * (borrow a dup), or its address is dialed at invoke time. */
  #borrow(entry: ItxState["capabilities"][string], origin: ItxOrigin): PathCallable {
    if (entry.kind === "live") {
      const stub = this.#liveStubs.get(entry.name);
      if (!stub) throw new CapabilityOfflineError(entry.name);
      const borrowed = (stub.dup ? stub.dup() : stub) as LiveProvider;
      // Dispatch decides the live target's mode right here, by a free local
      // property probe (never a round trip). A target implementing `call`
      // owns its whole method-tree semantics (the SDK shape: one method
      // receives { path, args } as data); anything else IS its member tree —
      // replay the remaining path onto it. Plain objects always take the
      // member branch: they cross sessions by value (the probe sees their
      // real, absent `call`), and their retained member stubs are what the
      // replay calls. Function-shaped targets always probe call-speaking —
      // bare functions wrap at provide (localFunctionCapability / the
      // handle's wrapper, live-target.ts), and a session-crossed stub
      // materializes a callable proxy for any member name, `call` included.
      if (typeof borrowed.call === "function") return borrowed as unknown as PathCallable;
      return {
        call: (input: PathCall) => replayPathCall(borrowed, input, { capability: entry.name }),
        [Symbol.dispose]: () => disposeIfPossible(borrowed),
      } as PathCallable;
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
 * handle's built-ins). `fetch` and `streams` are deliberately NOT here:
 * both are shadowable default capabilities (providing your own
 * `fetch` is how egress interception works) — the handle's real members
 * still win property lookup; they route through the core anyway.
 */
const ITX_BUILTIN_NAMES = [
  "capability",
  "describe",
  "extend",
  "invoke",
  "project",
  "projects",
  "provideCapability",
  "revokeCapability",
  "super",
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
 * whose prototype is Object.prototype (or null) carrying `type: "rpc"`.
 * Everything else — capnweb RpcStubs (callable function-proxies),
 * workers-RPC stubs, RpcTarget instances, plain functions — is a LIVE
 * capability. The plainness check MUST come before any `.type` probe:
 * property access on a capnweb stub returns a truthy pipelined stub, so
 * reading `.type` first would misclassify every live capability.
 */
export function isCapabilityAddress(capability: CapabilityTarget): capability is CapabilityAddress {
  if (!isPlainObject(capability)) return false;
  const type = (capability as { type?: unknown }).type;
  return type === "rpc";
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
  capability: CapabilityTarget,
): capability is (...args: never[]) => unknown {
  if (typeof capability !== "function") return false;
  const proto = Object.getPrototypeOf(capability) as object | null;
  return proto === Function.prototype || proto === ASYNC_FUNCTION_PROTOTYPE;
}

/** Wrap a bare local function so it speaks the one calling convention:
 * empty remainder calls the function, a deeper remainder errors (replayed
 * in-process). The wrap exists because a bare function would otherwise look
 * call-speaking to dispatch — `fn.call` IS a function (Function.prototype). */
function localFunctionCapability(fn: (...args: never[]) => unknown, name: string): LiveProvider {
  return {
    call: (input: PathCall) => replayPathCall(fn, input, { capability: name }),
  } as LiveProvider;
}

function isPlainObject(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const proto = Object.getPrototypeOf(target);
  return proto === Object.prototype || proto === null;
}

/**
 * Retention for a live provider, beyond the provide call that delivered it:
 * RPC disposes argument stubs when the call returns, so anything stored must
 * be a dup. Three shapes:
 *
 * - a stub with `.dup` (RpcTarget/function providers) retains via one dup;
 * - a PLAIN object crosses RPC by value with its function members as session
 *   stubs — retention deep-walks it and dups every stub-valued member (the
 *   members are the things that die at call end, not the carrier object);
 * - anything else (a local object) needs no retention.
 *
 * `release` disposes exactly what was dup'd here (#dropLiveStub calls it);
 * `onRpcBroken` is the best teardown hook the shape offers — the provider's
 * own, or any member stub's (members share the provider's session).
 */
function retainLiveProvider(provider: LiveProvider): {
  retained: LiveProvider;
  release: () => void;
  onRpcBroken?: (callback: (error: unknown) => void) => void;
} {
  if (typeof provider.dup === "function") {
    const retained = provider.dup();
    return {
      onRpcBroken: (callback) => retained.onRpcBroken?.(callback),
      release: () => disposeIfPossible(retained),
      retained,
    };
  }
  if (!isPlainObject(provider)) {
    return {
      onRpcBroken: (callback) => provider.onRpcBroken?.(callback),
      release: () => disposeIfPossible(provider),
      retained: provider,
    };
  }
  const memberDups: LiveProvider[] = [];
  const walk = (node: Record<string, unknown>): Record<string, unknown> => {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const dup = (value as { dup?: () => LiveProvider } | null)?.dup;
      if (value !== null && typeof dup === "function") {
        // Any member exposing dup() is a session stub — a function OR an
        // object-shaped stub (e.g. a nested RpcTarget). Both die with the
        // provide RPC unless retained here.
        const duped = Reflect.apply(dup, value, []) as LiveProvider;
        memberDups.push(duped);
        copy[key] = duped;
      } else if (isPlainObject(value)) {
        copy[key] = walk(value as Record<string, unknown>);
      } else {
        copy[key] = value;
      }
    }
    return copy;
  };
  const retained = walk(provider as Record<string, unknown>) as LiveProvider;
  return {
    onRpcBroken: memberDups[0] ? (callback) => memberDups[0]!.onRpcBroken?.(callback) : undefined,
    release: () => memberDups.forEach((duped) => disposeIfPossible(duped)),
    retained,
  };
}

/**
 * STRUCTURAL address validation only — required fields and field exclusions.
 * Reachability (the dialable allowlists) is deliberately NOT checked here:
 * it is the dial's authority and surfaces at first invoke, so a deployment
 * widening its allowlists never strands rows provided before the widening.
 */
function assertWellFormedCapabilityAddress(name: string, address: CapabilityAddress): void {
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
      if (worker.source.type === "inline") {
        if (!worker.source.cacheKey) {
          throw new Error(
            `Capability "${name}": inline sources need a cacheKey ` +
              `(rotate it whenever modules change; a content hash is ideal).`,
          );
        }
      } else if (worker.source.type === "repo") {
        if (!worker.source.repoPath || !worker.source.path) {
          throw new Error(`Capability "${name}": repo sources need a repo path and a file path.`);
        }
      } else {
        throw new Error(
          `Capability "${name}": source.type must be "inline" or "repo" ` +
            `(got ${JSON.stringify((worker.source as { type?: unknown }).type ?? null)}).`,
        );
      }
      return;
    case "durable-object":
      if (!worker.name) {
        throw new Error(`Capability "${name}": durable-object refs need a non-empty name.`);
      }
      return;
  }
}

/** Dispose a borrowed RPC stub if it is disposable (in-process targets aren't). */
export function disposeIfPossible(target: unknown): void {
  const dispose = (target as Partial<Disposable> | null)?.[Symbol.dispose];
  if (typeof dispose === "function") Reflect.apply(dispose, target, []);
}
