type StreamAlarmStorage = Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">;

/**
 * One serialized owner for the stream Durable Object's shared alarm.
 *
 * Delivery rows hold the durable retry/watchdog intent; this class only makes
 * the platform alarm match that intent. Calls are serialized because two
 * getAlarm/setAlarm pairs may otherwise both observe the same old value and
 * let the later write move the alarm in the wrong direction. The cached value
 * becomes authoritative only after the platform write succeeds, and any
 * failure invalidates it so the next call reads storage again.
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

  /** Set the exact alarm desired after scanning every durable cursor row. */
  repoint(atMs: number | null): Promise<void> {
    return this.#enqueue(() => atMs);
  }

  /** The platform consumed the alarm which entered the current handler. */
  async fired(): Promise<void> {
    await this.#chain;
    // Consumption tells us only that the firing deadline is gone. Invalidate
    // rather than asserting `null`: another arm may already have landed at the
    // storage boundary before this handler projects the cursor rows again.
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
    // A failed update must not wedge later updates behind a rejected chain.
    // The caller receives the rejection; waitUntil owns a settled observer.
    this.#chain = result.catch(() => undefined);
    this.#keepAlive(result.catch(() => undefined));
    return result;
  }
}
