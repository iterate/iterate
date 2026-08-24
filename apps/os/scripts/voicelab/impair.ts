// Deterministic network-impairment shim applied at each variant's transport
// touchpoints (stream appends/deliveries, or raw WS send/receive), so every
// topology degrades identically. Models what bad access networks do to a TCP
// stream: added one-way delay, jitter, and full stall windows that release in
// an ordered burst — never reordering, never silently dropping (TCP doesn't).
//
// Spec string: "tx=80,rx=80,jitter=40,stallEveryMs=10000,stallMs=1500,seed=1"
// (all optional; ms). Example profiles:
//   good wifi     tx=15,rx=15,jitter=5
//   bad wifi      tx=40,rx=40,jitter=60,stallEveryMs=7000,stallMs=400
//   awful         tx=120,rx=120,jitter=150,stallEveryMs=5000,stallMs=1800

/** Parsed impairment profile; zero-values mean pass-through. */
export interface ImpairSpec {
  txMs: number;
  rxMs: number;
  jitterMs: number;
  stallEveryMs: number;
  stallMs: number;
  seed: number;
}

export function parseImpairSpec(raw: string | undefined): ImpairSpec | null {
  if (!raw?.trim()) return null;
  const spec: ImpairSpec = { txMs: 0, rxMs: 0, jitterMs: 0, stallEveryMs: 0, stallMs: 0, seed: 1 };
  for (const part of raw.split(",")) {
    const [key, value] = part.split("=");
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`bad impair spec part: ${part}`);
    if (key === "tx") spec.txMs = n;
    else if (key === "rx") spec.rxMs = n;
    else if (key === "jitter") spec.jitterMs = n;
    else if (key === "stallEveryMs") spec.stallEveryMs = n;
    else if (key === "stallMs") spec.stallMs = n;
    else if (key === "seed") spec.seed = n;
    else throw new Error(`unknown impair key: ${key}`);
  }
  return spec;
}

/** mulberry32 — tiny seeded PRNG so impaired runs are reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One direction of an impaired pipe. schedule(fn) runs fn after the modeled
 * network delay, strictly in submission order (a delayed packet delays
 * everything behind it, like a real TCP stream).
 */
export class ImpairedLane {
  private random: () => number;
  private lastReleaseAt = 0;
  private startedAt = Date.now();

  constructor(
    private baseMs: number,
    private spec: ImpairSpec,
  ) {
    this.random = mulberry32(spec.seed + baseMs);
  }

  private delayFor(now: number): number {
    let delay = this.baseMs + this.random() * this.spec.jitterMs;
    if (this.spec.stallEveryMs > 0 && this.spec.stallMs > 0) {
      const phase = (now - this.startedAt) % this.spec.stallEveryMs;
      const untilStallEnd = this.spec.stallMs - phase;
      // Inside the recurring stall window: hold until the window ends.
      if (untilStallEnd > 0) delay += untilStallEnd;
    }
    return delay;
  }

  schedule(fn: () => void) {
    const now = Date.now();
    const releaseAt = Math.max(now + this.delayFor(now), this.lastReleaseAt);
    this.lastReleaseAt = releaseAt;
    const wait = releaseAt - now;
    if (wait <= 0) fn();
    else setTimeout(fn, wait);
  }
}

/** Impaired tx/rx pair for one transport; pass-through when spec is null. */
export function createImpairment(spec: ImpairSpec | null) {
  if (!spec) {
    return {
      tx: (fn: () => void) => fn(),
      rx: (fn: () => void) => fn(),
      describe: null as string | null,
    };
  }
  const txLane = new ImpairedLane(spec.txMs, spec);
  const rxLane = new ImpairedLane(spec.rxMs, spec);
  return {
    tx: (fn: () => void) => txLane.schedule(fn),
    rx: (fn: () => void) => rxLane.schedule(fn),
    describe: `tx=${spec.txMs} rx=${spec.rxMs} jitter=${spec.jitterMs} stall=${spec.stallMs}/${spec.stallEveryMs} seed=${spec.seed}`,
  };
}
