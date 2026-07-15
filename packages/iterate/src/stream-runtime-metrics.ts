// Pure latency-metrics primitives used by processor subscriber metrics.
// Everything here is clock-free and transport-free, so it is table-testable
// in plain node. The samples are in-memory and reset on eviction or reload.

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
    // Nearest-rank percentile (ceil(q·n) − 1): with few samples this reports
    // the WORST candidate rather than the best — a dashboard ring mostly
    // holds few samples, and a p95 that hides the spike is a lie.
    const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
    return {
      last: this.#last,
      p50: rank(0.5),
      p95: rank(0.95),
      samples: sorted.length,
      lastAt: this.#lastAt,
    };
  }
}
