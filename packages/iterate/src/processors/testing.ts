// In-memory test doubles for the stream substrate — the ONE MemoryStream
// (plus MemoryStreamNetwork for router suites observing cross-stream
// forwards) — and `driveProcessor`, REAL runner drive over the in-memory
// journal: the shared form of the cutover suites' local `drive()` helpers.
// Registry-level harnesses (fake DurableObjectState, virtual clock, alarm
// cell, crash-as-eviction) live inline in the suites that need them
// (stream-processor-registry.test.ts, the per-domain *-recovery tests).

import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { StreamEventReadInput } from "./rpc-types.ts";
import type { ProcessorState } from "./processor-contracts.ts";
import type { ProcessorStream } from "./stream-handle.ts";
import type { StreamProcessor, StreamProcessorContract } from "./stream-processor.ts";
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
        // Mirror the Stream DO's `sameIdempotentEvent`: a same-key append with
        // a DIFFERENT body is REJECTED, not deduplicated. Key-only dedup here
        // once masked exactly that production rejection from a test.
        const same =
          existing.type === input.type &&
          jsonValuesEqual(existing.payload, input.payload) &&
          jsonValuesEqual(existing.metadata, input.metadata) &&
          existing.ephemeral === input.ephemeral;
        if (!same) {
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

/** Structural JSON equality (key-order-insensitive) — the Stream DO's idempotency compare. */
function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    );
  }
  return false;
}
