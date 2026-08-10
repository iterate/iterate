import { RpcTarget } from "@iterate-com/capnweb";
import type { z } from "zod";
import { resolveStreamPath, type ProcessorStream } from "./stream-handle.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { ProcessorRuntimeState, ProcessorSnapshot } from "./rpc-types.ts";
// Type-only by necessity, not just hygiene: the runner imports this module's
// VALUE (the class, for `runnerHooks`), so a value import back would be a
// runtime cycle. Types erase; the cycle doesn't exist at runtime.
import type { DeliveryContext } from "./stream-processor-runner.ts";
import { EventConsumptionMetrics } from "./event-consumption-metrics.ts";
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

// `keepAliveWhile` is fire-and-forget from the host's point of view (it only
// keeps the runtime alive while the work runs), so this bridges the work's
// result/failure back into a promise the caller can await.
export async function awaitKeepAliveBacked<T>(
  keepAliveWhile: ((work: () => Promise<unknown>) => void) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (keepAliveWhile === undefined) return await work();

  return await new Promise<T>((resolve, reject) => {
    keepAliveWhile(async () => {
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
  stream: ProcessorStream;
  /** Path of the stream this processor runs on (the stream `stream` points at). */
  path: string;
  /** Owning project, or null on a global (deployment-root) stream. */
  projectId: string | null;
  keepAliveWhile?: (work: () => Promise<unknown>) => void;
};

// `ReduceArgs` / `ProcessEventArgs` are exported as the one sanctioned
// spelling for subclass hook annotations: the hooks are `protected`, so
// `Parameters<StreamProcessor<Contract>["method"]>[0]` is not writable from
// outside a subclass body.
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
export type ReduceArgs<Contract> = {
  event: ConsumedEvent<Contract>;
  state: ProcessorState<Contract>;
};

/**
 * Side-effect scheduling helpers handed to the `process*` hooks. Two
 * primitives, two guarantees — every side effect must pick one deliberately:
 *
 * - `blockProcessorWhile` — SHORT work the next event must not overtake.
 *   At-least-once: the cursor is held, a crash resends the event batch, and
 *   append idempotency keys collapse the re-run. Long work does NOT belong
 *   here: it head-of-line-blocks every later event (including cancellations).
 *
 * - `runInBackground` — a DROPPABLE ATTEMPT. The cursor advances
 *   immediately; an eviction loses the closure silently. Every callsite must
 *   answer "what recovers the OUTCOME if this attempt drops?" — legitimate
 *   answers are "an at-head pass (`processEvent` under
 *   `delivery.caughtUp`), via stream-backed requested/completed evidence" (LLM
 *   calls, scripts, debounce timers) or
 *   "nothing, the outcome genuinely doesn't matter" (telemetry). A naked
 *   runInBackground around consequential work with no recovery pass is the bug
 *   class the 2026-06-10 / 2026-07-07 incidents came from.
 *
 * Both are keepalive-backed: while either kind of work is in flight the
 * runner's recovery adapter parks a durable alarm ahead of it, so an
 * incarnation that dies owing work is revived and the processors get their
 * at-head pass (docs/writing-stream-processors.md has the full doctrine).
 */
type SideEffectHelpers = {
  /** Hold the cursor (and the next event) until this work completes.
   * Blocking is the EXCEPTION, not the default — justify it at the call site
   * with a comment explaining why the next event must wait (i.e. why losing
   * this append would lose a per-event consequence forever).
   * Registrations run STRICTLY IN REGISTRATION ORDER: each blocker starts
   * only after the previous one settles, so a later registration in the same
   * `processEvent` body observes the earlier work's appends. Order
   * state-derived work after per-event work by writing it later in the
   * function — no separate lane needed. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** A droppable attempt; failures are caught and logged, evictions lose it. */
  runInBackground: (work: () => Promise<unknown>) => void;
};

/** What `processEvent` receives: one reduction result plus delivery context and helpers. */
export type ProcessEventArgs<Contract> = Omit<ReducedEvent<Contract>, "event"> &
  SideEffectHelpers & {
    /**
     * The consumed event being processed — or `null` for an eventless call where
     * `delivery.caughtUp` is true. The runner makes that call when a batch scans
     * through the highest observed offset but no consumed event carried `caughtUp`
     * (for example, the final row is stream/connection-closed). The processor
     * still needs a chance to act on the complete observed fold. A per-event switch MUST guard on
     * `event !== null`; the caught-up processing reads `state` and needs no event.
     */
    event: ReducedEvent<Contract>["event"] | null;
    /**
     * Append one or more events listed in `contract.emits` to this stream,
     * stamped with `source.processor` provenance pointing at THIS event as
     * `whileProcessing` (unstamped on the event-less caught-up call). The binding
     * is a closure, so appends made later from
     * `blockProcessorWhile`/`runInBackground` work scheduled here still stamp
     * the event that was being processed.
     */
    append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    /** Like `append`, onto a sibling stream (resolved via `stream.at(path)`). */
    appendTo: (path: string, ...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    /**
     * Honest event-time context (delivery phase, highest observed offset, cursor
     * revision) supplied by the StreamProcessorRunner, the only driver.
     */
    delivery: DeliveryContext;
  };

/**
 * What the PROCESSOR contributes to the published {@link ProcessorRuntimeState}:
 * the operational `runtime` bag only — subclass debug data, never cursor
 * state. The SNAPSHOT half is supplied by the StreamProcessorRunner (the
 * cursor owner) when a host assembles the full runtime state
 * (stream-processor-registry.ts `reads`/`wakeStreamProcessor`, the browser
 * host's capabilities), and self-measured event-consumption metrics are merged
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
 * @internal The narrow drive surface {@link StreamProcessor.runnerHooks}
 * hands the StreamProcessorRunner (stream-processor-runner.ts): exactly the
 * protected hooks and append methods the event-processing loop needs, nothing an author
 * or operator could reach for. This is how the runner invokes protected
 * members without widening the author-facing surface — authors still only
 * implement `reduce`/`processEvent` (fold-derived side effects ride
 * `processEvent` under `delivery.caughtUp`), and the runner never sees
 * processor-internal state (it owns its own two-cursor progress).
 */
export type StreamProcessorRunnerHooks<Contract extends StreamProcessorContract> = {
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
  /** Whether this event will reach `processEvent` — a consumed type whose
   * payload parses. Stateless (no fold), so the runner can find the last
   * DELIVERED offset of a batch (for `caughtUp`) without pre-folding, and
   * without letting a malformed final event steal the flag. */
  isDeliverable(event: StreamEvent): boolean;
  /** The synchronous per-event side-effect hook (virtual — subclass overrides
   * dispatch). The caught-up processing rides it under `delivery.caughtUp`. */
  processEvent(args: ProcessEventArgs<Contract>): undefined;
  /**
   * Feed the processor's self-measured consumption metrics
   * (`eventConsumptionMetrics.noteBatchIngested`) after a durably committed batch.
   * Without it the wake capability's consumption-lag samples
   * (`runtime.metrics`) go empty under runner drive: appends alone only feed
   * the other half of the consume-your-own-appends loop.
   */
  noteBatchIngested(args: {
    ingestedThroughOffset: number;
    ingestedOffsets: readonly number[];
    newestEventCreatedAtMs?: number;
    ingestStartedAtMs: number;
    atMs: number;
  }): void;
  /** The processor's semantic key — `<slug>/<key>[@<path>:<offset>]`. */
  idempotencyKey(key: string, whileProcessing?: Pick<StreamEvent, "offset" | "path">): string;
  /** The `source.processor` provenance stamp for runner-authored raw appends. */
  processorStamp(
    streamId: string,
    whileProcessing?: Pick<StreamEvent, "offset" | "type">,
  ): ProcessorSourceStamp;
  /** Emits-checked, provenance-stamped append to the processor's home stream. */
  append(
    opts: { streamId: string; whileProcessing?: ConsumedEvent<Contract> },
    input: EmittedInput<Contract>[],
  ): Promise<StreamEvent[]>;
  /** Like `append`, onto a sibling stream (resolved via `stream.at(path)`). */
  appendTo(
    path: string,
    opts: { streamId: string; whileProcessing?: ConsumedEvent<Contract> },
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
 * Subclasses override up to two hooks:
 *
 * - `reduce` — pure projection of one consumed event into the next state
 * - `processEvent` — synchronous per-event side effects; what most processors
 *   implement. Side effects derived from the whole fold (rather than the
 *   delivered event) belong here too, guarded by `args.delivery.caughtUp`.
 *   `args.event` is `null` only when a caught-up scan contained no
 *   consumed event; authors skip their per-event switch but can still act on
 *   the fold.
 *
 * Every hook runs inside the runner's serialized delivery chain: a later
 * batch never starts until the previous one has completed or failed, and the
 * cursor is only committed after the hooks (plus any `blockProcessorWhile`
 * work) succeed.
 */
export abstract class StreamProcessor<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
> extends RpcTarget {
  abstract readonly contract: Contract;
  protected readonly stream: ProcessorStream;
  /** Path of the home stream — the one `this.stream` points at. */
  protected readonly path: string;
  /** Owning project, or null on a global (deployment-root) stream. */
  protected readonly projectId: string | null;
  protected readonly deps: Deps;

  /**
   * Self-measured consumption metrics (see event-consumption-metrics.ts): every
   * home-stream append and every committed event batch feeds it (the
   * latter through the driver's `noteBatchIngested`), closing the
   * consume-your-own-appends loop on the processor's own clock. HOSTS merge
   * `eventConsumptionMetrics.report()` into the `getRuntimeState` answer they give
   * the stream (`runtime.metrics`) — merged host-side so a subclass
   * overriding `getRuntimeState` with its own `runtime` bag cannot
   * accidentally drop it. In-memory; resets with the isolate.
   */
  readonly eventConsumptionMetrics = new EventConsumptionMetrics(Date.now());

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
   * @internal Hands the StreamProcessorRunner its {@link StreamProcessorRunnerHooks}.
   * A STATIC accessor on purpose: statics may reach protected/private members
   * of instances of their own class, so the runner gets the hooks without any
   * new public instance member (nothing for subclasses to see, shadow, or
   * call). Authors never touch this; the runner is its only caller.
   */
  static runnerHooks<Contract extends StreamProcessorContract, Deps extends object>(
    processor: StreamProcessor<Contract, Deps>,
  ): StreamProcessorRunnerHooks<Contract> {
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
      isDeliverable: (event) => processor.#isDeliverable(event),
      processEvent: (args) => processor.processEvent(args),
      noteBatchIngested: (args) => processor.eventConsumptionMetrics.noteBatchIngested(args),
      idempotencyKey: (key, whileProcessing) => processor.idempotencyKey(key, whileProcessing),
      processorStamp: (streamId, whileProcessing) =>
        processor.#processorStamp(streamId, whileProcessing),
      append: (opts, input) =>
        processor.#appendStamped(
          {
            target: processor.stream,
            targetPath: processor.path,
            sourceStreamId: opts.streamId,
            whileProcessing: opts.whileProcessing,
          },
          input,
        ),
      appendTo: (path, opts, input) =>
        processor.#appendStamped(
          {
            ...processor.#appendTarget(path),
            sourceStreamId: opts.streamId,
            whileProcessing: opts.whileProcessing,
          },
          input,
        ),
    };
  }

  /**
   * The processor-contributed slice of the published runtime state: the
   * operational `runtime` bag only (see {@link ProcessorRuntimeContribution}).
   * Subclasses override to expose debug data; the base contributes nothing.
   * The snapshot half comes from the runner, and event-consumption metrics are
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
      ephemeral: eventDefinition.ephemeral,
    }).parse(event) as EmittedInput<Contract>;
  }

  /**
   * Pure projection of one consumed event into the next state. Defaults to
   * identity; returning `null`/`undefined` also keeps the current state.
   */
  protected reduce(args: ReduceArgs<Contract>): ProcessorState<Contract> | null | undefined {
    return args.state;
  }

  /**
   * Synchronous side-effect hook, called by the runner once per consumed event
   * and, when necessary, once more with `event: null` for a caught-up scan
   * that consumed nothing. It is ALSO the caught-up processing: when
   * `args.delivery.caughtUp` is true (`args.state` is the whole observed fold),
   * an obligation processor
   * drives its undriven obligations and settles dead ones — scheduling that
   * async work via `args.blockProcessorWhile`, keyed by STABLE obligation keys
   * (`this.idempotencyKey(<obligation>)` with the deciding state folded into
   * the key and NO event bound, so a redelivery/revival does not rotate the
   * key and re-run the effect).
   * The runner never sets `caughtUp` below its highest observed offset — no override
   * needs its own mid-catch-up gate. Simple processors ignore the flag.
   */
  protected processEvent(_args: ProcessEventArgs<Contract>): undefined {}

  /** Parse a raw event against the contract: `undefined` (type not consumed),
   * a Zod error (consumed type, bad shape), or the typed consumed event.
   * Stateless — shared by {@link #reduceRawEvent} and {@link #isDeliverable}. */
  #parseConsumedEvent(
    event: StreamEvent,
  ): { ok: true; event: ConsumedEvent<Contract> } | { ok: false; error?: z.ZodError } {
    const eventDefinition = getConsumedEventDefinition({
      contract: this.contract,
      eventType: event.type,
      // `"*"` must not sweep in ephemeral events; naming the type is the opt-in.
      ephemeral: event.ephemeral,
    });
    if (eventDefinition === undefined) return { ok: false };
    // Rebuilding the parser from the catalog key and payload schema keeps replay
    // and live delivery on the same validation path. Cached: constructing the
    // zod wrapper per event cost ~20µs on the hot reduce path.
    const parsed = cachedEventSchema({
      type: event.type,
      payloadSchema: eventDefinition.payloadSchema,
      ephemeral: eventDefinition.ephemeral,
    }).safeParse(event);
    if (!parsed.success) return { ok: false, error: parsed.error };
    return { ok: true, event: parsed.data as ConsumedEvent<Contract> };
  }

  /** True when this event will reach `processEvent`: a consumed type that
   * parses. A malformed consumed event is deliberately NOT deliverable. */
  #isDeliverable(event: StreamEvent): boolean {
    return this.#parseConsumedEvent(event).ok;
  }

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
    const parsed = this.#parseConsumedEvent(args.event);
    if (!parsed.ok) return parsed.error === undefined ? undefined : { parseError: parsed.error };
    const event = parsed.event;

    const state = this.reduce({ event, state: args.state }) ?? args.state;
    assertObjectProcessorState({ processorSlug: this.contract.slug, value: state });

    return { event, previousState: args.state, state };
  }

  /**
   * Fire-and-forget async work backed by the injected keep-alive, with
   * failures logged. For work launched OUTSIDE a delivery hook (DO verbs,
   * alarm handlers); inside `processEvent`, use the `runInBackground` helper
   * from the hook args — that one rides the runner's recovery keepalive.
   */
  protected runInBackground(work: () => Promise<unknown>): void {
    awaitKeepAliveBacked(this.#keepAliveWhile, work).catch((error: unknown) => {
      console.error("stream processor background work failed", error);
    });
  }

  /**
   * Append events listed in `contract.emits` to this processor's own stream,
   * stamped with `source.processor` provenance (no `whileProcessing`: this
   * overload is for appends outside any event batch — alarm handlers, DO methods —
   * and for decisions derived from the whole fold). Inside `processEvent`,
   * prefer the event-bound `args.append`.
   */
  protected append(...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    return this.#appendStamped({ target: this.stream, targetPath: this.path }, input);
  }

  /** Like {@link append}, onto a sibling stream (resolved via `stream.at(path)`). */
  protected appendTo(path: string, ...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    return this.#appendStamped(this.#appendTarget(path), input);
  }

  #appendTarget(path: string): { target: ProcessorStream; targetPath: string } {
    const targetPath = resolveStreamPath(this.path, path);
    return {
      // `StreamRpcTarget.at()` returns a new object even when `path` resolves
      // back to the home stream. Select by resolved address so production and
      // in-memory hosts both retain the guarded-home append semantics.
      target: targetPath === this.path ? this.stream : this.stream.at(path),
      targetPath,
    };
  }

  /**
   * Processor-scoped idempotency key: `<slug>/<key>`, plus `@<path>:<offset>`
   * when the append is a deterministic consequence of processing one event —
   * a resent event batch then dedupes instead of double-appending. The path
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
   * The provenance stamp for one append. Always overwrites any
   * caller-supplied `source.processor`: the stamp describes THIS append, and
   * ancestry stays walkable through `whileProcessing` (and `copiedFrom`
   * for subscription copies, which preserve the original stamp).
   */
  #processorStamp(streamId: string, whileProcessing?: Pick<StreamEvent, "offset" | "type">) {
    return {
      slug: this.contract.slug,
      version: this.contract.version,
      stream: { path: this.path, projectId: this.projectId, streamId },
      ...(whileProcessing === undefined
        ? {}
        : { whileProcessing: { offset: whileProcessing.offset, type: whileProcessing.type } }),
    };
  }

  #appendStamped(
    args: {
      target: ProcessorStream;
      targetPath: string;
      sourceStreamId?: string;
      whileProcessing?: Pick<StreamEvent, "offset" | "type">;
    },
    input: EmittedInput<Contract>[],
  ): Promise<StreamEvent[]> {
    // Validate emitted types synchronously, preserving the author-facing
    // method's immediate failure behavior even when an out-of-batch append
    // must first read the current stream ID.
    const builtEvents = input.map((event) => this.#buildEmittedEvent(event) as StreamEventInput);
    return this.#appendBuiltEvents(args, builtEvents);
  }

  async #appendBuiltEvents(
    args: {
      target: ProcessorStream;
      targetPath: string;
      sourceStreamId?: string;
      whileProcessing?: Pick<StreamEvent, "offset" | "type">;
    },
    builtEvents: StreamEventInput[],
  ): Promise<StreamEvent[]> {
    // Batch-bound appends receive the exact ID from the delivery envelope.
    // Alarm/DO-method appends bind themselves by reading the home stream now.
    const sourceStreamId =
      args.sourceStreamId ??
      (
        await this.stream.getEventPage({
          afterOffset: Number.MAX_SAFE_INTEGER,
          limit: 1,
        })
      ).streamId;
    const processor = this.#processorStamp(sourceStreamId, args.whileProcessing);
    let events = builtEvents.map((built) => ({
      ...built,
      source: { ...built.source, processor },
    }));
    // Home-stream appends of a CONSUMED type feed the consume-own-append
    // loop: those committed offsets come back through this processor's own
    // subscription, and noteBatchIngested closes the sample. Sibling-stream
    // appends (appendTo) never loop back here, so they are not timed at all.
    // A sibling retains rows across deletion/recreation of the source path, so
    // its committed key includes the source lifetime; offset 1 from A and offset 1 from B are
    // different causes and must both be able to land. Idempotency keys are
    // retry identities, not semantic entity identities: readers determine
    // meaning from event types or reduced processor state, never key spelling.
    if (args.targetPath !== this.path) {
      events = events.map((event) =>
        event.idempotencyKey === undefined
          ? event
          : {
              ...event,
              idempotencyKey: `${event.idempotencyKey}@source-stream:${sourceStreamId}`,
            },
      );
      return args.target.append(...events);
    }
    const t0 = Date.now();
    return this.stream.appendIfStreamId({ streamId: sourceStreamId, events }).then((committed) => {
      if (committed.length === 0) return committed;
      // ONLY an event this processor itself consumes can close the loop, and
      // most processors emit far more than they consume: the voice facet
      // appends ~50 speaker frames a second and consumes none of them. Timing
      // those made every sample the wait until the next thing the processor
      // DID consume — a person's pause between sentences, published as
      // "seconds to see my own append". An append with nothing consumable in
      // it is timed for its round trip and nothing else.
      let maxCommittedOffset: number | null = null;
      for (const event of committed) {
        if (!this.#isDeliverable(event)) continue;
        maxCommittedOffset = Math.max(maxCommittedOffset ?? 0, event.offset);
      }
      this.eventConsumptionMetrics.noteAppendCommitted({
        maxCommittedOffset,
        t0,
        atMs: Date.now(),
      });
      return committed;
    });
  }
}
