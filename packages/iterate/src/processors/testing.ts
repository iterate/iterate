// In-memory test doubles for the stream substrate — the ONE MemoryStream
// (plus MemoryStreamNetwork for router suites observing cross-stream
// forwards) — and `driveProcessor`, REAL runner drive over the in-memory
// journal: the shared form of the cutover suites' local `drive()` helpers.
// Registry-level harnesses (fake DurableObjectState, virtual clock, alarm
// cell, crash-as-eviction) live inline in the suites that need them
// (stream-processor-registry.test.ts, the per-domain *-recovery tests).

import { sameIdempotentEvent } from "./idempotency.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { StreamEventReadInput } from "./rpc-types.ts";
import type { ConsumedInput, ProcessorState } from "./processor-contracts.ts";
import type { ProcessorStream } from "./stream-handle.ts";
import type { StreamProcessor, StreamProcessorContract } from "./stream-processor.ts";
import type { ProcessorProgress, ProcessorProgressStore } from "./stream-processor-runner.ts";
import { StreamProcessorRunner } from "./stream-processor-runner.ts";

function emptyThroughputReport() {
  return {
    perSecond5s: 0,
    bytesPerSecond5s: 0,
    lastMinute: { count: 0, bytes: 0, perSecond: 0 },
    series: { counts: new Array(60).fill(0), bytes: new Array(60).fill(0) },
  };
}

/** The empty `runtimeState()` answer the test MemoryStream serves. */
function emptyStreamRuntimeState() {
  return {
    coreProcessorState: null,
    runtime: {
      connections: {},
      subscriptions: {},
      metrics: {
        measuredSince: new Date(0).toISOString(),
        reportedAt: new Date(0).toISOString(),
        ingress: emptyThroughputReport(),
        egress: emptyThroughputReport(),
      },
      storageSizeBytes: 0,
    },
  };
}

// Deliberately typed against the narrow ProcessorStream handle (what the
// machinery depends on), not the full generated `Stream` — the extra methods
// below (getEvent/getEvents/waitForEvent, runtime-state stubs) exist for test
// assertions and for suites that treat the double as a fuller stream.
export class MemoryStream implements ProcessorStream {
  events: StreamEvent[] = [];
  /** Injectable clock for createdAt stamps; harnesses point it at virtual time. */
  now: () => number = Date.now;
  /** Simulate a transient Stream DO outage: appends of this type throw. */
  failAppendsOfType: string | undefined;
  /** Set by MemoryStreamNetwork.get(); a detached stream answers `at()` with itself. */
  network: MemoryStreamNetwork | undefined;

  readonly path: string;

  constructor(path = "/agents/test") {
    this.path = path;
  }

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  async kill(): Promise<void> {}

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    // TWO-PHASE like the Stream DO: validate the whole batch against existing
    // AND same-batch state first, then publish — a failing input must not
    // leave earlier inputs committed (production batches are atomic).
    const staged: StreamEvent[] = [];
    const results: StreamEvent[] = [];
    // Next offset comes from the last event, not the array length — seeded
    // histories (e.g. stream-repros fixtures with bulk event types dropped)
    // have offset gaps.
    let nextOffset = (this.events.at(-1)?.offset ?? 0) + 1;
    for (const input of inputs) {
      if (input.type === this.failAppendsOfType) {
        throw new Error(`injected append failure for ${input.type}`);
      }
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : [...this.events, ...staged].find(
              (event) => event.idempotencyKey === input.idempotencyKey,
            );
      if (existing !== undefined) {
        // The Stream DO's predicate, SHARED: a same-key append with a
        // DIFFERENT body is REJECTED, not deduplicated. Key-only dedup here
        // once masked exactly that production rejection from a test.
        if (!sameIdempotentEvent(existing, input)) {
          throw new Error(
            `idempotency key "${input.idempotencyKey}" already names a different event at offset ${existing.offset}`,
          );
        }
        results.push(existing);
        continue;
      }
      const event: StreamEvent = {
        ...input,
        // Wall-clock like production, not offset-derived: expiry policy reads
        // createdAt, and epoch-1970 stamps would expire everything on arrival.
        createdAt: new Date(this.now()).toISOString(),
        offset: nextOffset++,
        path: this.path,
      };
      staged.push(event);
      results.push(event);
    }
    this.events.push(...staged);
    return results;
  }

  at(path?: string): MemoryStream {
    return path === undefined || this.network === undefined ? this : this.network.get(path);
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((event) => event.offset === input.offset);
    return this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(input: StreamEventReadInput = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    const beforeOffset = input.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.events
      .filter((event) => event.offset > afterOffset)
      .filter((event) => event.offset < beforeOffset)
      .filter(
        (event) =>
          input.eventTypes === undefined ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  readEvents(input: StreamEventReadInput = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      for (const event of this.events) {
        if (input.afterOffset !== undefined && event.offset <= input.afterOffset) continue;
        if (input.eventTypes !== undefined && !input.eventTypes.includes(event.type)) continue;
        if (input.predicate !== undefined && !(await input.predicate(event))) continue;
        return event;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for event");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return emptyStreamRuntimeState();
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }

  async acceptCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement acceptCrossPost().");
  }

  async crossPostTo(): Promise<never> {
    throw new Error("MemoryStream does not implement crossPostTo().");
  }

  async removeCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement removeCrossPost().");
  }
}

/**
 * In-memory network of streams keyed by path, so router tests can observe
 * the cross-stream forwards (`stream.at(path).append(...)`) next to
 * same-stream appends. `now` feeds every member stream's createdAt stamp, so
 * freshness-gated lanes (webhook ack horizons) can be tested on both sides
 * of the horizon. `eventsAt` never creates a stream — `network.streams.size`
 * assertions ("nothing was forwarded anywhere") stay honest.
 */
export class MemoryStreamNetwork {
  readonly streams = new Map<string, MemoryStream>();
  readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(path: string): MemoryStream {
    let stream = this.streams.get(path);
    if (stream === undefined) {
      stream = new MemoryStream(path);
      stream.network = this;
      stream.now = this.now;
      this.streams.set(path, stream);
    }
    return stream;
  }

  eventsAt(path: string): StreamEvent[] {
    return this.streams.get(path)?.events ?? [];
  }
}

/** What {@link driveProcessor} returns: REAL runner drive for one processor. */
type ProcessorDriver<Contract extends StreamProcessorContract> = {
  /** The driving runner, for tests that need its full surface. */
  runner: StreamProcessorRunner<Contract>;
  /** One catch-up pass to the journal's current head — the production
   * delivery cadence. Failures RETHROW with the cursor held, so a retry
   * redelivers the failed events exactly like the transport would. */
  deliver(): Promise<void>;
  /** The runner's committed fold (schema default until the first pass). */
  readonly state: ProcessorState<Contract>;
  /** One consistent read of the fold, pinned to its offset. */
  snapshot(): Promise<{ offset: number; state: ProcessorState<Contract> }>;
};

/**
 * REAL runner drive over an in-memory journal — the shared form of the
 * cutover suites' local `drive()` helpers: one StreamProcessorRunner per
 * processor (in-memory progress; a fresh driver over the same journal
 * replays from scratch, which is the refold recipe). The processor instance
 * holds no fold of its own — read `driver.state` / `driver.snapshot()`.
 */
export function driveProcessor<Contract extends StreamProcessorContract, Deps extends object>(
  processor: StreamProcessor<Contract, Deps>,
  stream: MemoryStream,
): ProcessorDriver<Contract> {
  const runner = new StreamProcessorRunner({ processor, stream });
  return {
    runner,
    deliver: () => runner.catchUp(),
    get state() {
      return runner.currentState;
    },
    snapshot: () => runner.snapshot(),
  };
}

/** The events of one type on a stream (or plain event array), in order. */
export function eventsOfType(source: MemoryStream | StreamEvent[], type: string): StreamEvent[] {
  const events = Array.isArray(source) ? source : source.events;
  return events.filter((event) => event.type === type);
}

// =============================================================================
// Step harness: scenario tests as ordered steps over a durable substrate.
// =============================================================================

/**
 * One scenario step. Three built-in kinds plus a function escape hatch:
 *
 * - `["append", ...events]` — typed appends (the contract's `consumes`
 *   vocabulary: what the outside world can put on this processor's stream);
 * - `["advanceTime", ms]` — move the virtual clock, releasing any harness
 *   `sleep(...)` calls that come due;
 * - `["crash"]` — abandon the incarnation like an eviction (runtime state and
 *   pending closures die; journal, progress, and clock survive);
 * - `async () => ...` — anything processor-specific (resolve a fake transport,
 *   assert mid-scenario).
 *
 * After every step the harness drives delivery to a fixpoint, so each step
 * observes the journal consequences of the previous one.
 */
export type HarnessStep<Contract extends StreamProcessorContract> =
  | readonly ["append", ...ConsumedInput<Contract>[]]
  | readonly ["advanceTime", number]
  | readonly ["crash"]
  | (() => unknown);

/** The durable substrate shared across incarnations (and zombie twins). */
export type HarnessSubstrate = {
  clock: { now: number };
  stream: MemoryStream;
  progress: ProcessorProgressStore<unknown>;
};

/** What {@link makeProcessorHarness}'s factory receives: base deps plus the
 * harness's virtual clock/sleep, for processors that take injectable time. */
export type HarnessProcessorDeps = {
  stream: ProcessorStream;
  path: string;
  projectId: string | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type ProcessorHarness<Contract extends StreamProcessorContract> = {
  clock: { now: number };
  stream: MemoryStream;
  substrate: HarnessSubstrate;
  /** The current incarnation's runner, for tests that need its full surface.
   * A method (not a property) so suites can spread the harness into a wider
   * object without freezing a pre-crash incarnation. */
  runner(): StreamProcessorRunner<Contract>;
  /** Run steps in order, driving delivery to a fixpoint after each. */
  play(...steps: HarnessStep<Contract>[]): Promise<void>;
  /** Typed append (the contract's `consumes` vocabulary) + drive to fixpoint. */
  append(...events: ConsumedInput<Contract>[]): Promise<void>;
  /** Advance the virtual clock, release due sleeps, drive to fixpoint. */
  advanceTime(ms: number): Promise<void>;
  /** Abandon this incarnation like an eviction; a fresh one takes over the
   * same journal/progress/clock. Does NOT deliver — the successor first acts
   * on the next step, exactly like a real revival. */
  crash(): void;
  /** Drive delivery to a fixpoint: repeated catch-up passes (with microtask
   * drains between them, so settled background work can land its appends)
   * until the journal head stops moving. */
  settle(): Promise<void>;
  /** The runner's committed fold. */
  state(): ProcessorState<Contract>;
  /** Committed journal rows, optionally filtered by event type. */
  events(type?: string): StreamEvent[];
};

/** In-memory {@link ProcessorProgressStore} with the DO store's fencing check,
 * so progress survives `crash()` into the successor incarnation. Exported so
 * suites can hand a harness a FRESH store over an existing journal — a full
 * replay from offset zero, which is both the refold recipe and the harshest
 * at-least-once redelivery test (every per-event append re-runs). */
export function makeMemoryProgressStore(): ProcessorProgressStore<unknown> {
  let record: ProcessorProgress<unknown> | undefined;
  return {
    read: () => (record === undefined ? undefined : structuredClone(record)),
    commit: (progress, opts) => {
      const persisted = record?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== persisted) {
        throw new Error(
          `progress commit fenced: expected revision ${opts.expectedCursorRevision}, persisted ${persisted}`,
        );
      }
      record = structuredClone(progress);
    },
  };
}

/**
 * Build a {@link ProcessorHarness}: REAL runner drive over the in-memory
 * substrate, with virtual time and eviction-faithful `crash()`. Knows nothing
 * about the processor under test — construct it in `createProcessor` from the
 * supplied base deps plus whatever fakes the suite owns (LLM transports,
 * capability hosts). Pass another harness's `substrate` to run a second
 * incarnation over the SAME journal (the zombie-race setup).
 */
export function makeProcessorHarness<Contract extends StreamProcessorContract>(args: {
  createProcessor: (deps: HarnessProcessorDeps) => StreamProcessor<Contract, object>;
  path?: string;
  substrate?: HarnessSubstrate;
}): ProcessorHarness<Contract> {
  const path = args.substrate?.stream.path ?? args.path ?? "/harness/processor";
  const clock = args.substrate?.clock ?? { now: 1_000_000 };
  const stream = args.substrate?.stream ?? new MemoryStream(path);
  stream.now = () => clock.now;
  const progress = args.substrate?.progress ?? makeMemoryProgressStore();
  const substrate: HarnessSubstrate = { clock, stream, progress };

  // Virtual sleeps: released when `advanceTime` moves the clock past their
  // deadline. A `crash()` drops the incarnation's pending sleeps unresolved —
  // the closures awaiting them are dead with the incarnation anyway.
  let pendingSleeps: { dueAt: number; resolve: () => void }[] = [];
  const releaseDueSleeps = () => {
    const [due, pending] = pendingSleeps.reduce<
      [{ resolve: () => void }[], { dueAt: number; resolve: () => void }[]]
    >(
      ([d, p], sleep) => (sleep.dueAt <= clock.now ? [[...d, sleep], p] : [d, [...p, sleep]]),
      [[], []],
    );
    pendingSleeps = pending;
    for (const sleep of due) sleep.resolve();
  };

  const incarnate = () => {
    const processor = args.createProcessor({
      stream,
      path,
      projectId: "proj_harness",
      now: () => clock.now,
      sleep: (ms) =>
        new Promise<void>((resolve) => pendingSleeps.push({ dueAt: clock.now + ms, resolve })),
    });
    return new StreamProcessorRunner({
      processor,
      stream,
      durability: { progress: progress as ProcessorProgressStore<ProcessorState<Contract>> },
      now: () => clock.now,
      readPageSize: 5,
    });
  };
  let runner = incarnate();

  const settle = async () => {
    // Fixpoint with a bounded round count: each round drains real microtasks
    // and macrotasks (so background work released by the previous round can
    // land its appends), then catches the runner up. Stop when a full round
    // leaves the journal head unchanged.
    for (let round = 0; round < 50; round++) {
      const headBefore = stream.events.at(-1)?.offset ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.catchUp();
      if ((stream.events.at(-1)?.offset ?? 0) === headBefore) return;
    }
    throw new Error("harness settle() did not reach a fixpoint in 50 rounds");
  };

  const append = async (...events: ConsumedInput<Contract>[]) => {
    await stream.append(...(events as StreamEventInput[]));
    await settle();
  };

  const advanceTime = async (ms: number) => {
    clock.now += ms;
    releaseDueSleeps();
    await settle();
  };

  const crash = () => {
    runner.dispose();
    pendingSleeps = [];
    runner = incarnate();
  };

  return {
    clock,
    stream,
    substrate,
    runner: () => runner,
    append,
    advanceTime,
    crash,
    settle,
    state: () => runner.currentState,
    events: (type?: string) =>
      type === undefined ? [...stream.events] : stream.events.filter((row) => row.type === type),
    async play(...steps: HarnessStep<Contract>[]) {
      for (const step of steps) {
        if (typeof step === "function") {
          await step();
          await settle();
        } else if (step[0] === "append") {
          const [, ...events] = step;
          await append(...events);
        } else if (step[0] === "advanceTime") {
          await advanceTime(step[1]);
        } else {
          crash();
        }
      }
    },
  };
}
