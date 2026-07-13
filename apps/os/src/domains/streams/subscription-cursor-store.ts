// Durable subscription cursor storage for the Stream delivery spine.
//
// Cursor rows share the Stream Durable Object's SQLite database with the event
// log on purpose: a cursor advance and the events it acknowledges commit under
// the same output gate, so the cursor cannot disagree with the log it points
// into. Cursor rows are storage, not facts; park and resume transitions remain
// facts appended to the event log.
//
// Every method here is synchronous so cursor transitions stay in the Durable
// Object's current transaction and output gate.

import { initializeStreamStorage } from "./stream-storage.ts";

const MAX_SQL_BINDINGS = 100;
const CURSOR_PROGRESS_ROW_WIDTH = 3;
const MAX_CURSOR_PROGRESS_ROWS = Math.floor(MAX_SQL_BINDINGS / CURSOR_PROGRESS_ROW_WIDTH);
const CURSOR_SET_ROW_WIDTH = 3;
const MAX_CURSOR_SET_ROWS = Math.floor(MAX_SQL_BINDINGS / CURSOR_SET_ROW_WIDTH);
const MAX_UNPERSISTED_SKIP_OFFSETS = 64;
const CURSOR_PROGRESS_STATEMENTS = createCursorProgressStatements(MAX_CURSOR_PROGRESS_ROWS);
const CURSOR_SET_STATEMENTS = createCursorSetStatements(MAX_CURSOR_SET_ROWS);
const SUBSCRIPTION_CURSOR_COLUMNS = `
  subscription_key, acked_offset, attempt, next_attempt_at, last_error, epoch,
  pending_through_offset, pending_stream_max_offset, pending_attempt, pending_recovery_at
`;
const LIST_SUBSCRIPTION_CURSORS = `
  select ${SUBSCRIPTION_CURSOR_COLUMNS}
  from subscriptions
`;
const ENSURE_SUBSCRIPTION_CURSOR = `
  insert into subscriptions (subscription_key, acked_offset, epoch)
  values (?, ?, ?)
  on conflict (subscription_key) do nothing
`;
const ACK_SUBSCRIPTION_CURSOR = `
  update subscriptions
  set acked_offset = ?, attempt = 0, next_attempt_at = null, last_error = null,
      pending_through_offset = null, pending_stream_max_offset = null,
      pending_attempt = null, pending_recovery_at = null
  where subscription_key = ?
`;
const ACK_FENCED_SUBSCRIPTION_CURSOR = `${ACK_SUBSCRIPTION_CURSOR.trimEnd()} and epoch = ?`;
const CLAIM_PUSH_FRAME = `
  update subscriptions
  set acked_offset = ?,
      pending_through_offset = ?,
      pending_stream_max_offset = ?,
      pending_attempt = ?,
      pending_recovery_at = ?
  where subscription_key = ? and epoch = ?
`;
const ADVANCE_SUBSCRIPTION_WATERMARK = `
  update subscriptions
  set acked_offset = max(acked_offset, ?), next_attempt_at = null
  where subscription_key = ? and epoch = ?
`;
const NACK_SUBSCRIPTION_CURSOR = `
  update subscriptions
  set attempt = ?, next_attempt_at = ?, last_error = ?, pending_recovery_at = null
  where subscription_key = ? and epoch = ?
`;
const SET_SUBSCRIPTION_CURSOR = `
  update subscriptions
  set acked_offset = ?, attempt = 0, next_attempt_at = null, last_error = null,
      epoch = ?, pending_through_offset = null, pending_stream_max_offset = null,
      pending_attempt = null, pending_recovery_at = null
  where subscription_key = ?
`;
const DELETE_SUBSCRIPTION_CURSOR = "delete from subscriptions where subscription_key = ?";

type PendingSubscriptionProgress = {
  ackedOffset: number;
  epoch: number;
  skippedOffsets: number;
};

function isSubscriptionProgressDue(progress: PendingSubscriptionProgress): boolean {
  return progress.skippedOffsets >= MAX_UNPERSISTED_SKIP_OFFSETS;
}

/**
 * One durable subscription's delivery cursor row. `ackedOffset` is exclusive
 * (delivery resumes at +1). For push subscriptions it is the AUTHORITATIVE
 * cursor: delivery offsets advance only when the receiver's awaited call
 * resolved; the next claim checkpoints the prior ack, so a crash can replay
 * at most one successful RPC batch. Pure
 * no-side-effect skips checkpoint in 64-offset chunks at reconciliation
 * boundaries. For wake subscriptions it is an OBSERVATIONAL watermark: the checkpoint the
 * subscriber reported on the last successful poke, used only for poke
 * coalescing and lag display — the subscriber's own `{offset, state}` snapshot
 * is the truth, and a lost or stale row costs one redundant poke, nothing
 * more.
 */
export type SubscriptionCursorRow = {
  subscriptionKey: string;
  ackedOffset: number;
  /** Consecutive delivery/poke failures since the last success. */
  attempt: number;
  /** Wall-clock ms before which the spine must not retry; null when not backing off. */
  nextAttemptAt: number | null;
  lastError: string | null;
  /**
   * Seek fence. Bumped by every explicit cursor move (`setCursor`) and fresh
   * on every row creation, so an ack fenced on the epoch a drain READ cannot
   * clobber a seek (or a remove+recreate) that landed while its delivery was
   * in flight — `ack`'s monotonic max alone would silently swallow the seek.
   */
  epoch: number;
  /** Exact raw frame boundary durably claimed before an outbound push. */
  pendingThroughOffset: number | null;
  /** Stream head captured with the claimed frame; stable receiver freshness input on retry. */
  pendingStreamMaxOffset: number | null;
  /** 1-based dispatch attempt persisted before this frame's outbound RPC. */
  pendingAttempt: number | null;
  /** Crash-recovery deadline for the currently in-flight RPC; null while backing off. */
  pendingRecoveryAt: number | null;
};

export type SubscriptionCursorSet = {
  subscriptionKey: string;
  ackedOffset: number;
};

/**
 * The delivery spine's durable rows, behind an interface so the spine's logic
 * is unit-testable with an in-memory twin (stream-subscribers.test.ts). All
 * methods synchronous — same rule as the event log above.
 */
export type SubscriptionCursorStore = {
  get(subscriptionKey: string): SubscriptionCursorRow | undefined;
  list(): SubscriptionCursorRow[];
  /** Create if absent without resetting; return an immutable caller snapshot. */
  ensure(subscriptionKey: string, ackedOffset: number): SubscriptionCursorRow;
  /**
   * Successful delivery: advance the cursor (monotonic), clear failure state.
   * With `epoch`, the ack is FENCED: it no-ops unless the row's epoch still
   * matches the one the caller read before dialing — a seek that landed while
   * the delivery was in flight wins over the delivery's ack.
   */
  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): boolean;
  /**
   * Successful internal RPC push delivery. Advance immediately, but permit a
   * one-batch durable lag: the next frame claim atomically checkpoints this
   * ack, while a quiet tail flushes on its recovery alarm or an explicit
   * lifecycle/failure boundary. Webhooks use {@link ack} instead.
   */
  stageAck(subscriptionKey: string, ackedOffset: number, epoch: number): boolean;
  /**
   * Durably claim the exact push frame and dispatch attempt before its
   * outbound RPC. Returns the stable envelope, or undefined when the epoch is
   * stale.
   */
  claimPushFrame(
    subscriptionKey: string,
    throughOffset: number,
    streamMaxOffset: number,
    recoveryAt: number,
    epoch: number,
  ): { streamMaxOffset: number; attempt: number } | undefined;
  /**
   * Advance across a batch that produced no receiver side effect (selector
   * miss / ephemeral-only). The in-memory cursor moves immediately; durable
   * persistence may lag by a bounded window because replaying a skip is safe.
   */
  skip(subscriptionKey: string, ackedOffset: number, epoch: number): void;
  /** Persist pending cursor progress that is due, or all progress. */
  flushPending(mode?: "due" | "all"): void;
  /**
   * Advance the wake lane's observational watermark (monotonic) after a poke
   * whose checkpoint did NOT progress. Clears the retry schedule (the poke
   * consumed it; a live connection has no pending retry to arm) but KEEPS the
   * failure streak — a successful handshake proves the host is reachable, not
   * that deliveries succeed, and resetting the counter here is what let a
   * deterministically failing subscriber spin forever without ever parking.
   */
  advanceWatermark(subscriptionKey: string, ackedOffset: number, epoch: number): void;
  /** Failed delivery: record the consecutive attempt count and when to retry. */
  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string; epoch: number },
  ): void;
  /** Explicit seek (cursor-set / resume-with-afterOffset). Clears failure state, bumps the epoch. */
  setCursor(subscriptionKey: string, ackedOffset: number): void;
  /** Apply a contiguous run of explicit seeks with bounded multi-row SQL updates. */
  setCursors(cursors: readonly SubscriptionCursorSet[]): void;
  delete(subscriptionKey: string): void;
  /** Earliest backoff or in-flight recovery deadline, for arming the DO alarm. */
  minNextAttemptAt(): number | null;
};

/** SQLite-backed {@link SubscriptionCursorStore}, sharing the stream's own database. */
export class SqliteSubscriptionCursorStore implements SubscriptionCursorStore {
  /** Monotonic within this instance; wall-clock floor covers restarts. */
  #lastEpoch = 0;

  readonly #sql: SqlStorage;
  #cachedRows: Map<string, SubscriptionCursorRow> | undefined;
  readonly #pendingProgress = new Map<string, PendingSubscriptionProgress>();
  #dueProgressRows = 0;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    initializeStreamStorage(sql);
  }

  #nextEpoch(): number {
    return this.#reserveEpochs(1);
  }

  #reserveEpochs(count: number): number {
    const first = Math.max(this.#lastEpoch + 1, Date.now());
    this.#lastEpoch = first + count - 1;
    return first;
  }

  #rows(): Map<string, SubscriptionCursorRow> {
    if (this.#cachedRows !== undefined) return this.#cachedRows;
    const rows = new Map<string, SubscriptionCursorRow>();
    for (const record of this.#sql.exec<SubscriptionCursorRowRecord>(LIST_SUBSCRIPTION_CURSORS)) {
      const row = rowFromRecord(record);
      rows.set(row.subscriptionKey, row);
      this.#lastEpoch = Math.max(this.#lastEpoch, row.epoch);
    }
    this.#cachedRows = rows;
    return rows;
  }

  #setPendingProgress(subscriptionKey: string, progress: PendingSubscriptionProgress): void {
    const previous = this.#pendingProgress.get(subscriptionKey);
    if (previous !== undefined && isSubscriptionProgressDue(previous)) this.#dueProgressRows -= 1;
    this.#pendingProgress.set(subscriptionKey, progress);
    if (isSubscriptionProgressDue(progress)) this.#dueProgressRows += 1;
  }

  #deletePendingProgress(subscriptionKey: string): void {
    const previous = this.#pendingProgress.get(subscriptionKey);
    if (previous === undefined) return;
    if (isSubscriptionProgressDue(previous)) this.#dueProgressRows -= 1;
    this.#pendingProgress.delete(subscriptionKey);
  }

  get(subscriptionKey: string): SubscriptionCursorRow | undefined {
    const row = this.#rows().get(subscriptionKey);
    return row === undefined ? undefined : { ...row };
  }

  list(): SubscriptionCursorRow[] {
    return [...this.#rows().values()].map((row) => ({ ...row }));
  }

  ensure(subscriptionKey: string, ackedOffset: number): SubscriptionCursorRow {
    const rows = this.#rows();
    const existing = rows.get(subscriptionKey);
    if (existing !== undefined) return { ...existing };
    const epoch = this.#nextEpoch();
    // Fresh rows get a fresh epoch, so an ack fenced on a DELETED row's
    // epoch cannot land on a same-key recreation (the remove+recreate
    // deliver:"all" clobber).
    this.#sql.exec(ENSURE_SUBSCRIPTION_CURSOR, subscriptionKey, ackedOffset, epoch);
    const row: SubscriptionCursorRow = {
      subscriptionKey,
      ackedOffset,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      epoch,
      pendingThroughOffset: null,
      pendingStreamMaxOffset: null,
      pendingAttempt: null,
      pendingRecoveryAt: null,
    };
    rows.set(subscriptionKey, row);
    return { ...row };
  }

  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): boolean {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || (epoch !== undefined && row.epoch !== epoch)) return false;
    // The cursor cache is write-through and this method is synchronous, so it
    // already owns the monotonic maximum; avoid recomputing it in SQLite.
    const nextOffset = Math.max(row.ackedOffset, ackedOffset);
    if (
      !this.#pendingProgress.has(subscriptionKey) &&
      nextOffset === row.ackedOffset &&
      row.attempt === 0 &&
      row.nextAttemptAt === null &&
      row.lastError === null &&
      row.pendingThroughOffset === null
    ) {
      return true;
    }
    if (epoch === undefined) {
      this.#sql.exec(ACK_SUBSCRIPTION_CURSOR, nextOffset, subscriptionKey);
    } else {
      this.#sql.exec(ACK_FENCED_SUBSCRIPTION_CURSOR, nextOffset, subscriptionKey, epoch);
    }
    this.#deletePendingProgress(subscriptionKey);
    row.ackedOffset = nextOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    row.pendingThroughOffset = null;
    row.pendingStreamMaxOffset = null;
    row.pendingAttempt = null;
    row.pendingRecoveryAt = null;
    return true;
  }

  stageAck(subscriptionKey: string, ackedOffset: number, epoch: number): boolean {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || row.epoch !== epoch) return false;
    const nextOffset = Math.max(row.ackedOffset, ackedOffset);
    const clearsFailure = row.attempt !== 0 || row.nextAttemptAt !== null || row.lastError !== null;
    const pending = this.#pendingProgress.get(subscriptionKey);
    if (nextOffset === row.ackedOffset && pending === undefined && !clearsFailure) return true;
    this.#setPendingProgress(subscriptionKey, {
      ackedOffset: nextOffset,
      epoch,
      skippedOffsets: pending?.skippedOffsets ?? 0,
    });
    row.ackedOffset = nextOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    row.pendingThroughOffset = null;
    row.pendingStreamMaxOffset = null;
    row.pendingAttempt = null;
    row.pendingRecoveryAt = null;
    // Deliberately count across drain lifetimes: trickle traffic otherwise
    // turns every one-batch drain tail back into an output-gated cursor write.
    this.flushPending(clearsFailure ? "all" : "due");
    return true;
  }

  claimPushFrame(
    subscriptionKey: string,
    throughOffset: number,
    streamMaxOffset: number,
    recoveryAt: number,
    epoch: number,
  ): { streamMaxOffset: number; attempt: number } | undefined {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || row.epoch !== epoch) return undefined;
    const activeClaim =
      row.pendingThroughOffset !== null && row.pendingThroughOffset > row.ackedOffset;
    const sameDelivery = activeClaim && row.pendingThroughOffset === throughOffset;
    const stableStreamMaxOffset = sameDelivery ? row.pendingStreamMaxOffset! : streamMaxOffset;
    const attempt = sameDelivery ? Math.max(row.pendingAttempt ?? 0, row.attempt) + 1 : 1;
    this.#sql.exec(
      CLAIM_PUSH_FRAME,
      row.ackedOffset,
      throughOffset,
      stableStreamMaxOffset,
      attempt,
      recoveryAt,
      subscriptionKey,
      epoch,
    );
    this.#deletePendingProgress(subscriptionKey);
    row.pendingThroughOffset = throughOffset;
    row.pendingStreamMaxOffset = stableStreamMaxOffset;
    row.pendingAttempt = attempt;
    row.pendingRecoveryAt = recoveryAt;
    return { streamMaxOffset: stableStreamMaxOffset, attempt };
  }

  skip(subscriptionKey: string, ackedOffset: number, epoch: number): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || row.epoch !== epoch || ackedOffset <= row.ackedOffset) return;
    const clearsFailure = row.attempt !== 0 || row.nextAttemptAt !== null || row.lastError !== null;
    const pending = this.#pendingProgress.get(subscriptionKey);
    this.#setPendingProgress(subscriptionKey, {
      ackedOffset,
      epoch,
      skippedOffsets: (pending?.skippedOffsets ?? 0) + ackedOffset - row.ackedOffset,
    });
    row.ackedOffset = ackedOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    row.pendingThroughOffset = null;
    row.pendingStreamMaxOffset = null;
    row.pendingAttempt = null;
    row.pendingRecoveryAt = null;
    // A due retry that found only skips consumed the persisted backoff. Do not
    // leave its old alarm state behind on a quiet stream.
    if (clearsFailure) this.flushPending("all");
  }

  flushPending(mode: "due" | "all" = "due"): void {
    if (this.#pendingProgress.size === 0) return;
    if (mode === "due" && this.#dueProgressRows === 0) return;
    const all = [...this.#pendingProgress.entries()];
    for (let start = 0; start < all.length; start += MAX_CURSOR_PROGRESS_ROWS) {
      const batch = all.slice(start, start + MAX_CURSOR_PROGRESS_ROWS);
      const bindings: SqlStorageValue[] = [];
      for (const [subscriptionKey, row] of batch) {
        bindings.push(subscriptionKey, row.ackedOffset, row.epoch);
      }
      this.#sql.exec(CURSOR_PROGRESS_STATEMENTS[batch.length]!, ...bindings);
      for (const [subscriptionKey] of batch) this.#deletePendingProgress(subscriptionKey);
    }
  }

  advanceWatermark(subscriptionKey: string, ackedOffset: number, epoch: number): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || row.epoch !== epoch) return;
    const nextOffset = Math.max(row.ackedOffset, ackedOffset);
    if (
      !this.#pendingProgress.has(subscriptionKey) &&
      nextOffset === row.ackedOffset &&
      row.nextAttemptAt === null
    ) {
      return;
    }
    this.#sql.exec(ADVANCE_SUBSCRIPTION_WATERMARK, nextOffset, subscriptionKey, epoch);
    this.#deletePendingProgress(subscriptionKey);
    row.ackedOffset = nextOffset;
    row.nextAttemptAt = null;
  }

  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string; epoch: number },
  ): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || row.epoch !== args.epoch) return;
    if (this.#pendingProgress.has(subscriptionKey)) this.flushPending("all");
    const error = args.error.slice(0, 2_000);
    this.#sql.exec(
      NACK_SUBSCRIPTION_CURSOR,
      args.attempt,
      args.nextAttemptAt,
      // Bound the stored error so a pathological message cannot bloat the row.
      error,
      subscriptionKey,
      args.epoch,
    );
    row.attempt = args.attempt;
    row.nextAttemptAt = args.nextAttemptAt;
    row.lastError = error;
    row.pendingRecoveryAt = null;
  }

  setCursor(subscriptionKey: string, ackedOffset: number): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined) return;
    const epoch = this.#nextEpoch();
    this.#sql.exec(SET_SUBSCRIPTION_CURSOR, ackedOffset, epoch, subscriptionKey);
    this.#deletePendingProgress(subscriptionKey);
    row.ackedOffset = ackedOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    row.epoch = epoch;
    row.pendingThroughOffset = null;
    row.pendingStreamMaxOffset = null;
    row.pendingAttempt = null;
    row.pendingRecoveryAt = null;
  }

  setCursors(cursors: readonly SubscriptionCursorSet[]): void {
    if (cursors.length === 1) {
      const cursor = cursors[0]!;
      this.setCursor(cursor.subscriptionKey, cursor.ackedOffset);
      return;
    }

    const rows = this.#rows();
    const existing: Array<{ cursor: SubscriptionCursorSet; row: SubscriptionCursorRow }> = [];
    for (const cursor of cursors) {
      const row = rows.get(cursor.subscriptionKey);
      if (row !== undefined) existing.push({ cursor, row });
    }
    if (existing.length === 0) return;
    const firstEpoch = this.#reserveEpochs(existing.length);
    const updates = new Map<
      string,
      { row: SubscriptionCursorRow; ackedOffset: number; epoch: number }
    >();
    for (let index = 0; index < existing.length; index += 1) {
      const { cursor, row } = existing[index]!;
      updates.set(cursor.subscriptionKey, {
        row,
        ackedOffset: cursor.ackedOffset,
        epoch: firstEpoch + index,
      });
    }

    const pending = [...updates.entries()];
    for (let start = 0; start < pending.length; start += MAX_CURSOR_SET_ROWS) {
      const batch = pending.slice(start, start + MAX_CURSOR_SET_ROWS);
      const bindings: SqlStorageValue[] = [];
      for (const [subscriptionKey, update] of batch) {
        bindings.push(subscriptionKey, update.ackedOffset, update.epoch);
      }
      this.#sql.exec(CURSOR_SET_STATEMENTS[batch.length]!, ...bindings);
      for (const [subscriptionKey, update] of batch) {
        this.#deletePendingProgress(subscriptionKey);
        update.row.ackedOffset = update.ackedOffset;
        update.row.attempt = 0;
        update.row.nextAttemptAt = null;
        update.row.lastError = null;
        update.row.epoch = update.epoch;
        update.row.pendingThroughOffset = null;
        update.row.pendingStreamMaxOffset = null;
        update.row.pendingAttempt = null;
        update.row.pendingRecoveryAt = null;
      }
    }
  }

  delete(subscriptionKey: string): void {
    const rows = this.#rows();
    if (!rows.has(subscriptionKey)) return;
    this.#sql.exec(DELETE_SUBSCRIPTION_CURSOR, subscriptionKey);
    this.#deletePendingProgress(subscriptionKey);
    rows.delete(subscriptionKey);
  }

  minNextAttemptAt(): number | null {
    let next: number | null = null;
    for (const row of this.#rows().values()) {
      if (row.nextAttemptAt !== null && (next === null || row.nextAttemptAt < next)) {
        next = row.nextAttemptAt;
      }
      if (row.pendingRecoveryAt !== null && (next === null || row.pendingRecoveryAt < next)) {
        next = row.pendingRecoveryAt;
      }
    }
    return next;
  }
}

/**
 * Reconciles the spine's cursor rows against a freshly REBUILT config fold
 * (core state version mismatch). Rows are storage and survive the KV state,
 * so after a rebuild they can describe a world the new fold no longer
 * derives: a row whose config event no longer parses is orphaned (its
 * `next_attempt_at` would arm alarms forever), and a surviving row's backoff
 * may blame code the new version replaced. Progress is kept — `ackedOffset`
 * is monotonic truth about the same immutable log — while failure state is
 * cleared for unclaimed rows. Exact push claims retain their envelope and
 * retry schedule: clearing either can change receiver-visible redelivery.
 */
export function reconcileSubscriptionCursorRows(
  store: SubscriptionCursorStore,
  configuredKeys: ReadonlySet<string>,
): void {
  for (const row of store.list()) {
    if (!configuredKeys.has(row.subscriptionKey)) {
      store.delete(row.subscriptionKey);
    } else if (
      row.pendingThroughOffset === null &&
      (row.attempt !== 0 || row.nextAttemptAt !== null || row.lastError !== null)
    ) {
      // ack at the row's own offset: keeps the cursor, clears attempt/backoff.
      store.ack(row.subscriptionKey, row.ackedOffset);
    }
  }
}

type SubscriptionCursorRowRecord = {
  subscription_key: string;
  acked_offset: number;
  attempt: number;
  next_attempt_at: number | null;
  last_error: string | null;
  epoch: number;
  pending_through_offset: number | null;
  pending_stream_max_offset: number | null;
  pending_attempt: number | null;
  pending_recovery_at: number | null;
};

function rowFromRecord(record: SubscriptionCursorRowRecord): SubscriptionCursorRow {
  return {
    subscriptionKey: record.subscription_key,
    ackedOffset: record.acked_offset,
    attempt: record.attempt,
    nextAttemptAt: record.next_attempt_at,
    lastError: record.last_error,
    epoch: record.epoch,
    pendingThroughOffset: record.pending_through_offset,
    pendingStreamMaxOffset: record.pending_stream_max_offset,
    pendingAttempt: record.pending_attempt,
    pendingRecoveryAt: record.pending_recovery_at,
  };
}

function createCursorProgressStatements(maxRows: number): string[] {
  return Array.from({ length: maxRows + 1 }, (_, rowCount) => {
    if (rowCount === 0) return "";
    const rows = Array.from({ length: rowCount }, () => "(?, ?, ?)").join(", ");
    return `
      with progress(subscription_key, acked_offset, epoch) as (values ${rows})
      update subscriptions as current
      set acked_offset = max(current.acked_offset, progress.acked_offset),
          attempt = 0,
          next_attempt_at = null,
          last_error = null,
          pending_through_offset = null,
          pending_stream_max_offset = null,
          pending_attempt = null,
          pending_recovery_at = null
      from progress
      where current.subscription_key = progress.subscription_key
        and current.epoch = progress.epoch
    `;
  });
}

function createCursorSetStatements(maxRows: number): string[] {
  const statements = new Array<string>(maxRows + 1);
  for (let rows = 1; rows <= maxRows; rows += 1) {
    statements[rows] = `
      with cursor_updates(subscription_key, acked_offset, epoch) as (
        values ${Array.from({ length: rows }, () => "(?, ?, ?)").join(", ")}
      )
      update subscriptions as current
      set acked_offset = cursor_updates.acked_offset,
          attempt = 0,
          next_attempt_at = null,
          last_error = null,
          epoch = cursor_updates.epoch,
          pending_through_offset = null,
          pending_stream_max_offset = null,
          pending_attempt = null,
          pending_recovery_at = null
      from cursor_updates
      where current.subscription_key = cursor_updates.subscription_key
    `;
  }
  return statements;
}
