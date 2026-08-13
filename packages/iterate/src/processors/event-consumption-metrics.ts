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
   * `append()` at t0, and its OWN event connection later delivered (and the host
   * fully ingested) the committed offset. Samples only exist when the host
   * appends — `null` is "no appends observed", never a fabricated number.
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
   * `atMs` is when the commit came back, `maxCommittedOffset` is the highest
   * offset the stream assigned. The loop closes in {@link noteBatchIngested}
   * when the host receives and processes through that offset.
   */
  noteAppendCommitted(args: { maxCommittedOffset: number; t0: number; atMs: number }): void {
    this.#appendRoundTrip.record(args.atMs - args.t0, args.atMs);
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
    /** `Date.parse(newestEvent.createdAt)` for the newest event in the batch, if any. */
    newestEventCreatedAtMs?: number;
    eventCount: number;
    /** When the host started ingesting this batch. */
    ingestStartedAtMs: number;
    atMs: number;
  }): void {
    this.#batchesIngested += 1;
    this.#eventsIngested += args.eventCount;
    this.#ingestedThroughOffset = Math.max(this.#ingestedThroughOffset, args.ingestedThroughOffset);
    this.#ingest.record(args.atMs - args.ingestStartedAtMs, args.atMs);
    if (
      typeof args.newestEventCreatedAtMs === "number" &&
      Number.isFinite(args.newestEventCreatedAtMs)
    ) {
      const hostNowOnStreamClock = args.atMs - (this.#clockOffsetMs ?? 0);
      this.#deliveryAge.record(hostNowOnStreamClock - args.newestEventCreatedAtMs, args.atMs);
    }
    if (this.#pendingOwnAppends.length > 0) {
      const settled = this.#pendingOwnAppends.filter((p) => p.offset <= args.ingestedThroughOffset);
      if (settled.length > 0) {
        this.#pendingOwnAppends = this.#pendingOwnAppends.filter(
          (p) => p.offset > args.ingestedThroughOffset,
        );
        for (const pending of settled) {
          this.#consumeOwnAppend.record(args.atMs - pending.t0, args.atMs);
        }
      }
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
