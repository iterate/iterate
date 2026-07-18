type StreamAlarmStorage = Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">;

/**
 * Serialized owner of the Stream Durable Object's one shared alarm.
 *
 * Delivery rows and in-memory attempt watchdogs decide the desired deadline;
 * this class makes the platform alarm match it without racing overlapping
 * get/set/delete sequences. Failed writes invalidate the cache so the next
 * update re-reads durable state.
 */
export class StreamAlarm {
  readonly #storage: StreamAlarmStorage;
  readonly #keepAlive: (promise: Promise<unknown>) => void;
  #knownAtMs: number | null | undefined;
  #chain = Promise.resolve();

  constructor(args: {
    storage: StreamAlarmStorage;
    keepAlive: (promise: Promise<unknown>) => void;
  }) {
    this.#storage = args.storage;
    this.#keepAlive = args.keepAlive;
  }

  /** Move the platform alarm earlier if necessary; never move it later. */
  armNoLaterThan(atMs: number): Promise<void> {
    return this.#enqueue((current) => (current === null || atMs < current ? atMs : current));
  }

  /** Set the exact alarm desired after scanning every delivery obligation. */
  repoint(atMs: number | null): Promise<void> {
    return this.#enqueue(() => atMs);
  }

  /** Record that the platform consumed the alarm entering the current handler. */
  async fired(): Promise<void> {
    await this.#chain;
    // A constructor-side wake may already have armed a successor before the
    // alarm handler starts. Invalidate instead of asserting null so the next
    // operation re-reads and preserves that successor.
    this.#knownAtMs = undefined;
  }

  #enqueue(desired: (current: number | null) => number | null): Promise<void> {
    const step = this.#chain.then(async () => {
      const current =
        this.#knownAtMs === undefined ? await this.#storage.getAlarm() : this.#knownAtMs;
      const next = desired(current);
      if (next === current) {
        this.#knownAtMs = current;
        return;
      }
      if (next === null) await this.#storage.deleteAlarm();
      else await this.#storage.setAlarm(next);
      this.#knownAtMs = next;
    });
    const result = step.catch((error) => {
      this.#knownAtMs = undefined;
      throw error;
    });
    // One failed platform operation must not poison every later alarm update.
    this.#chain = result.catch(() => undefined);
    this.#keepAlive(result.catch(() => undefined));
    return result;
  }
}
