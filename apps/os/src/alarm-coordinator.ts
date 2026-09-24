// alarm-coordinator.ts — THE ONE NATIVE ALARM of a context, derived: it holds no deadline of its
// own. `reconcile()` asks the deadline sources — the earliest pending schedule (core state), the
// earliest cursor-row claim (subscription-delivery.ts), the claims of hosted processors (the DO),
// the unclaimed-facet sweep (context/residency.ts) — and arms the earliest, or deletes the alarm
// when they report none. Every durable reason is derivable at construction (a schedule is durable,
// a cursor row is durable and the log is, a claim is a kv row); the sweep is in memory on purpose —
// it watches the incarnation that armed it, and a fresh one has nothing to watch. So the alarm read
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
// THE OVERDUE WATCH — WORKAROUND for a platform defect (measured 2026-09-24; the report is in the
// PR that added this): Cloudflare sometimes does not deliver an armed alarm at its time.
// `storage.getAlarm()` reports it and nothing runs; the runtime delivers it 15–60 s late — often
// only once the incarnation holding it is gone — or only at the time it replaced. A bare Durable
// Object with no iterate code reproduces it (an alarm moved from +60 s to +1.5 s: 2 of 1,000 held
// 39–40 s; a single +1.5 s alarm: 1 of 1,500 held 11.8 s); here the unclaimed-facet sweep arms +60 s
// on every facet context, so a facet's own short deadline is the common victim. The watch:
//   - WHILE AN INBOUND CALL HOLDS THIS ACTOR (`held`), a timer at the armed time +
//     `ALARM_OVERDUE_AFTER_MS` finds an alarm the runtime has not delivered and RUNS THE PASS
//     ITSELF (`runOverduePass`). Re-arming it is not enough: an incarnation the runtime stops
//     delivering to stays stopped (2026-09-24, a recurring schedule: three re-arms 5 s apart, none
//     delivered, the held alarm arrived 28.8 s late in the next incarnation). The pass's own
//     end-of-pass write re-arms whatever is left; what is left at the SAME instant (a backlog
//     past one pass's 32) is passed again `ALARM_OVERDUE_AFTER_MS` later, at most
//     `ALARM_MAX_WATCH_PASSES` times. A timer is never pending while the actor is idle: a pending
//     timer holds off eviction, and nothing may keep an idle actor for this.
//   - AT AN INCARNATION'S BIRTH, a stored alarm already overdue is written again for now — a
//     DIFFERENT time, which the runtime hands its alarm service as a fresh schedule (the stored
//     time written again is a no-op it never forwards); a fresh incarnation takes the delivery.
// An idle actor's held alarm is late until the runtime delivers it or the next birth re-arms it.
// A stored time no source still wants is superseded, never treated as held. An alarm a pass that
// THREW left stored is the runtime's retry on its own backoff, not a held one: the watch leaves it
// (a fresh incarnation cannot tell the two apart and re-arms it once at birth). Each act goes to
// `onOverdue`. Remove when the platform is fixed.

/** How far past its time an armed alarm may go undelivered before the watch acts. Normal delivery
 *  on a preview under load: p50 0 ms, p99 4 ms, max 2.9 s (5,500 bare alarms); a held one is
 *  15–60 s late — 5 s sits clear of both. */
export const ALARM_OVERDUE_AFTER_MS = 5_000;
/** Passes the watch runs for ONE armed time in a row — each leaving that same time due, each
 *  `ALARM_OVERDUE_AFTER_MS` after the last — before it gives up on it and reports it. A pass drains
 *  32 due schedules, so 33 or more at one instant legitimately take several; twenty (640 schedules,
 *  100 s) is past any backlog and bounds a pass that makes no progress at all. */
export const ALARM_MAX_WATCH_PASSES = 20;

/** What the overdue watch did about an armed alarm the runtime has not delivered. */
export type OverdueAlarm = {
  /** The time the alarm was armed for, epoch ms. */
  armedAt: number;
  overdueMs: number;
  /** `rearm`: written again for now, at birth; `pass`: this held actor runs the pass itself;
   *  `give-up`: `ALARM_MAX_WATCH_PASSES` passes left the same time due. */
  action: "rearm" | "pass" | "give-up";
};

type AlarmCoordinatorDeps = {
  setAlarm: (at: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
  /** Every source's earliest deadline, epoch ms, `null` for none. */
  deadlines: () => (number | null)[];
  /** Whether an inbound call holds the actor resident right now: the watch's timer runs only then. */
  held: () => boolean;
  /** Run the alarm pass in this actor, as the runtime's delivery would (its `pass`, not delivered). */
  runOverduePass: () => void;
  /** The watch acted. */
  onOverdue: (overdue: OverdueAlarm) => void;
};

export class AlarmCoordinator {
  /** What storage holds, as far as this incarnation knows — except after a birth re-arm, which
   *  wrote `now` while this stays the time the sources want. */
  #armedAt: number | null = null;
  /** When the watch last acted on `#armedAt` (a birth re-arm, a pass it ran): its next check is
   *  `ALARM_OVERDUE_AFTER_MS` after this, never back-to-back. */
  #lastWatchActAt: number | null = null;
  #passInProgress = false;
  /** When the current pass began, or the last one did — the WAIT_TIMEOUT's story. */
  #lastPassStartedAt: number | null = null;
  /** The last pass threw: its alarm stays stored and the runtime retries it on its own backoff — an
   *  overdue alarm then is that retry, owed by the runtime, never the watch's (acting would defeat
   *  the backoff of a pass that keeps failing). Cleared when the next pass starts. */
  #passThrew = false;
  /** The armed time the watch last ran a pass for, how many in a row, and the one it gave up on. */
  #watchPassesFor: number | null = null;
  #watchPasses = 0;
  #gaveUpOn: number | null = null;
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

  /** Run one alarm pass. Its alarm is forgotten either way: a completed pass has spent it (the
   *  runtime deletes it) and arms what is left; a pass that threw leaves it stored for the runtime's
   *  retries (2s·2ⁿ, six tries, then deleted) — the next reconcile arms whatever is wanted, the same
   *  time included. A pass the WATCH ran (`delivered: false`) spent nothing of the runtime's: the
   *  armed time is still stored, so the end-of-pass reconcile starts from it — writing what is
   *  left, deleting it when nothing is, and leaving a time still due to the next spaced check. */
  async pass(work: () => Promise<void>, { delivered }: { delivered: boolean }): Promise<void> {
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
      if (delivered) {
        this.#armedAt = null;
        this.#lastWatchActAt = null;
      } else {
        // The runtime spent nothing: storage still holds what it held (a birth re-arm's aside
        // included), and the time armed stays the one to compare with what is wanted now.
        this.#lastWatchActAt = Date.now();
      }
    }
    // A delivered pass is the runtime delivering again: whatever the watch counted is over.
    if (delivered) this.#watchPassesFor = null;
    this.reconcile();
  }

  reconcile() {
    if (this.#passInProgress) return;
    const wanted = this.#wanted();
    // Unchanged — a birth re-arm's aside included: the time the sources want is what it re-armed.
    if (wanted === this.#armedAt) return this.watch();
    this.#armedAt = wanted;
    this.#lastWatchActAt = null;
    // The output gate makes a failed storage write fail the invocation.
    void (wanted === null ? this.#deps.deleteAlarm() : this.#deps.setAlarm(wanted));
    this.watch();
  }

  /** THE WATCH AT BIRTH (the header): a restored alarm the sources still want, already
   *  `ALARM_OVERDUE_AFTER_MS` past its time, is written again for `now`; one they no longer want
   *  is superseded. */
  rearmIfOverdue(now: number): void {
    const armedAt = this.#armedAt;
    if (armedAt === null || now - armedAt < ALARM_OVERDUE_AFTER_MS) return;
    if (this.#wanted() !== armedAt) return this.reconcile();
    this.#lastWatchActAt = now;
    // `now`, never `armedAt`: the stored time written again is a no-op the runtime never forwards.
    // `#armedAt` stays what the sources want, so no reconcile writes it back.
    void this.#deps.setAlarm(now);
    this.#deps.onOverdue({ armedAt, overdueMs: now - armedAt, action: "rearm" });
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
        this.#passIfOverdue(Date.now());
      },
      Math.max(0, checkAt - Date.now()),
    );
  }

  /** THE WATCH WHILE HELD (the header): the armed alarm still undelivered at its check runs the
   *  pass here — `ALARM_OVERDUE_AFTER_MS` apart, at most `ALARM_MAX_WATCH_PASSES` in a row for one
   *  armed time. */
  #passIfOverdue(now: number): void {
    const checkAt = this.#overdueCheckAt();
    if (checkAt === null) return;
    if (now < checkAt) return this.watch();
    if (this.#wanted() !== this.#armedAt) return this.reconcile();
    const armedAt = this.#armedAt!;
    this.#watchPasses = this.#watchPassesFor === armedAt ? this.#watchPasses + 1 : 1;
    this.#watchPassesFor = armedAt;
    if (this.#watchPasses > ALARM_MAX_WATCH_PASSES) {
      this.#gaveUpOn = armedAt;
      this.#deps.onOverdue({ armedAt, overdueMs: now - armedAt, action: "give-up" });
      return;
    }
    this.#deps.onOverdue({ armedAt, overdueMs: now - armedAt, action: "pass" });
    this.#deps.runOverduePass();
  }

  /** The earliest deadline any source reports, epoch ms, or null. */
  #wanted(): number | null {
    let wanted: number | null = null;
    for (const at of this.#deps.deadlines())
      if (at !== null && (wanted === null || at < wanted)) wanted = at;
    return wanted;
  }

  /** When the armed alarm is next due a check, or null: nothing armed, a pass running, a thrown
   *  pass's retry (the runtime's), or the time the watch gave up on. */
  #overdueCheckAt(): number | null {
    if (
      this.#armedAt === null ||
      this.#passInProgress ||
      this.#passThrew ||
      this.#gaveUpOn === this.#armedAt
    )
      return null;
    return Math.max(this.#armedAt, this.#lastWatchActAt ?? 0) + ALARM_OVERDUE_AFTER_MS;
  }

  #stopOverdueTimer() {
    clearTimeout(this.#overdueTimer);
    this.#overdueTimer = undefined;
  }
}
