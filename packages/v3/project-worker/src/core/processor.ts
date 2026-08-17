// core/processor.ts — stream processors: the contract, the author base class, and the registry
// that drives them. The AUTHOR-FACING API mirrors apps/os deliberately (same names, same shapes,
// same concurrency contract — `defineProcessorContract`, `StreamProcessor.reduce/processEvent`,
// `blockProcessorWhile`/`runInBackground`, `delivery.caughtUp`) so processors port both ways.
// The IMPLEMENTATION is clean-room and much smaller: the Stream DO drives its registry directly
// after each commit — no subscription sender, no wake protocol, no keepalive machinery (yet).
//
// THE CONCURRENCY CONTRACT (the part explicitly mirrored, verbatim from apps/os's runner):
//   1. ONE SERIAL CHAIN per registered processor — batches never interleave.
//   2. ONE EVENT AT A TIME inside a batch: this event's `blockProcessorWhile` work completes
//      before the next event's `processEvent` starts (a FIFO chain, awaited per event).
//   3. `runInBackground` work is deliberately NOT awaited — it may overtake later events; it is
//      a droppable attempt whose outcome must be recoverable from state at the next at-head pass.
//   4. ONE DURABLE COMMIT PER BATCH, after every event's blocking work settled — persist BEFORE
//      advancing the in-memory cursor. A failed batch persists nothing and is retried whole.
//   5. The at-head pass: the last consumable event of a batch that reaches the stream head
//      carries `delivery.caughtUp: true`; a batch that reaches the head without one gets a single
//      extra `processEvent({ event: null, delivery: { caughtUp: true } })` call, so state-derived
//      obligations are never stranded behind an unconsumed tail.
//
// `reduce` is a PURE fold (new object out, inputs immutable) and runs at DELIVERY, immediately
// before that event's `processEvent` — the fold is cached per contract version; bumping
// `contract.version` refolds from offset 0 through `reduce` only (never re-running side effects).

import { z } from "zod";
import {
  StreamEvent,
  StreamEventInput,
  type StreamEvent as StreamEventT,
  type StreamEventInput as StreamEventInputT,
} from "./events.ts";

// ─────────────────────────────────────────── the contract ───────────────────────────────────────────

/** One owned event type: its payload schema (and prose for humans/docs). */
export type EventDefinition = {
  description?: string;
  payloadSchema: z.ZodType;
};

export type ProcessorContract<State = unknown> = {
  slug: string;
  /** Bumping this refolds state from offset 0 (reduce only — side effects never re-run). */
  version: string;
  description: string;
  stateSchema: z.ZodType<State>;
  /** The event types this contract OWNS, keyed by full type string. */
  events: Record<string, EventDefinition>;
  /** What it reacts to: owned/foreign type strings, or "*" for everything. */
  consumes: readonly string[];
  /** What its `append` is allowed to emit. */
  emits: readonly string[];
  /** Build a typed input for an owned event (validates the payload against its schema). */
  buildEvent: (event: {
    type: string;
    payload?: unknown;
    idempotencyKey?: string;
  }) => StreamEventInputT;
  /** Validate a committed event against the owned catalog (throws on unknown/malformed). */
  parseEvent: (event: StreamEventT) => StreamEventT;
  /** Validate an append input against the owned catalog (throws on unknown/malformed). */
  parseEventInput: (event: StreamEventInputT) => StreamEventInputT;
};

export function defineProcessorContract<StateSchema extends z.ZodType>(contract: {
  slug: string;
  version: string;
  description: string;
  /** Must parse `{}` — the initial state is `stateSchema.parse({})` (all fields defaulted). */
  stateSchema: StateSchema;
  events: Record<string, EventDefinition>;
  consumes: readonly string[];
  emits: readonly string[];
}): ProcessorContract<z.infer<StateSchema>> {
  const initial = contract.stateSchema.safeParse({});
  if (!initial.success)
    throw new Error(`contract "${contract.slug}": stateSchema must parse {} (default every field)`);
  const payloadOf = (type: string, payload: unknown, where: string): unknown => {
    const def = contract.events[type];
    if (!def)
      throw new Error(`contract "${contract.slug}": ${where} event type "${type}" is not owned`);
    return def.payloadSchema.parse(payload ?? {});
  };
  // The cast bridges the generic context: at every call site StateSchema is concrete, so
  // `z.infer<StateSchema>` is exact; inside this body TS can't unify the two spellings.
  return {
    ...contract,
    stateSchema: contract.stateSchema as unknown as z.ZodType<z.infer<StateSchema>>,
    buildEvent: (event) => ({
      type: event.type,
      payload: payloadOf(event.type, event.payload, "buildEvent") as Record<string, unknown>,
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    }),
    parseEvent: (event) => {
      const parsed = StreamEvent.parse(event);
      payloadOf(parsed.type, parsed.payload, "parseEvent");
      return parsed;
    },
    parseEventInput: (event) => {
      const parsed = StreamEventInput.parse(event);
      payloadOf(parsed.type, parsed.payload, "parseEventInput");
      return parsed;
    },
  };
}

// ─────────────────────────────────────── the author base class ───────────────────────────────────────

/** The stream a processor folds — append + replay, nothing more. */
export type ProcessorStream = {
  append(...events: StreamEventInputT[]): Promise<StreamEventT[]> | StreamEventT[];
  read(afterOffset?: number, limit?: number): Promise<StreamEventT[]> | StreamEventT[];
};

export type ReduceArgs<State> = { event: StreamEventT; state: State };

export type ProcessEventArgs<State> = {
  /** The consumed event — or `null` for the eventless at-head pass. */
  event: StreamEventT | null;
  state: State;
  previousState: State;
  /** Emit (validated against `emits`, provenance-stamped) onto this processor's own stream. */
  append: (...events: StreamEventInputT[]) => Promise<StreamEventT[]>;
  /** Hold the cursor until `work` settles; FIFO with other blockers of the SAME event. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** Fire-and-forget attempt; may overtake later events; outcome must be state-recoverable. */
  runInBackground: (work: () => Promise<unknown>) => void;
  delivery: { caughtUp: boolean };
};

export abstract class StreamProcessor<State> {
  abstract readonly contract: ProcessorContract<State>;
  protected readonly stream: ProcessorStream;
  protected readonly path: string;
  protected readonly projectId: string;

  constructor(args: { stream: ProcessorStream; path: string; projectId: string }) {
    this.stream = args.stream;
    this.path = args.path;
    this.projectId = args.projectId;
  }

  /** Pure fold. Return the NEXT state (a new object) — or null/undefined to keep the current. */
  protected reduce(_args: ReduceArgs<State>): State | null | undefined {
    return undefined;
  }

  /** Side-effect hook. Synchronous by design: register async work via the two helpers. */
  protected processEvent(_args: ProcessEventArgs<State>): undefined {}

  /** Stable idempotency key namespaced by slug; add `whileProcessing` for per-event keys. */
  protected idempotencyKey(key: string, whileProcessing?: StreamEventT): string {
    return whileProcessing
      ? `${this.contract.slug}/${key}@${this.path}:${whileProcessing.offset}`
      : `${this.contract.slug}/${key}`;
  }

  /** The registry reaches the protected hooks through this seam (apps/os `runnerHooks`). */
  static runnerHooks<State>(processor: StreamProcessor<State>) {
    return {
      contract: processor.contract,
      initialState: () => processor.contract.stateSchema.parse({}),
      reduce: (args: ReduceArgs<State>) => processor.reduce(args),
      processEvent: (args: ProcessEventArgs<State>) => processor.processEvent(args),
      stream: processor.stream,
    };
  }
}

// ───────────────────────────────────────── the registry/runner ─────────────────────────────────────────

export type ProcessorSnapshot<State> = { offset: number; state: State };

export type RegisteredProcessorReads<State> = {
  /** Fold-and-effects caught up through the persisted cursor, then the current snapshot. */
  snapshot(): Promise<ProcessorSnapshot<State>>;
  /** Resolves once the processor has processed AT LEAST through `offset`. */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void>;
};

type Progress<State> = {
  reducerVersion: string;
  reducedThroughOffset: number;
  state: State;
};

type Registered = {
  name: string;
  hooks: ReturnType<typeof StreamProcessor.runnerHooks<unknown>>;
  chain: Promise<void>; // rule 1: the serial chain
  progress: Progress<unknown> | null; // in-memory cache of the persisted fold
  waiters: { offset: number; resolve: () => void }[];
};

/**
 * The in-DO registry. The hosting DO constructs it with its own storage + the stream handle,
 * registers processors, and calls `deliver` after every commit (and `catchUp` on cold reads).
 */
export function createStreamProcessorRegistry(options: {
  storage: { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
  stream: ProcessorStream;
  path: string;
  projectId: string;
}) {
  const processors = new Map<string, Registered>();
  const progressKey = (name: string) => `processor:${name}:progress`;

  const loadProgress = (p: Registered): Progress<unknown> => {
    if (p.progress) return p.progress;
    const stored = options.storage.get<Progress<unknown>>(progressKey(p.name));
    p.progress =
      stored && stored.reducerVersion === p.hooks.contract.version
        ? stored
        : {
            reducerVersion: p.hooks.contract.version,
            reducedThroughOffset: 0,
            state: p.hooks.initialState(),
          };
    return p.progress;
  };

  /** Refold from 0 through `reduce` only (contract version changed). Never re-runs effects. */
  const refoldIfNeeded = async (p: Registered): Promise<void> => {
    const stored = options.storage.get<Progress<unknown>>(progressKey(p.name));
    if (!stored || stored.reducerVersion === p.hooks.contract.version) return;
    let state = p.hooks.initialState();
    let after = 0;
    for (;;) {
      const events = await options.stream.read(after, 500);
      if (events.length === 0) break;
      for (const event of events) {
        if (consumes(p, event)) state = p.hooks.reduce({ event, state }) ?? state;
        after = event.offset;
      }
      if (events.length < 500) break;
    }
    p.progress = { reducerVersion: p.hooks.contract.version, reducedThroughOffset: after, state };
    options.storage.put(progressKey(p.name), p.progress);
  };

  const consumes = (p: Registered, event: StreamEventT): boolean =>
    p.hooks.contract.consumes.includes("*") || p.hooks.contract.consumes.includes(event.type);

  /** Rules 2-5: one event at a time, FIFO blockers, one persist per batch, at-head pass. */
  const processBatch = async (p: Registered, events: StreamEventT[], streamMaxOffset: number) => {
    await refoldIfNeeded(p);
    const progress = loadProgress(p);
    let { state, reducedThroughOffset } = progress;
    let caughtUpDelivered = false;

    const makeAppend =
      (whileProcessing: StreamEventT | null) =>
      async (...inputs: StreamEventInputT[]): Promise<StreamEventT[]> => {
        for (const input of inputs) {
          if (!p.hooks.contract.emits.includes(input.type))
            throw new Error(
              `processor "${p.name}" emits ${JSON.stringify(input.type)} without declaring it`,
            );
          input.source = {
            processor: {
              slug: p.hooks.contract.slug,
              version: p.hooks.contract.version,
              ...(whileProcessing
                ? {
                    whileProcessing: { offset: whileProcessing.offset, type: whileProcessing.type },
                  }
                : {}),
            },
          };
        }
        return await options.stream.append(...inputs);
      };

    const runOne = async (event: StreamEventT | null, caughtUp: boolean) => {
      const previousState = state;
      if (event) {
        let next: unknown;
        try {
          next = p.hooks.reduce({ event, state });
        } catch (error) {
          // A malformed/hostile event must not wedge the fold forever: record the skip, move on.
          console.error(`processor "${p.name}" reduce failed at offset ${event.offset}`, error);
          next = undefined;
        }
        state = next ?? state;
      }
      // FIFO blocker chain for THIS event (rule 2); background work escapes it (rule 3).
      let blockers: Promise<unknown> = Promise.resolve();
      p.hooks.processEvent({
        event,
        state,
        previousState,
        append: makeAppend(event),
        blockProcessorWhile: (work) => {
          blockers = blockers.then(() => work());
        },
        runInBackground: (work) => {
          void work().catch((error) =>
            console.error(`processor "${p.name}" background work failed`, error),
          );
        },
        delivery: { caughtUp },
      });
      await blockers; // STRICT PER-EVENT ORDERING: this event's blocking work completes first
      if (event) reducedThroughOffset = event.offset;
      if (caughtUp) caughtUpDelivered = true;
    };

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.offset <= reducedThroughOffset) continue; // redelivery dedupe against the cursor
      if (!consumes(p, event)) {
        reducedThroughOffset = event.offset;
        continue;
      }
      const isLastConsumable =
        events.slice(i + 1).every((e) => !consumes(p, e)) &&
        events[events.length - 1].offset >= streamMaxOffset;
      await runOne(event, isLastConsumable);
    }
    // Rule 5: reached the head without a caught-up event → one eventless at-head pass.
    if (!caughtUpDelivered && (events.at(-1)?.offset ?? reducedThroughOffset) >= streamMaxOffset) {
      await runOne(null, true);
      reducedThroughOffset = Math.max(reducedThroughOffset, streamMaxOffset);
    }

    // Rule 4: ONE persist per batch, before the in-memory cursor advances.
    const next: Progress<unknown> = {
      reducerVersion: p.hooks.contract.version,
      reducedThroughOffset,
      state,
    };
    options.storage.put(progressKey(p.name), next);
    p.progress = next;
    for (const w of p.waiters.splice(0)) {
      if (next.reducedThroughOffset >= w.offset) w.resolve();
      else p.waiters.push(w);
    }
  };

  const enqueue = (p: Registered, work: () => Promise<void>): Promise<void> => {
    const run = p.chain.then(work);
    p.chain = run.catch(() => {}); // a failed batch never wedges the chain; retry via catchUp
    return run;
  };

  const catchUpOne = (p: Registered): Promise<void> =>
    enqueue(p, async () => {
      await refoldIfNeeded(p);
      for (;;) {
        const after = loadProgress(p).reducedThroughOffset;
        const events = await options.stream.read(after, 500);
        if (events.length === 0) return;
        const head = events[events.length - 1].offset;
        await processBatch(p, events, head);
        if (events.length < 500) return;
      }
    });

  return {
    /** Register under the contract slug (the identity doctrine: name = slug). */
    // `any` because StreamProcessor is invariant in State — every concrete subclass must be
    // acceptable here, and the precise State re-attaches through `reads(processor)`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register<P extends StreamProcessor<any>>(processor: P): P {
      const hooks = StreamProcessor.runnerHooks(processor as StreamProcessor<unknown>);
      const name = hooks.contract.slug;
      if (processors.has(name)) throw new Error(`processor "${name}" already registered`);
      processors.set(name, { name, hooks, chain: Promise.resolve(), progress: null, waiters: [] });
      return processor;
    },

    /** The drive door: the DO calls this after every commit with the just-committed events. */
    deliver(events: StreamEventT[], streamMaxOffset: number): Promise<void> {
      return Promise.all(
        [...processors.values()].map((p) =>
          enqueue(p, () => processBatch(p, events, streamMaxOffset)),
        ),
      ).then(() => undefined);
    },

    /** Re-drive a processor from its persisted cursor (cold reads, retry after a failed batch). */
    catchUp(name?: string): Promise<void> {
      const targets = name
        ? [processors.get(name)].filter((p) => p !== undefined)
        : [...processors.values()];
      if (name && targets.length === 0) throw new Error(`unknown processor "${name}"`);
      return Promise.all(targets.map(catchUpOne)).then(() => undefined);
    },

    reads<State>(processor: StreamProcessor<State>): RegisteredProcessorReads<State> {
      const p = processors.get(processor.contract.slug);
      if (!p) throw new Error(`processor "${processor.contract.slug}" is not registered`);
      return {
        snapshot: async () => {
          await catchUpOne(p);
          const progress = loadProgress(p);
          return { offset: progress.reducedThroughOffset, state: progress.state as State };
        },
        waitUntilProcessed: ({ offset, timeoutMs = 10_000 }) =>
          new Promise<void>((resolve, reject) => {
            if (loadProgress(p).reducedThroughOffset >= offset) return resolve();
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `processor "${p.name}" did not reach offset ${offset} in ${timeoutMs}ms`,
                  ),
                ),
              timeoutMs,
            );
            p.waiters.push({
              offset,
              resolve: () => {
                clearTimeout(timer);
                resolve();
              },
            });
            void catchUpOne(p);
          }),
      };
    },

    get names(): string[] {
      return [...processors.keys()];
    },
  };
}
