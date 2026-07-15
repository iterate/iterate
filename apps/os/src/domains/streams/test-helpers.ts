// In-memory test doubles for the stream substrate — the ONE MemoryStream
// (plus MemoryStreamNetwork for router suites observing cross-stream
// forwards and deliverNewEvents for cursor-based pull delivery) — plus the
// processor-host harness: REAL host code (createStreamProcessorHost —
// keepalive, alarm slices, revival, catch-up) and REAL processors running in
// plain node against a fake DurableObjectState, an in-memory journal, and a
// mutable clock. Lifecycle failure is a first-class operator: `crash()`
// kills the incarnation exactly the way an eviction does — in-memory state
// and in-flight work die, the journal, KV, and the durable alarm survive.
//
// Runtime state is produced by LIFECYCLE, never by field injection: an empty
// live-execution set IS "crashed mid-attempt", reached by crashing; a
// populated one IS "attempt in flight", reached by handing a processor a
// vendor fake that hasn't resolved yet. Every state a test exercises is
// therefore a reachable state, and the test doubles as the existence proof.

import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { StreamAppendResultOptions } from "./rpc-types.ts";
import type { AnyHostedProcessor } from "./processor-host-capabilities.ts";
import { createStreamProcessorHost, type StreamProcessorHost } from "./stream-processor-host.ts";

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

function createMemoryStreamAppend(
  commit: (...inputs: StreamEventInput[]) => StreamEvent[] | Promise<StreamEvent[]>,
): Stream["append"] {
  return async (...args) => {
    const first = args[0];
    const options: StreamAppendResultOptions | undefined =
      typeof first === "object" && first !== null && !("type" in first) && "return" in first
        ? first
        : undefined;
    const inputs = (options === undefined ? args : args.slice(1)) as StreamEventInput[];
    const events = await commit(...inputs);
    if (options?.return === "events") return events;
    if (options?.return === "offsets") return events.map((event) => event.offset);
    return undefined;
  };
}

export async function appendTestEvents(
  stream: Pick<Stream, "append">,
  ...events: StreamEventInput[]
): Promise<StreamEvent[]> {
  const result = await stream.append({ return: "events" }, ...events);
  if (!Array.isArray(result) || result.some((value) => typeof value !== "object")) {
    throw new Error("append did not return events");
  }
  return result as StreamEvent[];
}

export class MemoryStream implements Stream {
  events: StreamEvent[] = [];
  /** Injectable clock for createdAt stamps; harnesses point it at virtual time. */
  now: () => number = Date.now;
  /** Simulate a transient Stream DO outage: appends of this type throw. */
  failAppendsOfType: string | undefined;
  /** Set by MemoryStreamNetwork.get(); a detached stream answers `at()` with itself. */
  network: MemoryStreamNetwork | undefined;

  constructor(readonly path = "/agents/test") {}

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  async kill(): Promise<void> {}

  append = createMemoryStreamAppend((...inputs) => this.#appendEvents(...inputs));

  async #appendEvents(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    const appended = inputs.map((input) => {
      if (input.type === this.failAppendsOfType) {
        throw new Error(`injected append failure for ${input.type}`);
      }
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      // Next offset comes from the last event, not the array length — seeded
      // histories (e.g. stream-repros fixtures with bulk event types dropped)
      // have offset gaps.
      const offset = (this.events.at(-1)?.offset ?? 0) + 1;
      const event: StreamEvent = {
        ...input,
        // Wall-clock like production, not offset-derived: expiry policy reads
        // createdAt, and epoch-1970 stamps would expire everything on arrival.
        createdAt: new Date(this.now()).toISOString(),
        offset,
        path: this.path,
      };
      this.events.push(event);
      return event;
    });
    return appended;
  }

  at(path?: string): Stream {
    return path === undefined || this.network === undefined ? this : this.network.get(path);
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((event) => event.offset === input.offset);
    return this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
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

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
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

  async head() {
    return {
      createdAt: this.events[0]?.createdAt,
      maxOffset: this.events.at(-1)?.offset ?? 0,
    };
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

  constructor(readonly now: () => number = Date.now) {}

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

type ProcessorLike = {
  ingest(input: { events: StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

/** Cursor-based pull delivery mirroring production subscription semantics. */
export async function deliverNewEvents(input: {
  processor: ProcessorLike;
  stream: MemoryStream;
  cursors: Map<object, number>;
}) {
  const cursor = input.cursors.get(input.processor) ?? 0;
  const events = input.stream.events.slice(cursor);
  input.cursors.set(input.processor, input.stream.events.length);
  if (events.length === 0) return;
  const streamMaxOffset = input.stream.events.at(-1)?.offset ?? 0;
  await input.processor.ingest({ events, streamMaxOffset });
}

/**
 * The standard processor-suite preamble in one call: a MemoryStreamNetwork
 * (pass `now` to pin the virtual clock), the stream at `path`, the processor
 * built over that stream, one cursors map, and `deliver()` — cursor-based
 * pull delivery mirroring production subscription semantics. Refold tests
 * hand the replacement processor to `deliver(refolded)`: a fresh processor
 * has no cursor yet, so it replays the whole journal.
 */
export function makeProcessorHarness<Processor extends ProcessorLike>(options: {
  build: (ctx: { network: MemoryStreamNetwork; stream: MemoryStream }) => Processor;
  path?: string;
  now?: () => number;
}) {
  const network = new MemoryStreamNetwork(options.now);
  const stream = network.get(options.path ?? "/agents/test");
  const processor = options.build({ network, stream });
  const cursors = new Map<object, number>();
  return {
    cursors,
    network,
    processor,
    stream,
    deliver(target: ProcessorLike = processor) {
      return deliverNewEvents({ cursors, processor: target, stream });
    },
  };
}

/** The events of one type on a stream (or plain event array), in order. */
export function eventsOfType(source: MemoryStream | StreamEvent[], type: string): StreamEvent[] {
  const events = Array.isArray(source) ? source : source.events;
  return events.filter((event) => event.type === type);
}

/** The durable substrate an eviction does NOT destroy. */
export type FakeDurableStore = {
  kv: Map<string, unknown>;
  alarm: { at: number | null };
  /** waitUntil'd work of the CURRENT incarnation; crash() abandons it. */
  pending: Promise<unknown>[];
};

/** The slice of DurableObjectState the processor host touches, over an
 * in-memory store. Reads/writes are synchronous like production DO KV. */
function fakeDurableObjectState(store: FakeDurableStore): DurableObjectState {
  return {
    storage: {
      kv: {
        get: (key: string) => store.kv.get(key),
        put: (key: string, value: unknown) => {
          store.kv.set(key, value);
        },
      },
      getAlarm: async () => store.alarm.at,
      setAlarm: async (at: number | Date) => {
        store.alarm.at = typeof at === "number" ? at : at.getTime();
      },
      deleteAlarm: async () => {
        store.alarm.at = null;
      },
    },
    waitUntil: (promise: Promise<unknown>) => {
      store.pending.push(promise.catch(() => undefined));
    },
  } as unknown as DurableObjectState;
}

export type ProcessorHostHarness<Processors> = {
  stream: MemoryStream;
  /** Mutable virtual clock (epoch ms) driving the host, expiry, and backoff. */
  clock: { now: number };
  store: FakeDurableStore;
  readonly host: StreamProcessorHost;
  readonly processors: Processors;
  /** Which incarnation is live (1-based). */
  readonly incarnation: number;
  /**
   * Evict the incarnation: host, processors, live executions, timers, and
   * pending waitUntil work die (stray closures that fire later hit a fenced
   * stream and fail); the journal, KV checkpoints, and the durable alarm
   * survive. The next property access serves the fresh incarnation.
   */
  crash(): void;
  /** Pull-deliver pending events to every processor (real host catchUp). */
  deliverAll(): Promise<void>;
  /**
   * Advance virtual time, firing the durable alarm through the REAL
   * handleAlarm path whenever it comes due within the window — the whole
   * keepalive/revival/breaker machinery runs live.
   */
  advance(ms: number): Promise<void>;
};

/** What the per-incarnation `build` callback receives alongside the host. */
type HarnessBuildContext = {
  incarnation: number;
  /** The harness's virtual clock — wire it into processor `now` deps. */
  clock: { now: number };
  /** The incarnation-FENCED stream — wire it into deps like readStreamEvents
   * so a dead incarnation's stray reads fail exactly like its writes. */
  stream: Stream;
};

/**
 * Boot REAL host + REAL processors over fake substrates. `build` runs once
 * per incarnation and must register every processor on the given host; vary
 * vendor fakes by incarnation via the context it receives.
 */
export function createProcessorHostHarness<
  Processors extends Record<string, AnyHostedProcessor>,
>(options: {
  build: (host: StreamProcessorHost, ctx: HarnessBuildContext) => Processors;
  path?: string;
  version?: string | (() => string);
  /** Shrink the catch-up page size to exercise mid-catch-up batches. */
  catchUpPageSize?: number;
}): ProcessorHostHarness<Processors> {
  const clock = { now: Date.parse("2026-07-09T12:00:00Z") };
  const stream = new MemoryStream(options.path ?? "/agents/test");
  stream.now = () => clock.now;
  const store: FakeDurableStore = { kv: new Map(), alarm: { at: null }, pending: [] };

  let incarnation = 0;
  let host: StreamProcessorHost;
  let processors: Processors;
  const boot = () => {
    incarnation += 1;
    const mine = incarnation;
    // The fence: a dead incarnation's stray closures (a debounce timer, a
    // hung vendor call resolving late) must not reach the journal — exactly
    // as an evicted isolate cannot. Reads and writes both throw once a newer
    // incarnation booted.
    const fencedStream = new Proxy(stream, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (incarnation !== mine) {
            throw new Error(`stream call from evicted incarnation ${mine}`);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as Stream;
    host = createStreamProcessorHost(fakeDurableObjectState(store), {
      stream: fencedStream,
      path: stream.path,
      projectId: null,
      version:
        (typeof options.version === "function" ? options.version() : options.version) ?? "v-test",
      now: () => clock.now,
      catchUpPageSize: options.catchUpPageSize,
    });
    processors = options.build(host, { incarnation: mine, clock, stream: fencedStream });
  };
  boot();

  return {
    stream,
    clock,
    store,
    get host() {
      return host;
    },
    get processors() {
      return processors;
    },
    get incarnation() {
      return incarnation;
    },
    crash() {
      store.pending = [];
      boot();
    },
    async deliverAll() {
      for (const processor of Object.values(processors)) {
        await host.catchUp(processor.contract.slug);
      }
    },
    async advance(ms: number) {
      const target = clock.now + ms;
      while (store.alarm.at !== null && store.alarm.at <= target) {
        clock.now = Math.max(clock.now, store.alarm.at);
        store.alarm.at = null; // the platform consumes the alarm by firing it
        await host.handleAlarm();
      }
      clock.now = target;
    },
  };
}
