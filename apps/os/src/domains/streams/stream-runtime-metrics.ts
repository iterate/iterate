// Pure runtime-metrics primitives for the stream and its subscribers.
//
// Everything here is clock-free and transport-free (timestamps are
// parameters, like subscriber-math.ts), so the rings and buckets are
// table-testable in plain node and shared verbatim by the Durable Object,
// the server processor host, and the browser store. All of it is in-memory
// observability — reset on eviction/reload by design; `measuredSince` tells
// readers how long the window has been collecting.

/** Serializable summary of a {@link LatencyRing}; `null` until a sample exists. */
export type LatencyStats = {
  /** Most recent sample (ms). */
  last: number;
  p50: number;
  p95: number;
  /** Samples currently in the ring (caps at the ring size). */
  samples: number;
  /** Epoch ms of the most recent sample. */
  lastAt: number;
};

/**
 * Fixed-capacity ring of latency samples. `stats()` is `null` until the first
 * sample — surfaces render "—" instead of a made-up number.
 */
export class LatencyRing {
  readonly #capacity: number;
  readonly #samples: number[] = [];
  #next = 0;
  #last = 0;
  #lastAt = 0;

  constructor(capacity = 32) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("LatencyRing capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  record(ms: number, atMs: number): void {
    if (!Number.isFinite(ms)) return;
    const sample = Math.max(0, Math.round(ms));
    if (this.#samples.length < this.#capacity) {
      this.#samples.push(sample);
    } else {
      this.#samples[this.#next] = sample;
    }
    this.#next = (this.#next + 1) % this.#capacity;
    this.#last = sample;
    this.#lastAt = atMs;
  }

  stats(): LatencyStats | null {
    if (this.#samples.length === 0) return null;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    return {
      last: this.#last,
      p50: sorted[Math.floor((sorted.length - 1) * 0.5)]!,
      p95: sorted[Math.floor((sorted.length - 1) * 0.95)]!,
      samples: sorted.length,
      lastAt: this.#lastAt,
    };
  }
}

/** One rolling-minute throughput window. */
export type MinuteWindow = {
  /** Events in the last 60 seconds. */
  count: number;
  /** Payload bytes in the last 60 seconds. */
  bytes: number;
  /** `count / 60` — the "events/s over the last minute" number. */
  perSecond: number;
};

/**
 * 60 one-second buckets of {count, bytes}. Stale slots (lapped by the ring)
 * are ignored at read time, so a burst followed by silence decays to zero
 * without a sweeper.
 */
export class MinuteBuckets {
  readonly #seconds = new Array<number>(60).fill(-1);
  readonly #counts = new Array<number>(60).fill(0);
  readonly #bytes = new Array<number>(60).fill(0);

  bump(atMs: number, count: number, bytes: number): void {
    const second = Math.floor(atMs / 1000);
    const slot = ((second % 60) + 60) % 60;
    if (this.#seconds[slot] !== second) {
      this.#seconds[slot] = second;
      this.#counts[slot] = 0;
      this.#bytes[slot] = 0;
    }
    this.#counts[slot]! += count;
    this.#bytes[slot]! += bytes;
  }

  lastMinute(nowMs: number): MinuteWindow {
    const nowSecond = Math.floor(nowMs / 1000);
    let count = 0;
    let bytes = 0;
    for (let slot = 0; slot < 60; slot += 1) {
      const second = this.#seconds[slot]!;
      if (second < 0 || second > nowSecond || second <= nowSecond - 60) continue;
      count += this.#counts[slot]!;
      bytes += this.#bytes[slot]!;
    }
    return { count, bytes, perSecond: count / 60 };
  }
}

/** What `runtimeState()` reports for the stream's own throughput. */
export type StreamThroughputMetrics = {
  /** ISO timestamp when this incarnation started measuring (metrics reset on eviction). */
  measuredSince: string;
  /** Appends committed (all producers). */
  ingressLastMinute: MinuteWindow;
  /** Deliveries dispatched (all lanes, all subscribers). */
  egressLastMinute: MinuteWindow;
};

/** The stream Durable Object's in-memory throughput accounting. */
export class StreamRuntimeMetrics {
  readonly #measuredSinceMs: number;
  readonly ingress = new MinuteBuckets();
  readonly egress = new MinuteBuckets();

  constructor(nowMs: number) {
    this.#measuredSinceMs = nowMs;
  }

  report(nowMs: number): StreamThroughputMetrics {
    return {
      measuredSince: new Date(this.#measuredSinceMs).toISOString(),
      ingressLastMinute: this.ingress.lastMinute(nowMs),
      egressLastMinute: this.egress.lastMinute(nowMs),
    };
  }
}

/**
 * The mutual ping's NTP-style math, shared by both requesters (the stream
 * pinging subscribers; anything pinging the stream). The requester stamps
 * `t0` and observes `t3`; the responder reports receive/reply-send times on
 * ITS clock. RTT excludes responder processing time; `clockOffsetMs`
 * estimates `responderClock - requesterClock`.
 */
export function pingRoundTrip(reply: { t0: number; t1: number; t2: number }, t3: number) {
  return {
    rttMs: Math.max(0, t3 - reply.t0 - (reply.t2 - reply.t1)),
    clockOffsetMs: (reply.t1 - reply.t0 + (reply.t2 - t3)) / 2,
  };
}
