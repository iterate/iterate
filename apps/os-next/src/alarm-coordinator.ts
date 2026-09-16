// alarm-coordinator.ts — THE ONE NATIVE ALARM of a context, derived: it holds no deadline of its
// own. `reconcile()` asks the deadline sources — the earliest pending schedule (core state), the
// earliest cursor-row claim (subscription-delivery.ts), the idle quiesce of the pins (the DO) — and
// arms the earliest, or deletes the alarm when they report none. Every reason is derivable at
// construction (a schedule is durable, a cursor row is durable and the log is, a pin is in memory
// and known), so the alarm read from storage is only the DEDUPE SEED: the constructor's first
// reconcile derives the same time (no write) or supersedes it — and a stored time no source still
// wants (a dead incarnation's idle deadline) is rightly superseded, even though workerd then cancels
// the run it would have started (nothing durable was due).
// ONE HOLD: nothing is written while `alarm()` runs — the pass's own alarm stays stored, so a pass
// that dies is retried by the runtime, and the next deadline is set ONCE when the pass completes.
// No clamp: the runtime clamps a past time to now. Every `setAlarm` call bills a write unit, so the
// only dedupe is `wanted === armedAt`; a fired alarm is forgotten (workerd deletes it after a completed
// handler, and after exhausting its retries) so the same time can be armed again.

type AlarmCoordinatorDeps = {
  setAlarm: (at: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
  /** Every source's earliest deadline, epoch ms, `null` for none. */
  deadlines: () => (number | null)[];
};

export class AlarmCoordinator {
  /** What storage holds, as far as this incarnation knows. */
  #armedAt: number | null = null;
  #passInProgress = false;
  readonly #deps: AlarmCoordinatorDeps;

  constructor(deps: AlarmCoordinatorDeps) {
    this.#deps = deps;
  }

  snapshot(): { armedAt: number | null; passInProgress: boolean } {
    return { armedAt: this.#armedAt, passInProgress: this.#passInProgress };
  }

  /** Seed from storage once, before the first append can reconcile: the dedupe seed, and what the
   *  wake record reports as the alarm that woke this incarnation. */
  restore(at: number | null) {
    this.#armedAt = at;
  }

  /** Run one alarm pass. Its alarm is forgotten either way: a completed pass has spent it (the
   *  runtime deletes it) and arms what is left; a pass that threw leaves it stored for the runtime's
   *  retries (2s·2ⁿ, six tries, then deleted) — the next reconcile arms whatever is wanted, the same
   *  time included. */
  async pass(work: () => Promise<void>): Promise<void> {
    this.#passInProgress = true;
    try {
      await work();
    } finally {
      this.#passInProgress = false;
      this.#armedAt = null;
    }
    this.reconcile();
  }

  reconcile() {
    if (this.#passInProgress) return;
    let wanted: number | null = null;
    for (const at of this.#deps.deadlines())
      if (at !== null && (wanted === null || at < wanted)) wanted = at;
    if (wanted === this.#armedAt) return;
    this.#armedAt = wanted;
    // The output gate makes a failed storage write fail the invocation.
    void (wanted === null ? this.#deps.deleteAlarm() : this.#deps.setAlarm(wanted));
  }
}
