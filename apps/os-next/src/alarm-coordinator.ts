type AlarmCoordinatorDeps = {
  setAlarm: (at: number) => Promise<void>;
  scheduledAt: () => number | null;
  recoveryHalted: () => boolean;
};

/** One physical alarm for a context. Durable scheduling state is queried on every reconciliation;
 *  delivery watchdogs and idle cleanup contribute deadlines for the current incarnation. */
export class AlarmCoordinator {
  #armedAt: number | null = null;
  #requested = new Map<"delivery" | "idle", number>();
  #deferred = 0;

  readonly #deps: AlarmCoordinatorDeps;

  constructor(deps: AlarmCoordinatorDeps) {
    this.#deps = deps;
  }

  /** Seed once before startup work can arm. An existing alarm may be the wake starting this
   *  incarnation; replacing it with a later watchdog would cancel it before the handler runs. */
  restore(at: number | null): void {
    this.#armedAt = at;
  }

  request(owner: "delivery" | "idle", at: number): void {
    if (this.#deps.recoveryHalted()) return;
    this.#requested.set(owner, Math.min(this.#requested.get(owner) ?? at, at));
    this.reconcile();
  }

  fired(): void {
    this.#armedAt = null;
    this.#requested.clear();
  }

  /** Commit a synchronous batch of due work before selecting the next deadline. */
  batch(work: () => void): void {
    this.#deferred++;
    try {
      work();
    } finally {
      this.#deferred--;
      this.reconcile();
    }
  }

  reconcile(): void {
    if (this.#deferred) return;
    const scheduledAt = this.#deps.scheduledAt();
    const deadlines = this.#deps.recoveryHalted() ? [] : [...this.#requested.values()];
    if (scheduledAt !== null) deadlines.push(scheduledAt);
    if (!deadlines.length) return;
    const at = Math.max(Date.now(), Math.min(...deadlines));
    if (this.#armedAt !== null && this.#armedAt <= at) return;
    this.#armedAt = at;
    // The native output gate makes a failed storage write fail the invocation. An obsolete early
    // alarm is harmless: its handler rechecks durable state before doing any work.
    void this.#deps.setAlarm(at);
  }
}
