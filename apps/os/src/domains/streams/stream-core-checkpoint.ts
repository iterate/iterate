const CHECKPOINT_EVERY_EVENTS = 64;
const CHECKPOINT_MAX_LAG_MS = 1_000;

/** Tracks the bounded lag of the stream core-state rebuild accelerator. */
export class CoreCheckpointSchedule {
  #dirty = false;
  #eventsSinceCheckpoint = 0;
  #windowStartedAtMs: number;

  constructor(args: { nowMs: number }) {
    this.#windowStartedAtMs = args.nowMs;
  }

  get needsFlush(): boolean {
    return this.#dirty;
  }

  /**
   * Restores offset-derived lag after loading and catching up a current checkpoint.
   * Any replayed suffix is flushed at this activation boundary: carrying it
   * across repeated abnormal restarts makes each incarnation replay the prior
   * incarnations' `woken` facts as well.
   */
  restoreLag(args: { eventCount: number; nowMs: number }): boolean {
    this.#eventsSinceCheckpoint = args.eventCount;
    this.#dirty = args.eventCount > 0;
    this.#windowStartedAtMs = args.nowMs;
    return this.#dirty;
  }

  /** Records newly committed events and reports whether the checkpoint is due. */
  record(args: { eventCount: number; nowMs: number }): boolean {
    this.#eventsSinceCheckpoint += args.eventCount;
    this.#dirty = true;
    return (
      this.#eventsSinceCheckpoint >= CHECKPOINT_EVERY_EVENTS ||
      args.nowMs - this.#windowStartedAtMs >= CHECKPOINT_MAX_LAG_MS
    );
  }

  didWrite(nowMs: number): void {
    this.#dirty = false;
    this.#eventsSinceCheckpoint = 0;
    this.#windowStartedAtMs = nowMs;
  }
}
