// alarm-coordinator.ts — THE ONE NATIVE ALARM of a context, derived: it holds no deadline of its
// own. `reconcile()` asks the deadline sources — the earliest pending schedule (core state), the
// earliest cursor-row claim (subscription-delivery.ts), the claims of hosted processors (the DO),
// the unclaimed-facet sweep (context/residency.ts), the runs processors requested (the DO) — and
// arms the earliest, or deletes the alarm when they report none. Every durable reason is derivable
// at construction (a schedule is durable, a cursor row is durable and the log is, a claim is a kv
// row); the sweep and the owed runs are in memory on purpose — the sweep watches the incarnation
// that armed it, and a fresh one has nothing to watch; a run a dead incarnation owed is settled
// `interrupted` by the fresh one's wake record, never started. So the alarm read
// from storage is only the DEDUPE SEED: the constructor's first reconcile derives the same time (no
// write) or supersedes it — and a stored time no source still wants (one a dead incarnation left,
// its sweep's included) is rightly superseded, even though workerd then cancels the run it would
// have started (nothing durable was due).
// ONE HOLD: nothing is written while the pass's WORK runs — its own alarm stays stored, so a pass
// that dies is retried by the runtime, and the next deadline is set ONCE, at the pass's end.
// No clamp: the runtime clamps a past time to now. Every `setAlarm` call bills a write unit, so the
// only dedupe is `wanted === armedAt`; a fired alarm is forgotten (workerd deletes it after a completed
// handler, and after exhausting its retries) so the same time can be armed again.
//
// THE OVERDUE WATCH — WORKAROUND for a platform defect: Cloudflare sometimes does not deliver an
// armed alarm at its time. `storage.getAlarm()` reports the overdue time and nothing runs; the
// runtime delivers it ~19, ~39 or ~58 s late, or only at the time it replaced. It follows a move
// earlier — the unclaimed-facet sweep arms +60 s on every facet context, so a facet's own short
// deadline is the common victim. Any `setAlarm()` gets a held alarm run within ~100 ms, and a
// storage write alone does not (github.com/iterate/do-alarm-held-repro, a Durable Object with no
// iterate code: 175 of 31,127 moved alarms held; 77 of 77 re-armed ones ran). So the watch re-arms:
//   - WHILE AN INBOUND CALL HOLDS THIS ACTOR OR A RUN IS OWED TO THE ALARM (`held`), a timer at the
//     armed time + `ALARM_OVERDUE_AFTER_MS` finds an alarm the runtime has not delivered and writes
//     it again for now. One still undelivered `ALARM_OVERDUE_AFTER_MS` later is written again, at
//     most `ALARM_MAX_REARMS` times for one armed time; then the watch reports it and leaves it
//     (once, on 2026-09-24, three re-arms 5 s apart went undelivered and the alarm ran 28.8 s late
//     in the next incarnation). A timer is never pending while the actor is idle: a pending timer
//     holds off eviction, and nothing may keep an idle actor for this. An owed run is not
//     idleness: its timer holds the actor only until the pass that starts it.
//   - AT AN INCARNATION'S BIRTH, a stored alarm already overdue is written again for now, the
//     first of those re-arms.
// `now`, never the stored time: workerd's ActorSqlite ignores a write of the stored time, and the
// edge takes either. An idle actor's held alarm is late until the runtime delivers it or the next
// birth re-arms it. A stored time no source still wants is superseded, never treated as held. An
// alarm a pass that THREW left stored is the runtime's retry on its own backoff, not a held one:
// the watch leaves it (a fresh incarnation cannot tell the two apart and re-arms it once at birth).
// Each act goes to `onOverdue`.
// REMOVE WHEN FIXED. No failing test can pin a defect this rare, so prd telemetry is the pin: every
// re-arm logs `iterate-context.platform-failure-alarm-rearm`, and the prd fault alarm
// (scripts/ci/prd-fault-alarm.ts, PINNED_WORKAROUNDS) posts once when prd has logged none for 28
// days. Then delete the watch: `rearmIfOverdue`, `watch` and the DO's `held` wiring.

/** How far past its time an armed alarm may go undelivered before the watch re-arms it, and how
 *  long a re-arm has to deliver before the next. Normal delivery: p99 6 ms (the repro's 31,041
 *  moved alarms not re-armed), max 2.9 s on a loaded preview; a held one is 19–58 s late, and a
 *  re-armed one runs within 559 ms — 5 s sits clear of all three. */
export const ALARM_OVERDUE_AFTER_MS = 5_000;
/** Re-arms of ONE armed time, the birth's included, before the watch gives up on it and reports
 *  it. Every re-arm in the repro delivered on the first try; three is room for a lost write, and a
 *  bound on an incarnation the runtime no longer delivers to. */
export const ALARM_MAX_REARMS = 3;

/** What the overdue watch did about an armed alarm the runtime has not delivered. */
export type OverdueAlarm = {
  /** The time the alarm was armed for, epoch ms. */
  armedAt: number;
  overdueMs: number;
  /** `rearm`: written again for now; `give-up`: `ALARM_MAX_REARMS` re-arms left it undelivered. */
  action: "rearm" | "give-up";
  /** Re-arms of this armed time so far, this one included. */
  rearms: number;
};

type AlarmCoordinatorDeps = {
  setAlarm: (at: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
  /** Every source's earliest deadline, epoch ms, `null` for none. */
  deadlines: () => (number | null)[];
  /** Whether an inbound call holds the actor resident right now, or work is owed to the alarm: the
   *  watch's timer runs only then. */
  held: () => boolean;
  /** The watch acted. */
  onOverdue: (overdue: OverdueAlarm) => void;
};

export class AlarmCoordinator {
  /** What storage holds, as far as this incarnation knows — except after a re-arm, which wrote
   *  `now` while this stays the time the sources want. */
  #armedAt: number | null = null;
  /** When this incarnation last wrote the alarm for `#armedAt` — a reconcile's write of it, or a
   *  re-arm's of now; null for the restored seed. A time written in the past is due when written (the runtime clamps it to now),
   *  so the next check is `ALARM_OVERDUE_AFTER_MS` after the later of the two, never back-to-back. */
  #writtenAt: number | null = null;
  /** Re-arms of `#armedAt` so far; past `ALARM_MAX_REARMS`, the watch has given up on it. */
  #rearms = 0;
  #passInProgress = false;
  /** When the current pass began, or the last one did — the WAIT_TIMEOUT's story. */
  #lastPassStartedAt: number | null = null;
  /** The last pass threw: its alarm stays stored and the runtime retries it on its own backoff — an
   *  overdue alarm then is that retry, owed by the runtime, never the watch's (acting would defeat
   *  the backoff of a pass that keeps failing). Cleared when the next pass starts. */
  #passThrew = false;
  #overdueTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #deps: AlarmCoordinatorDeps;

  constructor(deps: AlarmCoordinatorDeps) {
    this.#deps = deps;
  }

  snapshot(): {
    armedAt: number | null;
    passInProgress: boolean;
    lastPassStartedAt: number | null;
  } {
    return {
      armedAt: this.#armedAt,
      passInProgress: this.#passInProgress,
      lastPassStartedAt: this.#lastPassStartedAt,
    };
  }

  /** Seed from storage once, before the first commit can reconcile: the dedupe seed. */
  restore(at: number | null) {
    this.#armedAt = at;
  }

  /** Run one alarm pass, the runtime's delivery. Its alarm is forgotten either way: a completed
   *  pass has spent it (the runtime deletes it) and arms what is left; a pass that threw leaves it
   *  stored for the runtime's retries (2s·2ⁿ, six tries, then deleted) — the next reconcile arms
   *  whatever is wanted, the same time included. */
  async pass(work: () => Promise<void>): Promise<void> {
    this.#passInProgress = true;
    this.#lastPassStartedAt = Date.now();
    this.#passThrew = false;
    this.#stopOverdueTimer();
    try {
      await work();
    } catch (error) {
      this.#passThrew = true;
      throw error;
    } finally {
      this.#passInProgress = false;
      this.#armedAt = null;
    }
    this.reconcile();
  }

  reconcile() {
    if (this.#passInProgress) return;
    const wanted = this.#wanted();
    // Unchanged — a re-arm's aside included: the time the sources want is what it re-armed.
    if (wanted === this.#armedAt) return this.watch();
    this.#armedAt = wanted;
    this.#writtenAt = Date.now();
    this.#rearms = 0;
    // The output gate makes a failed storage write fail the invocation.
    void (wanted === null ? this.#deps.deleteAlarm() : this.#deps.setAlarm(wanted));
    this.watch();
  }

  /** THE WATCH AT BIRTH (the header): a restored alarm the sources still want, already
   *  `ALARM_OVERDUE_AFTER_MS` past its time, is re-armed; one they no longer want is superseded. */
  rearmIfOverdue(now: number): void {
    const armedAt = this.#armedAt;
    if (armedAt === null || now - armedAt < ALARM_OVERDUE_AFTER_MS) return;
    if (this.#wanted() !== armedAt) return this.reconcile();
    this.#rearm(armedAt, now);
    this.watch();
  }

  /** Point the watch's timer at the next check while an inbound call holds the actor; none while
   *  idle (a pending timer holds off eviction). The DO calls it when its first inbound call starts
   *  and its last one settles; every reconcile re-points it. */
  watch(): void {
    this.#stopOverdueTimer();
    const checkAt = this.#overdueCheckAt();
    if (checkAt === null || !this.#deps.held()) return;
    this.#overdueTimer = setTimeout(
      () => {
        this.#overdueTimer = undefined;
        this.#rearmIfStillOverdue(Date.now());
      },
      Math.max(0, checkAt - Date.now()),
    );
  }

  /** THE WATCH WHILE HELD (the header): the armed alarm still undelivered at its check is re-armed
   *  — `ALARM_OVERDUE_AFTER_MS` apart, at most `ALARM_MAX_REARMS` times for one armed time. */
  #rearmIfStillOverdue(now: number): void {
    const checkAt = this.#overdueCheckAt();
    if (checkAt === null) return;
    if (now < checkAt) return this.watch();
    if (this.#wanted() !== this.#armedAt) return this.reconcile();
    const armedAt = this.#armedAt!;
    if (this.#rearms >= ALARM_MAX_REARMS) {
      this.#rearms += 1; // past the cap: no further check (`#overdueCheckAt`)
      this.#deps.onOverdue({
        armedAt,
        overdueMs: now - armedAt,
        action: "give-up",
        rearms: ALARM_MAX_REARMS,
      });
      return;
    }
    this.#rearm(armedAt, now);
    this.watch();
  }

  /** Write the armed alarm again for `now`. `#armedAt` stays what the sources want, so no
   *  reconcile writes it back. */
  #rearm(armedAt: number, now: number): void {
    this.#rearms += 1;
    this.#writtenAt = now;
    void this.#deps.setAlarm(now);
    this.#deps.onOverdue({
      armedAt,
      overdueMs: now - armedAt,
      action: "rearm",
      rearms: this.#rearms,
    });
  }

  /** The earliest deadline any source reports, epoch ms, or null. */
  #wanted(): number | null {
    let wanted: number | null = null;
    for (const at of this.#deps.deadlines())
      if (at !== null && (wanted === null || at < wanted)) wanted = at;
    return wanted;
  }

  /** When the armed alarm is next due a check, or null: nothing armed, a pass running, a thrown
   *  pass's retry (the runtime's), or the watch gave up on it. */
  #overdueCheckAt(): number | null {
    if (
      this.#armedAt === null ||
      this.#passInProgress ||
      this.#passThrew ||
      this.#rearms > ALARM_MAX_REARMS
    )
      return null;
    return Math.max(this.#armedAt, this.#writtenAt ?? 0) + ALARM_OVERDUE_AFTER_MS;
  }

  #stopOverdueTimer() {
    clearTimeout(this.#overdueTimer);
    this.#overdueTimer = undefined;
  }
}
