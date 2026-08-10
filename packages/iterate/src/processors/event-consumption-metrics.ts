// Self-measured event-consumption metrics, shared by every processor host.
//
// The stream can only observe dispatch; whether (and how fast) a processor
// actually CONSUMED a batch is knowledge the processor host alone has. So each
// host — the server-side processor host and the browser store, which runs
// the same stream processors — owns one of these per running processor
// and reports it through the `getRuntimeState` capability the stream already
// retains (`ProcessorRuntimeState.runtime.metrics`). No new reporting
// channel, and hosts that predate this simply report nothing.
//
// Pure and clock-free like the delivery math atop stream-event-sender.ts:
// every method takes timestamps as arguments, so the whole thing unit-tests
// in plain node and runs unchanged in a browser (performance-now deltas) or a
// worker (Date.now).

import { LatencyRing, type LatencyStats } from "./stream-runtime-metrics.ts";

/** The `runtime.metrics` slice a host reports through `getRuntimeState()`. */
export type EventConsumptionMetricsReport = {
  /** ISO timestamp when this host runtime started measuring (in-memory; resets on reload). */
  measuredSince: string;
  /**
   * The full consume-your-own-appends loop, one clock: this host called
   * `append()` at t0, and its OWN event connection later delivered (and the
   * host fully ingested) THAT COMMITTED OFFSET.
   *
   * Samples only exist for appends that came back. An append of a type this
   * host does not consume, or one the stream never hands back, contributes
   * NOTHING here — it is not a slow loop, it is no loop, and the two must not
   * be spelled the same. `null` is "no such append observed", never a
   * fabricated number.
   */
  consumeOwnAppendMs: LatencyStats | null;
  /** `append()` call → commit acknowledged (the RPC round trip incl. commit). */
  appendRoundTripMs: LatencyStats | null;
  /**
   * Age of the newest event in each batch when the host finished ingesting
   * it, i.e. commit-to-consumed for OTHER producers' events too. Crosses
   * clocks (event `createdAt` is stream time), corrected by the ping-derived
   * offset estimate when one exists — an estimate, and labeled as such in UIs.
   */
  deliveryAgeMs: LatencyStats | null;
  /** Time the host spent ingesting each delivered batch (fold/SQLite write). */
  ingestMs: LatencyStats | null;
  batchesIngested: number;
  eventsIngested: number;
  /** Estimated host−stream clock skew (ms) from observed pings; `null` until pinged. */
  clockOffsetMs: number | null;
};

/** In-flight own-append correlation entries beyond this are dropped oldest-first. */
const MAX_PENDING_OWN_APPENDS = 16;

export class EventConsumptionMetrics {
  readonly #measuredSinceMs: number;
  readonly #consumeOwnAppend = new LatencyRing();
  readonly #appendRoundTrip = new LatencyRing();
  readonly #deliveryAge = new LatencyRing();
  readonly #ingest = new LatencyRing();
  #batchesIngested = 0;
  #eventsIngested = 0;
  #clockOffsetMs: number | null = null;
  /** Highest offset this host has ingested through (see noteBatchIngested). */
  #ingestedThroughOffset = 0;
  /** Own appends awaiting their loop-back delivery: committed offset + call-start time. */
  #pendingOwnAppends: { offset: number; t0: number }[] = [];

  constructor(nowMs: number) {
    this.#measuredSinceMs = nowMs;
  }

  /**
   * An `append()` this host issued resolved: `t0` is when the host called it,
   * `atMs` is when the commit came back, and `maxCommittedOffset` is the
   * highest committed offset that CAN come back to this host — the caller's
   * judgement, because only the caller knows what it consumes. `null` means
   * the append carried nothing this host will ever be delivered, and is timed
   * for its round trip alone.
   */
  noteAppendCommitted(args: { maxCommittedOffset: number | null; t0: number; atMs: number }): void {
    this.#appendRoundTrip.record(args.atMs - args.t0, args.atMs);
    if (args.maxCommittedOffset === null) return;
    // The stream fans out BEFORE the append call returns, so our own
    // event callback may have ingested the offset already — in that case the
    // loop closed the moment both halves were done, which is now. Only a
    // still-unseen offset goes on the pending list.
    if (args.maxCommittedOffset <= this.#ingestedThroughOffset) {
      this.#consumeOwnAppend.record(args.atMs - args.t0, args.atMs);
      return;
    }
    this.#pendingOwnAppends.push({ offset: args.maxCommittedOffset, t0: args.t0 });
    if (this.#pendingOwnAppends.length > MAX_PENDING_OWN_APPENDS) {
      this.#pendingOwnAppends.splice(0, this.#pendingOwnAppends.length - MAX_PENDING_OWN_APPENDS);
    }
  }

  /** One delivered batch fully ingested (fold applied / SQLite write done). */
  noteBatchIngested(args: {
    /** Highest offset the host has now ingested through (its cursor, not just this batch). */
    ingestedThroughOffset: number;
    /**
     * The offsets this batch actually CARRIED.
     *
     * The cursor above sweeps past rows this host was never handed — a
     * filtered subscription skips them durably — so it cannot tell an own
     * append that came back from one that never will. These can.
     */
    ingestedOffsets: readonly number[];
    /** `Date.parse(newestEvent.createdAt)` for the newest event in the batch, if any. */
    newestEventCreatedAtMs?: number;
    /** When the host started ingesting this batch. */
    ingestStartedAtMs: number;
    atMs: number;
  }): void {
    this.#batchesIngested += 1;
    this.#eventsIngested += args.ingestedOffsets.length;
    this.#ingestedThroughOffset = Math.max(this.#ingestedThroughOffset, args.ingestedThroughOffset);
    this.#ingest.record(args.atMs - args.ingestStartedAtMs, args.atMs);
    if (args.newestEventCreatedAtMs !== undefined && Number.isFinite(args.newestEventCreatedAtMs)) {
      const hostNowOnStreamClock = args.atMs - (this.#clockOffsetMs ?? 0);
      this.#deliveryAge.record(hostNowOnStreamClock - args.newestEventCreatedAtMs, args.atMs);
    }
    if (this.#pendingOwnAppends.length > 0) {
      const stillPending: { offset: number; t0: number }[] = [];
      for (const pending of this.#pendingOwnAppends) {
        if (pending.offset > args.ingestedThroughOffset) {
          stillPending.push(pending);
          continue;
        }
        // The cursor is now past this correlation, so it is over either way.
        // A SAMPLE, though, only when the batch actually carried the offset:
        // that is the append→consume loop this metric names. Anything else —
        // a row the subscription filtered out, an ephemeral event evicted
        // before delivery — never looped at all, and timing the wait until
        // some later unrelated event happened along is how this metric came
        // to report a person's pause between sentences as consumption lag.
        if (args.ingestedOffsets.includes(pending.offset)) {
          this.#consumeOwnAppend.record(args.atMs - pending.t0, args.atMs);
        }
      }
      this.#pendingOwnAppends = stillPending;
    }
  }

  /**
   * The stream pinged this host: `t0` is the stream's send time (stream
   * clock), `t1` the host's receive time (host clock). With a one-way-delay
   * estimate (half the host's measured transport RTT, when it has one) this
   * yields the host−stream clock offset used to correct delivery ages.
   */
  notePingObserved(args: { t0: number; t1: number; oneWayEstimateMs?: number }): void {
    this.#clockOffsetMs = args.t1 - args.t0 - (args.oneWayEstimateMs ?? 0);
  }

  /** The host's event connection reopened: in-flight own-append correlations are void. */
  clearPendingAppends(): void {
    this.#pendingOwnAppends = [];
  }

  report(): EventConsumptionMetricsReport {
    return {
      measuredSince: new Date(this.#measuredSinceMs).toISOString(),
      consumeOwnAppendMs: this.#consumeOwnAppend.stats(),
      appendRoundTripMs: this.#appendRoundTrip.stats(),
      deliveryAgeMs: this.#deliveryAge.stats(),
      ingestMs: this.#ingest.stats(),
      batchesIngested: this.#batchesIngested,
      eventsIngested: this.#eventsIngested,
      clockOffsetMs: this.#clockOffsetMs,
    };
  }
}
