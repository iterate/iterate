// In-memory test doubles for the stream substrate — the ONE MemoryStream
// (plus MemoryStreamNetwork for router suites observing cross-stream
// forwards). The generic step harness drives the real runner over that
// in-memory stream.
// Step tuples form scenario spines; `h.append`/`h.advanceTime` settle single
// actions, while `h.stream.append` commits without driving delivery.
// Every harness uses the production DO durability adapters over in-memory KV
// plus an alarm cell, so eviction and revival have one meaning in every suite.

import {
  durableObjectProgressStore,
  durableObjectRecovery,
} from "./durable-object-processor-durability.ts";
import { idempotencyConflictMessage, sameIdempotentEvent } from "./idempotency.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { StreamEventReadInput } from "./rpc-types.ts";
import type { ConsumedInput, ProcessorState, ResolvedEvent } from "./processor-contracts.ts";
import type { RegisteredProcessorReads } from "./stream-processor-registry.ts";
import type { ProcessorStream } from "./stream-handle.ts";
import type { StreamProcessor, StreamProcessorContract } from "./stream-processor.ts";
import type { ProcessorProgressStore } from "./stream-processor-runner.ts";
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
      sending: {},
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
  streamId = crypto.randomUUID();
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
      // The casts restate what the round-trip preserves: serializing a
      // `Record<string, unknown>` yields a JSON object, so parsing it back
      // yields one — `JSON.parse` just types as `any` and cannot say so.
      const detachedInput: StreamEventInput = {
        ...input,
        ...(!input.payload
          ? {}
          : { payload: JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown> }),
        ...(!input.metadata
          ? {}
          : { metadata: JSON.parse(JSON.stringify(input.metadata)) as Record<string, unknown> }),
      };
      const existing = !detachedInput.idempotencyKey
        ? undefined
        : [...this.events, ...staged].find(
            (event) => event.idempotencyKey === detachedInput.idempotencyKey,
          );
      if (existing && detachedInput.idempotencyKey) {
        // The Stream DO's predicate, SHARED: a same-key append with a
        // DIFFERENT body is REJECTED, not deduplicated. Key-only dedup here
        // once masked exactly that production rejection from a test.
        if (!sameIdempotentEvent(existing, detachedInput)) {
          throw new Error(
            idempotencyConflictMessage(detachedInput.idempotencyKey, existing.offset),
          );
        }
        results.push(existing);
        continue;
      }
      const event: StreamEvent = {
        ...detachedInput,
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

  appendIfStreamId(args: { streamId: string; events: StreamEventInput[] }): Promise<StreamEvent[]> {
    if (args.streamId !== this.streamId) {
      throw new Error(`stream ID changed (${args.streamId} -> ${this.streamId}); append rejected`);
    }
    return this.append(...args.events);
  }

  at(path?: string): MemoryStream {
    return !path || !this.network ? this : this.network.get(path);
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
          !input.eventTypes ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  async getEventPage(input: StreamEventReadInput = {}) {
    return {
      streamId: this.streamId,
      streamMaxOffset: this.events.at(-1)?.offset ?? 0,
      events: await this.getEvents(input),
    };
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
        if (Number.isFinite(input.afterOffset) && event.offset <= input.afterOffset) continue;
        if (input.eventTypes && !input.eventTypes.includes(event.type)) continue;
        if (input.predicate && !(await input.predicate(event))) continue;
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
}

/**
 * In-memory network of streams keyed by path, so router tests can observe
 * the cross-stream forwards (`stream.at(path).append(...)`) next to
 * same-stream appends. `now` feeds every member stream's createdAt stamp, so
 * freshness checks (such as webhook acknowledgement horizons) can be tested on both sides
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
    if (!stream) {
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
 *   pending closures die; stream, progress, and clock survive);
 * - `async () => ...` — anything processor-specific (resolve a fake transport,
 *   assert mid-scenario).
 *
 * After every step the harness drives delivery to a fixpoint, so each step
 * observes the stream consequences of the previous one.
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

type HarnessDurabilitySubstrate = {
  storage: DurableObjectStorage;
  alarm: { at: number | null };
};

const durabilitySubstrates = new WeakMap<HarnessSubstrate, HarnessDurabilitySubstrate>();
const progressSubstrates = new WeakMap<object, HarnessDurabilitySubstrate>();

function makeDurabilitySubstrate(): HarnessDurabilitySubstrate {
  const kv = new Map<string, unknown>();
  // `null as number | null` widens the literal so later `alarm.at = 123`
  // assignments typecheck — an annotated `let` can't live in an object field.
  const alarm = { at: null as number | null };
  const storage = {
    kv: {
      // The map stores whatever the caller `put` under the key; `get<T>`
      // mirrors the platform API's caller-asserted typing (the real
      // DurableObjectStorage.kv.get is exactly this trust), so the cast
      // restates the platform contract, not a new claim.
      get: <T = unknown>(key: string): T | undefined =>
        kv.has(key) ? (structuredClone(kv.get(key)) as T) : undefined,
      put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
      delete: (key: string) => kv.delete(key),
    },
    getAlarm: async () => alarm.at,
    setAlarm: async (at: number) => {
      alarm.at = at;
    },
    deleteAlarm: async () => {
      alarm.at = null;
    },
    // Double assertion because this implements only the members the keepalive
    // and progress adapters touch (kv get/put/delete, get/set/deleteAlarm) — the
    // platform type's dozens of other members (sql, transactions, bookmarks)
    // are structurally missing on purpose. Safe for every consumer HERE
    // because the adapters' member usage is pinned by these suites; a new
    // adapter dependency would throw undefined-is-not-a-function loudly.
  } as unknown as DurableObjectStorage;
  return { storage, alarm };
}

/** What {@link makeProcessorHarness}'s factory receives: base deps plus the
 * harness's virtual clock/sleep, for processors that take injectable time. */
export type HarnessProcessorDeps<Contract extends StreamProcessorContract> = {
  stream: ProcessorStream;
  path: string;
  projectId: string | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  reads: Pick<RegisteredProcessorReads<ProcessorState<Contract>>, "snapshot" | "waitUntilEvent">;
};

export type ProcessorHarness<
  Contract extends StreamProcessorContract,
  Processor extends StreamProcessor<Contract, object> = StreamProcessor<Contract, object>,
> = {
  clock: { now: number };
  stream: MemoryStream;
  substrate: HarnessSubstrate;
  /** The current incarnation's runner, for tests that need its full surface.
   * A method (not a property) so suites can spread the harness into a wider
   * object without freezing a pre-crash incarnation. */
  runner(): StreamProcessorRunner<Contract>;
  /** The current incarnation's processor instance. */
  processor(): Processor;
  /** Run steps in order, driving delivery to a fixpoint after each. */
  play(...steps: HarnessStep<Contract>[]): Promise<void>;
  /** Typed append (the contract's `consumes` vocabulary) + drive to fixpoint. */
  append(...events: ConsumedInput<Contract>[]): Promise<void>;
  /** Advance the virtual clock, release due sleeps, drive to fixpoint. */
  advanceTime(ms: number): Promise<void>;
  /** Abandon this incarnation like an eviction; a fresh one takes over the
   * same stream/progress/clock. Does NOT deliver — the successor first acts
   * on the next step, exactly like a real revival. */
  crash(): void;
  /** Drive delivery to a fixpoint: repeated catch-up passes (with microtask
   * drains between them, so settled background work can land its appends)
   * until the stream head stops moving. */
  settle(): Promise<void>;
  /** The runner's committed reduced state. */
  state(): ProcessorState<Contract>;
  /** All committed stream rows. */
  events(): StreamEvent[];
  /** Committed rows of one event type, typed when the contract resolves it. */
  events<Type extends string>(type: Type): ResolvedEvent<Contract, Type>[];
};

/** In-memory {@link ProcessorProgressStore} with the DO store's fencing check,
 * so progress survives `crash()` into the successor incarnation. Exported so
 * suites can hand a harness a FRESH store over an existing stream — a full
 * replay from offset zero, which is both the re-reduce-from-scratch recipe and the harshest
 * at-least-once redelivery test (every per-event append re-runs).
 *
 * The contract is required because progress and recovery share the same
 * per-processor Durable Object keys. A generic placeholder slug would let the
 * runner commit progress under one key while recovery looks under another.
 */
export function makeMemoryProgressStore(
  contract: Pick<StreamProcessorContract, "slug">,
): ProcessorProgressStore<unknown> {
  const durability = makeDurabilitySubstrate();
  const progress = durableObjectProgressStore<unknown>({
    storage: durability.storage,
    name: contract.slug,
  });
  progressSubstrates.set(progress, durability);
  return progress;
}

/**
 * Build a {@link ProcessorHarness}: the real runner, ProcessorKeepalive, and
 * Durable Object durability adapters over an in-memory stream/KV/alarm
 * substrate. `crash()` is eviction: delivery stays detached until a new
 * append wakes it or a due keepalive alarm appends the revival fact. Pass
 * another harness's `substrate` to run a second incarnation over the same
 * durable state (the zombie-race setup).
 */
export function makeProcessorHarness<
  Contract extends StreamProcessorContract,
  Processor extends StreamProcessor<Contract, object> = StreamProcessor<Contract, object>,
>(args: {
  createProcessor: (deps: HarnessProcessorDeps<Contract>) => Processor;
  path?: string;
  substrate?: HarnessSubstrate;
}): ProcessorHarness<Contract, Processor> {
  const path = args.substrate?.stream.path ?? args.path ?? "/harness/processor";
  const clock = args.substrate?.clock ?? { now: 1_000_000 };
  const stream = args.substrate?.stream ?? new MemoryStream(path);
  stream.now = () => clock.now;
  const inheritedDurability = !args.substrate
    ? undefined
    : (durabilitySubstrates.get(args.substrate) ?? progressSubstrates.get(args.substrate.progress));
  const durability = inheritedDurability ?? makeDurabilitySubstrate();

  // The substrate stores progress as `<unknown>` so one substrate type serves
  // every contract; the narrowing is safe because a substrate is only ever
  // shared between incarnations of the SAME processor (the zombie-race
  // setup), so the state it holds is this contract's. TypeScript cannot carry
  // the contract through the untyped substrate hand-off.
  let progress = args.substrate?.progress as
    | ProcessorProgressStore<ProcessorState<Contract>>
    | undefined;
  let pendingSleeps: { dueAt: number; resolve: () => void }[] = [];
  const releaseDueSleeps = () => {
    const due = pendingSleeps.filter((sleep) => sleep.dueAt <= clock.now);
    pendingSleeps = pendingSleeps.filter((sleep) => sleep.dueAt > clock.now);
    for (const sleep of due) sleep.resolve();
    return due.length;
  };

  let processor!: Processor;
  let runner!: StreamProcessorRunner<Contract>;
  let recovery!: ReturnType<typeof durableObjectRecovery>;
  let incarnation = 0;
  let deliveryEnabled = true;
  let deliveryAttempt: Promise<void> | undefined;
  let deliveryError: unknown;

  const keepAlive = (work: Promise<unknown>) => {
    void work.catch(() => undefined);
  };
  const incarnate = () => {
    processor = args.createProcessor({
      stream,
      path,
      projectId: "proj_harness",
      now: () => clock.now,
      sleep: (ms) =>
        new Promise<void>((resolve) => pendingSleeps.push({ dueAt: clock.now + ms, resolve })),
      reads: {
        snapshot: () => runner.snapshot(),
        waitUntilEvent: (input) =>
          "offset" in input ? runner.waitUntilEvent(input) : runner.waitUntilEvent(input),
      },
    });
    progress ??= durableObjectProgressStore<ProcessorState<Contract>>({
      storage: durability.storage,
      name: processor.contract.slug,
    });
    recovery = durableObjectRecovery({
      storage: durability.storage,
      name: processor.contract.slug,
      stream,
      version: "test-harness",
      armAlarm: (atMs) => {
        if (!Number.isFinite(atMs)) void durability.storage.deleteAlarm();
        else void durability.storage.setAlarm(atMs);
      },
      waitUntil: keepAlive,
      now: () => clock.now,
    });
    runner = new StreamProcessorRunner({
      processor,
      stream,
      durability: { progress, recovery },
      keepAlive: (work) => keepAlive(work()),
      now: () => clock.now,
      readPageSize: 5,
    });
  };
  incarnate();

  const substrate: HarnessSubstrate = {
    clock,
    stream,
    // Inverse of the narrowing above: the substrate's public face erases the
    // contract (stores are invariant in their state parameter, so neither
    // direction is assignable without the assertion pair).
    progress: progress as ProcessorProgressStore<unknown>,
  };
  if (args.substrate) durabilitySubstrates.set(args.substrate, durability);
  durabilitySubstrates.set(substrate, durability);
  progressSubstrates.set(substrate.progress, durability);

  const startDelivery = () => {
    if (deliveryAttempt) return;
    const deliveryIncarnation = incarnation;
    const attempt = runner.catchUp();
    deliveryAttempt = attempt;
    void attempt.then(
      () => {
        if (deliveryIncarnation === incarnation) deliveryAttempt = undefined;
      },
      (error: unknown) => {
        if (deliveryIncarnation !== incarnation) return;
        deliveryAttempt = undefined;
        deliveryError = error;
      },
    );
  };

  const settle = async () => {
    // Fixpoint with a bounded round count: each round drains real microtasks
    // and macrotasks so background work can append, then catches the runner up.
    let quietRounds = 0;
    let lastAppendedTypes: string[] = [];
    for (let round = 0; round < 50; round++) {
      const headBefore = stream.events.at(-1)?.offset ?? 0;
      const releasedSleeps = releaseDueSleeps();
      if (deliveryEnabled) startDelivery();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (deliveryError) {
        const error = deliveryError;
        deliveryError = undefined;
        throw error;
      }
      const headAfter = stream.events.at(-1)?.offset ?? 0;
      lastAppendedTypes = stream.events
        .filter((event) => event.offset > headBefore)
        .map((event) => event.type);
      quietRounds = headAfter === headBefore && releasedSleeps === 0 ? quietRounds + 1 : 0;
      // An alarm-backed attempt may be intentionally hung so the next crash
      // can evict it. Once the stream is quiet and its durable recovery alarm
      // is armed, that parked attempt is a stable scenario boundary.
      if (
        quietRounds === 3 &&
        (!deliveryEnabled || !deliveryAttempt || Number.isFinite(durability.alarm.at))
      ) {
        return;
      }
    }
    const headOffset = stream.events.at(-1)?.offset ?? 0;
    throw new Error(
      `harness settle() did not reach a fixpoint in 50 rounds; ` +
        `last round appended event types: ${lastAppendedTypes.join(", ") || "none"}; ` +
        `head offset: ${headOffset}`,
    );
  };

  const append = async (...events: ConsumedInput<Contract>[]) => {
    // A consumed input IS a stream event input — the contract type only
    // narrows `type`/`payload` to the consumed vocabulary. TypeScript cannot
    // relate the distributive contract-derived union back to the plain input
    // shape, so the widening is asserted.
    await stream.append(...(events as StreamEventInput[]));
    deliveryEnabled = true;
    await settle();
  };

  const advanceTime = async (ms: number) => {
    const target = clock.now + ms;
    while (Number.isFinite(durability.alarm.at) && durability.alarm.at <= target) {
      clock.now = Math.max(clock.now, durability.alarm.at);
      durability.alarm.at = null;
      await recovery.handleAlarm();
      deliveryEnabled = true;
      await settle();
    }
    clock.now = target;
    await settle();
  };

  const crash = () => {
    runner.dispose();
    incarnation += 1;
    deliveryEnabled = false;
    deliveryAttempt = undefined;
    deliveryError = undefined;
    pendingSleeps = [];
    incarnate();
  };

  return {
    clock,
    stream,
    substrate,
    runner: () => runner,
    processor: () => processor,
    append,
    advanceTime,
    crash,
    settle,
    state: () => runner.currentState,
    // TypeScript cannot check an implementation arrow against an overload
    // pair, so the assertion is unavoidable. Soundness is the same claim the
    // typed read surface makes everywhere: rows filtered to `type` carry that
    // type's contract payload — committed rows are trusted, not re-parsed,
    // exactly like production reads.
    events: ((type?: string) =>
      !type
        ? [...stream.events]
        : stream.events.filter((row) => row.type === type)) as ProcessorHarness<
      Contract,
      Processor
    >["events"],
    async play(...steps: HarnessStep<Contract>[]) {
      for (const [index, step] of steps.entries()) {
        const kind = typeof step === "function" ? "function" : step[0];
        try {
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
        } catch (error) {
          throw new Error(`harness play() step ${index} (${kind}) failed`, { cause: error });
        }
      }
    },
  };
}
