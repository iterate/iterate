type AlarmCoordinatorDeps = {
  setAlarm: (at: number) => Promise<void>;
  deleteAlarm?: () => Promise<void>;
  scheduledAt: () => number | null;
};
export type AlarmOwner = string;

/** One physical alarm for a context. Durable scheduling state is queried on every reconciliation;
 *  delivery watchdogs and idle cleanup contribute deadlines for the current incarnation. */
export class AlarmCoordinator {
  #armedAt: number | null = null;
  #inheritedAlarm = false;
  #requested = new Map<AlarmOwner, number>();
  #deferred = 0;

  readonly #deps: AlarmCoordinatorDeps;

  constructor(deps: AlarmCoordinatorDeps) {
    this.#deps = deps;
  }

  /** Seed once before startup work can arm. An existing alarm may be the wake starting this
   *  incarnation; replacing it with a later watchdog would cancel it before the handler runs. */
  restore(at: number | null): void {
    this.#armedAt = at;
    this.#inheritedAlarm = at !== null;
  }

  request(owner: AlarmOwner, at: number): void {
    this.#requested.set(owner, Math.min(this.#requested.get(owner) ?? at, at));
    this.reconcile();
  }

  /** Replace one owner's current deadline. `null` withdraws it after the corresponding durable or
   * in-memory obligation has settled. */
  replace(owner: AlarmOwner, at: number | null): void {
    if (at === null) {
      this.#requested.delete(owner);
      this.reconcile();
      return;
    }
    const previous = this.#requested.get(owner);
    this.#requested.set(owner, at);
    // If this owner held the current non-inherited minimum and its work moved later, replace the
    // physical alarm too. An obsolete early fire is safe, but retaining it obscures the current
    // deadline and creates avoidable wake evidence.
    if (
      previous !== undefined &&
      this.#armedAt === previous &&
      !this.#inheritedAlarm &&
      at > previous
    )
      this.#armedAt = null;
    this.reconcile();
  }

  clear(owner: AlarmOwner): void {
    this.replace(owner, null);
  }

  fired(now = Date.now()): void {
    this.#armedAt = null;
    this.#inheritedAlarm = false;
    // The native wake consumed every owner deadline at or before its firing time. Handlers rebuild
    // any still-outstanding obligation from durable state; retaining a past request would hot-loop
    // a context when a handler exits before its normal clear/replace path.
    for (const [owner, at] of this.#requested) if (at <= now) this.#requested.delete(owner);
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
    const deadlines = [...this.#requested.values()];
    if (scheduledAt !== null) deadlines.push(scheduledAt);
    if (!deadlines.length) {
      // A native alarm read during construction is recovery insurance. Keep it until that alarm
      // fires once; after that, an owner with no deadline really has no work and can withdraw it.
      if (this.#armedAt !== null && !this.#inheritedAlarm) {
        this.#armedAt = null;
        void this.#deps.deleteAlarm?.();
      }
      return;
    }
    const at = Math.max(Date.now(), Math.min(...deadlines));
    if (this.#armedAt !== null && this.#armedAt <= at) return;
    this.#armedAt = at;
    // The native output gate makes a failed storage write fail the invocation. An obsolete early
    // alarm is harmless: its handler rechecks durable state before doing any work.
    void this.#deps.setAlarm(at);
  }
}
