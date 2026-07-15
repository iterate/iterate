import { RpcTarget } from "capnweb";
import type { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { ProcessorRuntimeState, ProcessorSnapshot } from "./rpc-types.ts";
// Type-only by necessity, not just hygiene: the runner imports this module's
// VALUE (the class, for `runnerDriver`), so a value import back would be a
// runtime cycle. Types erase; the cycle doesn't exist at runtime.
import type { DeliveryContext } from "./stream-processor-runner.ts";
import { SubscriberMetrics } from "./subscriber-metrics.ts";
import {
  assertObjectProcessorState,
  cachedEventSchema,
  getConsumedEventDefinition,
  getEventInputSchema,
  getResolvedEventDefinition,
  type ConsumedEvent,
  type EmittedInput,
  type EventCatalog,
  type ProcessorState,
} from "./processor-contracts.ts";

// =============================================================================
// Class-based stream processor runtime.
// =============================================================================

export type MaybePromise<T> = T | Promise<T>;

/**
 * The structural slice of a processor contract that the class needs. Contracts
 * built with `defineProcessorContract(...)` satisfy this; the full contract
 * type flows through the `Contract` type parameter so event/state inference
 * reaches the hooks.
 */
export type StreamProcessorContract = {
  slug: string;
  version: string;
  stateSchema: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  emits: readonly string[];
  parseEvent(event: StreamEvent): StreamEvent;
};

/**
 * Constructor dependencies shared by every processor: the stream append
 * capability and the home stream's identity (`path` / `projectId`, stamped as
 * provenance onto every emitted event), plus an optional `keepAliveWhile`
 * hook for processors whose own out-of-band work (a DO verb like the
 * scheduler's `triggerDue`) must keep the runtime alive while it runs.
 * Delivery, cursors, and checkpoints are NOT deps: the StreamProcessorRunner
 * (stream-processor-runner.ts) owns all of that and drives the processor from
 * outside.
 */
export type StreamProcessorBaseDeps = {
  stream: Stream;
  /** Path of the stream this processor runs on (the stream `stream` points at). */
  path: string;
  /** Owning project, or null on a global (deployment-root) stream. */
  projectId: string | null;
  keepAliveWhile?: (work: () => Promise<unknown>) => void;
};

// These arg shapes are intentionally not exported: subclass overrides annotate
// their args as `Parameters<StreamProcessor<Contract>["method"]>[0]` so there
// is exactly one spelling.
//
// State and events are passed by reference. Hooks must treat them as immutable:
// `reduce` returns a new state object instead of mutating its input.
type ReducedEvent<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

/**
 * A consumed-type event whose shape failed the contract parse. Distinguished
 * from `undefined` (type not consumed at all) so the runner can skip the event
 * AND record the skip durably instead of silently dropping it.
 */
type ConsumedEventParseFailure = { parseError: z.ZodError };

/** What `reduce` receives: one consumed event and the state to fold it into. */
type ReduceArgs<Contract> = {
  event: ConsumedEvent<Contract>;
  state: ProcessorState<Contract>;
};

/**
 * Side-effect scheduling helpers handed to the `process*` hooks. Two
 * primitives, two guarantees — every side effect must pick one deliberately:
 *
 * - `blockProcessorWhile` — SHORT work the next event must not overtake.
 *   At-least-once: the cursor is held, a crash redelivers the frame, and
 *   append idempotency keys collapse the re-run. Long work does NOT belong
 *   here: it head-of-line-blocks every later event (including cancellations).
 *
 * - `runInBackground` — a DROPPABLE ATTEMPT. The cursor advances
 *   immediately; an eviction loses the closure silently. Every callsite must
 *   answer "what recovers the OUTCOME if this attempt drops?" — legitimate
 *   answers are "an at-head reconciliation (`onCaughtUp`), via journaled
 *   requested/completed evidence" (LLM calls, scripts, debounce timers) or
 *   "nothing, the outcome genuinely doesn't matter" (telemetry). A naked
 *   runInBackground around consequential work with no reconciler is the bug
 *   class the 2026-06-10 / 2026-07-07 incidents came from.
 *
 * Both are keepalive-backed: while either kind of work is in flight the
 * runner's recovery adapter parks a durable alarm ahead of it, so an
 * incarnation that dies owing work is revived and the reconcilers get their
 * at-head pass (docs/writing-stream-processors.md has the full doctrine).
 */
type SideEffectHelpers = {
  /** Hold the cursor (and the next event) until this work completes. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** A droppable attempt; failures are caught and logged, evictions lose it. */
  runInBackground: (work: () => Promise<unknown>) => void;
};

/** What `processEvent` receives: one reduction result plus delivery context and helpers. */
type ProcessEventArgs<Contract> = ReducedEvent<Contract> &
  SideEffectHelpers & {
    /**
     * Append one or more events listed in `contract.emits` to this stream,
     * stamped with `source.processor` provenance pointing at THIS event as
     * `whileProcessing`. The binding is a closure, so appends made later from
     * `blockProcessorWhile`/`runInBackground` work scheduled here still stamp
     * the event that was being processed.
     */
    append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    /** Like `append`, onto a sibling stream (resolved via `stream.at(path)`). */
    appendTo: (path: string, ...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    streamMaxOffset: number;
    /**
     * The offset the delivering frame will acknowledge through once all
     * blocking work completes — the last event offset in the frame, not this
     * event's offset.
     */
    checkpointOffset: number;
    /**
     * Honest event-time context (delivery phase, lag behind the observed
     * head, cursor revision, deterministic effect keys) supplied by the
     * StreamProcessorRunner, the only driver.
     */
    delivery: DeliveryContext;
  };

/**
 * What `onCaughtUp` receives: the final fold at the runner's observed head,
 * the at-head delivery context, and the same side-effect helpers/append lanes
 * as `processEvent` — minus any single event: appends made here are derived
 * from the whole fold, so they carry no `whileProcessing` stamp, and
 * `delivery.idempotencyKey` binds no source offset (obligation keys must stay
 * stable across passes; only an operator `reprocessFrom` rotates them).
 */
type OnCaughtUpArgs<Contract> = SideEffectHelpers & {
  /** The fold through the runner's acknowledged cursor, which reached the observed head. */
  state: ProcessorState<Contract>;
  delivery: DeliveryContext;
  append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
  appendTo: (path: string, ...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
};

/**
 * One consistent read of a processor's fold: the reduced state pinned to the
 * highest stream offset folded into it.
 *
 * The canonical shape lives in rpc-types.ts (`ProcessorSnapshot`, the
 * published contract); this is an alias under the engine's historical name so
 * the two can never drift apart. It is also the shape of the LEGACY
 * single-cursor checkpoint record still adopted at load
 * (durable-object-processor-durability.ts).
 */
export type StreamProcessorSnapshot<State> = ProcessorSnapshot<State>;

/**
 * What the PROCESSOR contributes to the published {@link ProcessorRuntimeState}:
 * the operational `runtime` bag only — subclass debug data, never cursor
 * state. The SNAPSHOT half is supplied by the StreamProcessorRunner (the
 * cursor owner) when a host assembles the full runtime state
 * (stream-processor-registry.ts `reads`/`wakeStreamSubscriber`, the browser
 * host's capabilities), and the self-measured subscriber metrics are merged
 * in host-side so an override cannot accidentally drop them.
 */
export type ProcessorRuntimeContribution = { runtime?: Record<string, unknown> };

/**
 * The read surface a `StreamProcessorRpcTarget` (rpc-targets.ts) serves — the
 * three inspection reads of the public `StreamProcessorRpc` contract. The
 * provider is the hosting registry's `reads(processor)`
 * (stream-processor-registry.ts): the runner owns both cursors, so snapshot /
 * waitUntilEvent answer from the runner's committed progress and
 * `getRuntimeState` pins the runner's snapshot under the processor's own
 * runtime bag.
 */
export type ProcessorReads<State> = {
  snapshot(): Promise<ProcessorSnapshot<State>>;
  getRuntimeState(): Promise<ProcessorRuntimeState<State>>;
  waitUntilEvent(input: { offset: number; timeoutMs?: number }): Promise<void>;
};

/**
 * Constructor args are the base deps plus the subclass's own `Deps` flattened
 * into one object, e.g. `new BrowserRawEventsProcessor({ stream, path,
 * projectId, sql })`.
 */
export type StreamProcessorConstructorArgs<Deps extends object = object> = StreamProcessorBaseDeps &
  Deps;

/** The provenance stamp shape (`source.processor`) carried by processor appends. */
type ProcessorSourceStamp = NonNullable<NonNullable<StreamEvent["source"]>["processor"]>;

/**
 * @internal The narrow drive surface {@link StreamProcessor.runnerDriver}
 * hands the StreamProcessorRunner (stream-processor-runner.ts): exactly the
 * protected hooks and append lanes the delivery loop needs, nothing an author
 * or operator could reach for. This is how the runner invokes protected
 * members without widening the author-facing surface — authors still only
 * implement `validate`/`reduce`/`processEvent`/`onCaughtUp`, and the runner
 * never sees processor-internal state (it owns its own two-cursor progress).
 */
export type StreamProcessorDriver<Contract extends StreamProcessorContract> = {
  readonly contract: Contract;
  /** The schema default — the fold of the empty journal prefix. */
  initialState(): ProcessorState<Contract>;
  /** Validate a persisted fold against the CURRENT state schema (cache-key check). */
  parseState(
    value: unknown,
  ): { success: true; state: ProcessorState<Contract> } | { success: false; error: z.ZodError };
  /** The pure fold step: `undefined` = type not consumed, `parseError` = consumed type, bad shape. */
  reduceRawEvent(args: {
    event: StreamEvent;
    state: ProcessorState<Contract>;
  }): ReducedEvent<Contract> | ConsumedEventParseFailure | undefined;
  /** The synchronous per-event side-effect hook (virtual — subclass overrides dispatch). */
  processEvent(args: ProcessEventArgs<Contract>): undefined;
  /** The at-head hook (virtual); default is a no-op. */
  onCaughtUp(args: OnCaughtUpArgs<Contract>): Promise<void>;
  /**
   * Feed the processor's self-measured consumption metrics
   * (`subscriberMetrics.noteBatchIngested`) after a durably committed frame.
   * Without it the wake capability's consumption-lag samples
   * (`runtime.metrics`) go empty under runner drive: appends alone only feed
   * the other half of the consume-your-own-appends loop.
   */
  noteBatchIngested(args: {
    ingestedThroughOffset: number;
    newestEventCreatedAtMs?: number;
    eventCount: number;
    ingestStartedAtMs: number;
    atMs: number;
  }): void;
  /** The key derivation — `<slug>/<key>[@<path>:<offset>]` — byte-preserved from the legacy engine. */
  idempotencyKey(key: string, whileProcessing?: Pick<StreamEvent, "offset" | "path">): string;
  /** The `source.processor` provenance stamp for runner-authored raw appends. */
  processorStamp(whileProcessing?: Pick<StreamEvent, "offset" | "type">): ProcessorSourceStamp;
  /** Emits-checked, provenance-stamped append to the processor's home stream. */
  append(
    opts: { whileProcessing?: ConsumedEvent<Contract> },
    input: EmittedInput<Contract>[],
  ): Promise<StreamEvent[]>;
  /** Like `append`, onto a sibling stream (resolved via `stream.at(path)`). */
  appendTo(
    path: string,
    opts: { whileProcessing?: ConsumedEvent<Contract> },
    input: EmittedInput<Contract>[],
  ): Promise<StreamEvent[]>;
};

/**
 * Class-based stream processor.
 *
 * The model in one sentence: the StreamProcessorRunner
 * (stream-processor-runner.ts) delivers ordered events, folds each consumed
 * event into state through `reduce`, hands each reduction to the side-effect
 * hooks, and owns cursors, checkpoints, retry, and recovery — the processor
 * itself is only the hooks.
 *
 * Subclasses override up to four hooks:
 *
 * - `reduce` — pure projection of one consumed event into the next state
 * - `processEvent` — synchronous per-event side effects; what most processors
 *   implement
 * - `onCaughtUp` — desired-vs-actual reconciliation over the fold at the
 *   observed head; the runner calls it only for at-head passes, so overrides
 *   never need their own mid-refold gate
 * - `validate` — the optional pre-commit gate (inline Phase-2 runner only)
 *
 * Every hook runs inside the runner's serialized delivery chain: a later
 * frame never starts until the previous one has completed or failed, and the
 * cursor is only committed after the hooks (plus any `blockProcessorWhile`
 * work) succeed.
 */
export abstract class StreamProcessor<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
> extends RpcTarget {
  abstract readonly contract: Contract;
  protected readonly stream: Stream;
  /** Path of the home stream — the one `this.stream` points at. */
  protected readonly path: string;
  /** Owning project, or null on a global (deployment-root) stream. */
  protected readonly projectId: string | null;
  protected readonly deps: Deps;

  /**
   * Self-measured consumption metrics (see subscriber-metrics.ts): every
   * home-stream append and every committed delivery frame feeds it (the
   * latter through the driver's `noteBatchIngested`), closing the
   * consume-your-own-appends loop on the processor's own clock. HOSTS merge
   * `subscriberMetrics.report()` into the `getRuntimeState` answer they give
   * the stream (`runtime.metrics`) — merged host-side so a subclass
   * overriding `getRuntimeState` with its own `runtime` bag cannot
   * accidentally drop it. In-memory; resets with the isolate.
   */
  readonly subscriberMetrics = new SubscriberMetrics(Date.now());

  readonly #keepAliveWhile: ((work: () => Promise<unknown>) => void) | undefined;

  constructor(args: StreamProcessorConstructorArgs<Deps>) {
    super();
    // Base deps are destructured out; everything else is the subclass's Deps.
    const { stream, path, projectId, keepAliveWhile, ...deps } = args;
    this.stream = stream;
    this.path = path;
    this.projectId = projectId;
    this.deps = deps as Deps;
    this.#keepAliveWhile = keepAliveWhile;
  }

  /**
   * @internal Hands the StreamProcessorRunner its {@link StreamProcessorDriver}.
   * A STATIC accessor on purpose: statics may reach protected/private members
   * of instances of their own class, so the runner gets the hooks without any
   * new public instance member (nothing for subclasses to see, shadow, or
   * call). Authors never touch this; the runner is its only caller.
   */
  static runnerDriver<Contract extends StreamProcessorContract, Deps extends object>(
    processor: StreamProcessor<Contract, Deps>,
  ): StreamProcessorDriver<Contract> {
    return {
      contract: processor.contract,
      initialState: () => processor.contract.stateSchema.parse({}) as ProcessorState<Contract>,
      parseState: (value) => {
        const parsed = processor.contract.stateSchema.safeParse(value);
        return parsed.success
          ? { success: true, state: parsed.data as ProcessorState<Contract> }
          : { success: false, error: parsed.error };
      },
      reduceRawEvent: (args) => processor.#reduceRawEvent(args),
      processEvent: (args) => processor.processEvent(args),
      onCaughtUp: (args) => processor.onCaughtUp(args),
      noteBatchIngested: (args) => processor.subscriberMetrics.noteBatchIngested(args),
      idempotencyKey: (key, whileProcessing) => processor.idempotencyKey(key, whileProcessing),
      processorStamp: (whileProcessing) => processor.#processorStamp(whileProcessing),
      append: (opts, input) =>
        processor.#appendStamped(
          { target: processor.stream, whileProcessing: opts.whileProcessing },
          input,
        ),
      appendTo: (path, opts, input) =>
        processor.#appendStamped(
          { target: processor.stream.at(path), whileProcessing: opts.whileProcessing },
          input,
        ),
    };
  }

  /**
   * The processor-contributed slice of the published runtime state: the
   * operational `runtime` bag only (see {@link ProcessorRuntimeContribution}).
   * Subclasses override to expose debug data; the base contributes nothing.
   * The snapshot half comes from the runner, and the subscriber metrics are
   * merged in host-side — never read cursor state here.
   */
  async getRuntimeState(): Promise<ProcessorRuntimeContribution> {
    return {};
  }

  /** Build and validate an append input for an event listed in `contract.emits`. */
  #buildEmittedEvent(event: EmittedInput<Contract>): EmittedInput<Contract> {
    if (!this.contract.emits.includes(event.type)) {
      throw new Error(
        `Processor "${this.contract.slug}" cannot build emitted event "${event.type}".`,
      );
    }
    const eventDefinition = getResolvedEventDefinition({
      contract: this.contract,
      eventType: event.type,
    });
    if (eventDefinition === undefined) {
      throw new Error(`Unresolved stream processor emits event type "${event.type}".`);
    }
    return getEventInputSchema({
      type: event.type,
      payloadSchema: eventDefinition.payloadSchema,
    }).parse(event) as EmittedInput<Contract>;
  }

  /**
   * OPTIONAL synchronous pre-commit gate. Only an INLINE runner (Phase 2, the
   * Stream DO's own core processor; see stream-processor-runner.ts) calls
   * this — it runs during the append turn and THROWS to reject the append.
   * The post-commit subscriber runner never calls it: by the time a
   * subscriber sees an event it is already a durable fact, and a fact cannot
   * be un-appended. Default: accept everything. This is the pre-commit dual
   * of `blockProcessorWhile` (which holds the cursor post-commit) — the same
   * "refuse to let this event through until you're satisfied" intent,
   * expressed at whichever commit position the runner occupies.
   */
  protected validate(_args: {
    event: ConsumedEvent<Contract>;
    state: ProcessorState<Contract>;
  }): void {}

  /**
   * Pure projection of one consumed event into the next state. Defaults to
   * identity; returning `null`/`undefined` also keeps the current state.
   */
  protected reduce(args: ReduceArgs<Contract>): ProcessorState<Contract> | null | undefined {
    return args.state;
  }

  /** Synchronous per-event side-effect hook, called by the runner once per consumed event. */
  protected processEvent(_args: ProcessEventArgs<Contract>): undefined {}

  /**
   * At-head hook: the runner calls it after a frame whose PROCESSING cursor
   * reaches the observed head, with the final fold. This is where obligation
   * processors drive undriven obligations and settle dead ones (idempotent
   * appends keyed by stable obligation keys, NOT by any event offset — see
   * {@link OnCaughtUpArgs}). A mid-catch-up fold shows obligations whose
   * outcomes sit in later pages, so the runner never calls this behind the
   * observed head — no override needs its own gate. Simple processors never
   * implement it. Defaults to a no-op.
   */
  protected async onCaughtUp(_args: OnCaughtUpArgs<Contract>): Promise<void> {}

  /**
   * Reduce one raw stream event against explicit state, without touching any
   * processor-internal state. Returns `undefined` for events this processor
   * does not consume, and a {@link ConsumedEventParseFailure} for events of a
   * consumed TYPE whose shape fails the contract parse — streams accept raw
   * appends by design, so a malformed event is a fact of the log, not an
   * exception: throwing here would wedge the cursor on it forever.
   */
  #reduceRawEvent(args: {
    event: StreamEvent;
    state: ProcessorState<Contract>;
  }): ReducedEvent<Contract> | ConsumedEventParseFailure | undefined {
    const eventDefinition = getConsumedEventDefinition({
      contract: this.contract,
      eventType: args.event.type,
    });
    if (eventDefinition === undefined) return undefined;

    // Rebuilding the parser from the catalog key and payload schema keeps replay
    // and live delivery on the same validation path. Cached: constructing the
    // zod wrapper per event cost ~20µs on the hot reduce path.
    const parsed = cachedEventSchema({
      type: args.event.type,
      payloadSchema: eventDefinition.payloadSchema,
    }).safeParse(args.event);
    if (!parsed.success) return { parseError: parsed.error };
    const event = parsed.data as ConsumedEvent<Contract>;

    const state = this.reduce({ event, state: args.state }) ?? args.state;
    assertObjectProcessorState({ processorSlug: this.contract.slug, value: state });

    return { event, previousState: args.state, state };
  }

  /**
   * Fire-and-forget async work backed by the injected keep-alive, with
   * failures logged. For work launched OUTSIDE a delivery hook (DO verbs,
   * alarm handlers); inside `processEvent`/`onCaughtUp`, use the
   * `runInBackground` helper from the hook args — that one rides the runner's
   * recovery keepalive.
   */
  protected runInBackground(work: () => Promise<unknown>): void {
    this.#runKeepAliveBackedWork(work).catch((error: unknown) => {
      console.error("stream processor background work failed", error);
    });
  }

  /**
   * Append events listed in `contract.emits` to this processor's own stream,
   * stamped with `source.processor` provenance (no `whileProcessing`: this
   * lane is for appends outside any delivery — alarm handlers, DO methods —
   * and for decisions derived from the whole fold). Inside `processEvent`,
   * prefer the event-bound `args.append`.
   */
  protected append(...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    return this.#appendStamped({ target: this.stream }, input);
  }

  /** Like {@link append}, onto a sibling stream (resolved via `stream.at(path)`). */
  protected appendTo(path: string, ...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    return this.#appendStamped({ target: this.stream.at(path) }, input);
  }

  /**
   * Processor-scoped idempotency key: `<slug>/<key>`, plus `@<path>:<offset>`
   * when the append is a deterministic consequence of processing one event —
   * a redelivered frame then dedupes instead of double-appending. The path
   * makes fan-in safe: two same-slug processors on different streams
   * forwarding into one target can never collide. Omit `whileProcessing` for
   * state-derived appends and fold the deciding state into `key` instead
   * (e.g. a generation counter).
   */
  protected idempotencyKey(
    key: string,
    whileProcessing?: Pick<StreamEvent, "offset" | "path">,
  ): string {
    const base = `${this.contract.slug}/${key}`;
    if (whileProcessing === undefined) return base;
    return `${base}@${whileProcessing.path}:${whileProcessing.offset}`;
  }

  /**
   * The provenance stamp for one append lane. Always overwrites any
   * caller-supplied `source.processor`: the stamp describes THIS append, and
   * ancestry stays walkable through `whileProcessing` (and `crossPostedFrom`
   * for cross-post copies, which preserve the original stamp).
   */
  #processorStamp(whileProcessing?: Pick<StreamEvent, "offset" | "type">) {
    return {
      slug: this.contract.slug,
      version: this.contract.version,
      stream: { path: this.path, projectId: this.projectId },
      ...(whileProcessing === undefined
        ? {}
        : { whileProcessing: { offset: whileProcessing.offset, type: whileProcessing.type } }),
    };
  }

  #appendStamped(
    args: { target: Stream; whileProcessing?: Pick<StreamEvent, "offset" | "type"> },
    input: EmittedInput<Contract>[],
  ): Promise<StreamEvent[]> {
    const processor = this.#processorStamp(args.whileProcessing);
    const events = input.map((event) => {
      const built = this.#buildEmittedEvent(event) as StreamEventInput;
      return { ...built, source: { ...built.source, processor } };
    });
    // Home-stream appends feed the consume-own-append loop: the committed
    // offsets come back through this processor's own subscription, and
    // noteBatchIngested closes the sample. Sibling-stream appends (appendTo)
    // never loop back here, so they are not timed.
    if (args.target !== this.stream) return args.target.append(...events);
    const t0 = Date.now();
    return Promise.resolve(this.stream.append(...events)).then((committed) => {
      const maxCommittedOffset = committed.reduce((max, event) => Math.max(max, event.offset), 0);
      if (maxCommittedOffset > 0) {
        this.subscriberMetrics.noteAppendCommitted({ maxCommittedOffset, t0, atMs: Date.now() });
      }
      return committed;
    });
  }

  // keepAliveWhile is fire-and-forget from the host's point of view (it only
  // keeps the runtime alive while the work runs), so this bridges the work's
  // result/failure back into a promise the caller can await.
  async #runKeepAliveBackedWork(work: () => Promise<unknown>): Promise<unknown> {
    if (this.#keepAliveWhile === undefined) return await work();

    return await new Promise<unknown>((resolve, reject) => {
      this.#keepAliveWhile!(async () => {
        try {
          const result = await work();
          resolve(result);
          return result;
        } catch (error) {
          reject(error);
          throw error;
        }
      });
    });
  }
}
