// The processor host's revival guarantee: a Durable Object that dies owing
// work gets another processor wake.
//
// THE GAP THIS CLOSES. Stream-side sending is already durable (the source
// cursor rows + the stream DO's alarm retry/halt machinery,
// stream-event-sender.ts). What nothing covered is the ZERO-LAG wedge: a
// processor journals an obligation (`llm-request-requested`,
// `script-run-requested`), its checkpoint advances, and the in-flight
// attempt dies with the incarnation — a deploy evicts every DO. The stream
// sees no lag, arms no retry, and nothing ever wakes the processor again. The
// agent sits at `phase: "requested"` forever (the 2026-06-10 and 2026-07-07
// prd incidents).
//
// THE MECHANISM. While any registered work is in flight (`blockProcessorWhile`
// and `runInBackground` both count), schedule a durable DO alarm a few
// seconds ahead. Work settles cleanly → a confirmation fire finds quiet and
// disarms. The incarnation dies mid-work → the alarm survives it, fires in a
// fresh incarnation, and REVIVES: append one persisted revival fact to the
// stream (which cold-boots the stream DO — its `woken` fan-out restores the
// sender). Its delivery reaches head for the processor: a consumer receives the
// fact, while a non-consumer receives the runner's eventless at-head pass.
// Either path can settle whatever the dead incarnation left behind. Recovery
// has ONE entrypoint — batch delivery — and the stream records the whole episode: requested → revived → failure
// completion → reschedule.
//
// THE IMPOSSIBILITY GUARANTEE. A bug must never keep a DO awake forever, so
// the revival alarm is a crash-loop breaker, not a loop: every revival attempt
// durably marks `revivals + 1` BEFORE doing anything else and arms its next
// try at a growing backoff (10s → 1m → 5m → 30m → 6h, plateau forever — a
// permanently failing host costs ~4 wakes a day). The mark only resets on a
// QUIET-CLEAN confirmation (a fire that finds all tracked work settled
// successfully — not merely "the revival pass resolved", which a
// crash-looping post-revival batch would reset endlessly) or on a version
// change: the overwhelmingly likely fix for a deterministic crash loop is a
// deploy, so a revival that notices a new worker version starts from a fresh
// budget. Arming is dropped while a revival pass runs — otherwise the
// pass's own tracked work would pull the alarm back to the short lead and a
// crash inside the pass would defeat the backoff.
//
// This module is transport-free, clock-free, and storage-free — everything
// arrives through {@link ProcessorKeepaliveHooks}, using the same injected-hook
// pattern as stream-event-sender.ts, so the whole state machine runs in plain-node vitest
// with a mutable clock and scripted revivals (stream-processor-keepalive.test.ts).

import type { StreamEventInput } from "./schemas.ts";

/**
 * The durable mark, stored in DO KV BELOW the journal/fold: the crash-loop
 * breaker must live beneath the state reduction it protects (a failing fold
 * cannot be asked to fold its own pause fact). KV is authoritative here;
 * journal facts about revivals are evidence, not enforcement — the deliberate
 * inversion of the usual rule.
 */
export type KeepaliveRecord = {
  /** Consecutive revival attempts without a quiet-clean confirmation. */
  revivals: number;
  /** Epoch ms of the most recent revival attempt (drives the backoff). */
  lastRevivalAt: number;
  /** Worker version at the last write; a different live version resets the budget. */
  version: string;
  /**
   * The keepalive's own armed alarm time, or null when disarmed. Persisted so
   * a fresh incarnation can tell "this fire is mine" from "another subsystem's
   * slice of the shared DO alarm is due" (e.g. the scheduler's) — in-memory
   * state does not survive the eviction that makes revival necessary.
   */
  armedAtMs: number | null;
};

type ProcessorKeepaliveHooks = {
  /** Injected clock (epoch ms). */
  now(): number;
  /** Read the durable record. Synchronous DO KV in production. */
  readRecord(): KeepaliveRecord | undefined;
  /** Write the durable record. */
  writeRecord(record: KeepaliveRecord): void;
  /** Repoint (or clear) the keepalive's slice of the DO alarm. */
  armAlarm(atMs: number | null): void;
  /** Keep the DO alive while tracked work runs (ctx.waitUntil). */
  keepAlive(work: Promise<unknown>): void;
  /**
   * The revival pass: append the journaled revival fact, then pull every
   * hosted processor through its pending events so end-of-batch
   * reconciliations run. Must throw on failure — the breaker owns the retry.
   */
  revive(record: KeepaliveRecord): Promise<void>;
  /**
   * Classify and dispose a revival that can never become valid on retry.
   * Return true only after synchronously removing this attempt's durable
   * desire (or proving a newer desire replaced it). The keepalive then stops
   * without arming another retry.
   */
  discardFailedRevival?(error: unknown, record: KeepaliveRecord): boolean;
  /** Best-effort journal evidence (crash-loop warnings). Must not throw. */
  appendFact(event: StreamEventInput): void;
  /** Current worker deploy version (antidote-deploy budget reset). */
  version: string;
};

/** How far ahead of in-flight work the alarm is scheduled. Bounds post-eviction
 * revival latency; a deploy mid-agent-turn recovers within roughly this. */
export const KEEPALIVE_ALARM_LEAD_MS = 10_000;

/**
 * Floor between redundant re-assertions of an already-sufficient alarm.
 * See #ensureArmedForWork: the re-assert exists to heal a lost platform
 * write, and healing within a fraction of the lead is as good as instantly.
 */
const KEEPALIVE_REASSERT_MIN_INTERVAL_MS = 2_500;

/** Revival backoff by attempt number (1-based); past the table, the plateau. */
const REVIVAL_BACKOFF_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000];
export const REVIVAL_BACKOFF_PLATEAU_MS = 6 * 60 * 60_000;

/** Attempts before the crash-loop evidence fact is appended (once per version). */
const CRASH_LOOP_EVIDENCE_THRESHOLD = 3;

/**
 * Consecutive busy fires with NO settlement in between before the window is
 * treated as wedged (a hung promise nothing will ever settle — e.g. a socket
 * with no deadline). 90 fires ≈ 15 minutes at the lead, comfortably past the
 * longest legitimate tracked work (the providers' 10-minute deadlines), so
 * legit work never trips it while a wedge decays into the revival backoff
 * instead of re-arming every lead interval forever.
 */
export const MAX_CONSECUTIVE_BUSY_REFIRES = 90;

/** The semantic outcome of one platform alarm reaching the keepalive. */
type ProcessorKeepaliveAlarmAction =
  | "not_due"
  | "busy_rearmed"
  | "revival_hung_backoff"
  | "clean_disarmed"
  | "revived"
  | "revival_discarded"
  | "revival_failed";

export function revivalBackoffMs(revivals: number): number {
  return REVIVAL_BACKOFF_MS[revivals - 1] ?? REVIVAL_BACKOFF_PLATEAU_MS;
}

const FRESH_RECORD: Omit<KeepaliveRecord, "version"> = {
  revivals: 0,
  lastRevivalAt: 0,
  armedAtMs: null,
};

export class ProcessorKeepalive {
  readonly #hooks: ProcessorKeepaliveHooks;

  #inFlight = 0;
  /** Any tracked work settled successfully since the alarm was armed. A
   * successful revival pass also sets this — the pass IS settled work. */
  #sawCleanSettle = false;
  /** Any tracked work failed since the alarm was armed. Failures mean an
   * obligation may be unsettled (a debounce append that lost its stream), so
   * the next fire revives instead of disarming. */
  #sawFailure = false;
  /** Suppresses arm-earlier while the revival pass runs (see module doc). */
  #reviving = false;
  /** Consecutive busy fires without any settlement (wedged-work detector). */
  #busyRefires = 0;

  constructor(hooks: ProcessorKeepaliveHooks) {
    this.#hooks = hooks;
  }

  /**
   * The keepalive's current alarm desire, for the host's slice merge. Read
   * straight from the durable record (synchronous DO KV) — a separate
   * in-memory copy would be one more thing to drift after an eviction, and
   * stale copied state is exactly the failure class this module hunts.
   */
  /** When an already-armed desire was last re-asserted; in-memory on purpose
   * (a fresh incarnation should re-assert on its first tracked work). */
  #lastReassertAtMs = 0;

  get armedAtMs(): number | null {
    return this.#hooks.readRecord()?.armedAtMs ?? null;
  }

  /**
   * Register one unit of in-flight work. Every registered work closure —
   * blocking and background alike — rides through here, so "the DO died owing
   * work" is exactly "the DO died with the alarm armed".
   */
  track(work: Promise<unknown>): void {
    this.#inFlight += 1;
    this.#ensureArmedForWork();
    this.#hooks.keepAlive(
      work.then(
        () => {
          this.#inFlight -= 1;
          this.#sawCleanSettle = true;
          this.#busyRefires = 0;
        },
        () => {
          this.#inFlight -= 1;
          this.#sawFailure = true;
          this.#busyRefires = 0;
        },
      ),
    );
  }

  /**
   * The DO alarm handler body. The shared alarm may fire for another
   * subsystem's slice (the scheduler's), so this self-gates on the persisted
   * armed time and does nothing when the fire is not the keepalive's.
   */
  async onAlarm(): Promise<ProcessorKeepaliveAlarmAction> {
    const now = this.#hooks.now();
    const armedAt = this.armedAtMs;
    if (armedAt === null || now < armedAt) return "not_due";

    // Still working (or a revival pass is still running — its safety net owns
    // the cadence, and a SECOND pass must never start underneath it): push
    // the alarm ahead again — unless NOTHING has settled for so many
    // consecutive fires that the work is wedged (a hung promise no deadline
    // owns). A wedge falls through to the revival alarm so its cadence
    // decays along the backoff instead of firing at the lead interval forever.
    if (this.#inFlight > 0 || this.#reviving) {
      this.#busyRefires += 1;
      if (this.#busyRefires < MAX_CONSECUTIVE_BUSY_REFIRES) {
        this.#arm(now + KEEPALIVE_ALARM_LEAD_MS);
        return "busy_rearmed";
      }
      if (this.#reviving) {
        // The revival pass itself is hung. Starting another would lift the
        // arm-dropping under the running one; schedule at the longest interval instead
        // — the impossibility guarantee holds (~4 wakes/day) and any real
        // settlement resets the counter.
        this.#arm(now + REVIVAL_BACKOFF_PLATEAU_MS);
        return "revival_hung_backoff";
      }
    }

    // Quiet and clean: nothing in flight and every tracked settlement since
    // arming succeeded. The obligations those settlements journaled were
    // reconciled by their own batches; nothing is owed. Disarm, and reset the
    // crash-loop budget — this confirmation firing is the proof the DO
    // survives its own work.
    if (this.#inFlight === 0 && this.#sawCleanSettle && !this.#sawFailure) {
      this.#sawCleanSettle = false;
      this.#disarmAndReset();
      return "clean_disarmed";
    }

    // Revival: either this is a fresh incarnation (the armer died — flags
    // empty) or tracked work failed. Mark durably BEFORE doing anything, arm
    // the safety-net retry at the backoff, then run the pass.
    return await this.#revive(now);
  }

  async #revive(
    now: number,
  ): Promise<
    Extract<ProcessorKeepaliveAlarmAction, "revived" | "revival_discarded" | "revival_failed">
  > {
    const previous = this.#hooks.readRecord();
    const priorRevivals =
      previous === undefined || previous.version !== this.#hooks.version ? 0 : previous.revivals;
    const record: KeepaliveRecord = {
      revivals: priorRevivals + 1,
      lastRevivalAt: now,
      version: this.#hooks.version,
      armedAtMs: now + revivalBackoffMs(priorRevivals + 1),
    };
    // Mark-before / clear-after: a crash anywhere past this line leaves the
    // incremented mark and an armed retry — the loop can only decay, never
    // tighten. The clear is the quiet-clean confirmation above, deliberately
    // NOT "the pass resolved": a pass that resolves but whose follow-on work
    // crashes the DO would otherwise reset the budget every round.
    this.#hooks.writeRecord(record);
    this.#hooks.armAlarm(record.armedAtMs);

    if (record.revivals === CRASH_LOOP_EVIDENCE_THRESHOLD) {
      this.#hooks.appendFact({
        type: "events.iterate.com/stream/error-occurred",
        idempotencyKey: `processor-host-crash-loop:${record.version}`,
        payload: {
          message:
            `processor host revival has failed ${record.revivals} consecutive times on ` +
            `version ${record.version}; backing off (plateau ${REVIVAL_BACKOFF_PLATEAU_MS / 60_000}m). ` +
            `A deploy resets the budget.`,
        },
      });
    }

    this.#sawFailure = false;
    this.#sawCleanSettle = false;
    this.#reviving = true;
    try {
      await this.#hooks.revive(record);
      // The pass itself is settled clean work; the confirmation fire at the
      // short lead observes it (plus anything the pass scheduled) and resets
      // the budget if the window stays quiet. A WEDGED window keeps the
      // safety-net alarm instead: pulling it back to the lead would let the
      // hung work fire at lead cadence forever.
      this.#sawCleanSettle = true;
      const wedged = this.#inFlight > 0 && this.#busyRefires >= MAX_CONSECUTIVE_BUSY_REFIRES;
      if (!wedged) this.#arm(this.#hooks.now() + KEEPALIVE_ALARM_LEAD_MS);
      return "revived";
    } catch (error) {
      if (this.#hooks.discardFailedRevival?.(error, record) === true) {
        this.#sawFailure = false;
        this.#sawCleanSettle = false;
        return "revival_discarded";
      }
      console.error("stream processor host revival failed; backing off", {
        revivals: record.revivals,
        nextAttemptAt: record.armedAtMs,
        error,
      });
      this.#sawFailure = true;
      // The safety-net alarm armed above owns the retry.
      return "revival_failed";
    } finally {
      this.#reviving = false;
    }
  }

  /**
   * The operator's no-deploy antidote: clear the crash-loop budget and, when
   * a retry is owed (the record is armed), pull it in to the confirmation
   * lead so the next fire revives promptly on the fresh budget. Without this
   * the mark resets only on a quiet-clean confirmation or a version change —
   * a 3-strikes plateau otherwise mutes a wedged processor for six hours at
   * a time with a deploy as the only cure (the 2026-08-11 prod incident).
   */
  resetBackoff(): void {
    const record = this.#hooks.readRecord();
    if (record === undefined) return;
    if (record.armedAtMs === null) {
      // Nothing owed — just clear the stale budget.
      this.#hooks.writeRecord({ ...FRESH_RECORD, version: this.#hooks.version });
      return;
    }
    const atMs = this.#hooks.now() + KEEPALIVE_ALARM_LEAD_MS;
    this.#hooks.writeRecord({ ...FRESH_RECORD, version: this.#hooks.version, armedAtMs: atMs });
    this.#hooks.armAlarm(atMs);
  }

  /** Arm for in-flight work: move the alarm earlier, never later, and never
   * during a revival pass (its backoff safety net must govern). */
  #ensureArmedForWork(): void {
    if (this.#reviving) return;
    const nowMs = this.#hooks.now();
    const atMs = nowMs + KEEPALIVE_ALARM_LEAD_MS;
    const armedAt = this.armedAtMs;
    if (armedAt !== null && armedAt <= atMs) {
      // The record says a sufficient alarm exists — but the record proves the
      // DESIRE, not the platform write (a setAlarm can fail after the KV
      // committed, and the host swallows it into "platform state unknown").
      // Re-assert the desire: the host's reconcile is a pure in-memory
      // comparison when the platform alarm matches, and re-issues the write
      // when a previous one failed. Without this, a lost alarm in a WARM
      // incarnation stays lost until the next boot — the boot-time reconcile
      // only covers fresh incarnations.
      //
      // RATE-LIMITED, because for a facet this re-assert is not free: it is
      // an RPC to the parent Durable Object plus two output-gated storage
      // writes there — and `track` runs once per delivered batch, which on a
      // 50 Hz audio lane put that RPC inside every delivery acknowledgement.
      // Healing a lost platform alarm within a couple of seconds of tracked
      // work is every bit as good as healing it instantly: the alarm being
      // guarded fires ten seconds out.
      if (nowMs - this.#lastReassertAtMs < KEEPALIVE_REASSERT_MIN_INTERVAL_MS) return;
      this.#lastReassertAtMs = nowMs;
      this.#hooks.armAlarm(armedAt);
      return;
    }
    this.#lastReassertAtMs = nowMs;
    this.#arm(atMs);
  }

  #arm(atMs: number): void {
    const record = this.#hooks.readRecord();
    this.#hooks.writeRecord({
      ...(record?.version === this.#hooks.version
        ? record
        : { ...FRESH_RECORD, version: this.#hooks.version }),
      armedAtMs: atMs,
    });
    this.#hooks.armAlarm(atMs);
  }

  #disarmAndReset(): void {
    const record = this.#hooks.readRecord();
    if (record !== undefined && (record.revivals !== 0 || record.armedAtMs !== null)) {
      this.#hooks.writeRecord({ ...FRESH_RECORD, version: this.#hooks.version });
    }
    this.#hooks.armAlarm(null);
  }
}
