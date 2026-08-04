// What the device says about itself, and which of those numbers are verdicts.
//
// The device appends `voicelab/dev-stats` to the call's stream every 5s — the
// USB console resets the board, so the stream is the only observability
// channel that survives a run. Everything in here is about ONE question: given
// two samples, which differences mean something is broken?
//
// The three tiers below are not opinions. They are what a 26-minute call with
// 39 answered turns actually recorded: the fatal tiers stayed at zero for the
// whole run, and the tolerated tier did not. A counter that moves in a healthy
// call cannot be used to fail an unhealthy one.
import type { StreamEventBatch } from "iterate/node";

/**
 * One dev-stats sample, as the device reports it.
 *
 * Every field is optional because the publisher is firmware on the other side
 * of a wire: a field this file has never heard of must still arrive intact
 * (hence the index signature), and a field the firmware drops must not turn
 * arithmetic into `NaN`.
 */
export interface DeviceStats {
  /** Sample counter, from the device's own publisher. */
  seq?: number;
  /** The device's clock at publish time — its uptime, not wall clock. */
  t?: number;
  uptimeMs?: number;

  /* Coarse state: the first thing to look at when "it isn't working". */
  transport?: string;
  voicelab?: string;
  voicelabFailure?: string;
  callActive?: boolean;
  callPending?: boolean;
  wantsCall?: boolean;
  talking?: boolean;
  /**
   * The single gate every producer on the device sits behind.
   *
   * Shut, the device goes on answering capability calls while starting no
   * calls, sending no audio and publishing no telemetry — so a closed gate
   * looks exactly like a healthy device that has nothing to say.
   */
  gateOpen?: boolean;
  connectionState?: number;
  resetReason?: number;
  lastAppStatus?: number;

  /* Identity. A change here means something was replaced underneath us. */
  sessionGeneration?: number;
  connGeneration?: number;
  livenessRestarts?: number;
  bridgeLosses?: number;
  bridgeAgeMs?: number;
  downlinkRecycles?: number;

  /* Uplink (microphone). */
  micCaptured?: number;
  micDropped?: number;
  micIdle?: number;
  micGated?: number;
  framesSent?: number;
  frameFailures?: number;

  /* Downlink (speaker). The difference between these is the whole story of a
   * long answer: frames that arrived, frames that reached the DAC, and the
   * ones that did neither. */
  spkFrames?: number;
  spkPlayed?: number;
  spkWrites?: number;
  spkOverflow?: number;
  spkSoftDryRefills?: number;
  spkSoftDryTicks?: number;
  spkCatchup?: number;
  spkDebtPaid?: number;
  spkWriteFailures?: number;
  spkBadFrames?: number;
  spkSeqGaps?: number;
  spkDecodeFailures?: number;
  spkDiscarded?: number;
  spkIgnoredCall?: number;
  spkIgnoredStale?: number;
  spkIgnoredDup?: number;
  spkAnswerStarts?: number;
  spkSupersededMidplay?: number;
  spkWaitPriming?: number;
  spkAnswerDrains?: number;
  spkMarginMaxMs?: number;
  spkMarginMinMs?: number;
  spkMarginP10Ms?: number;
  spkLagMaxMs?: number;
  dmaLedgerDeficit?: number;
  dmaOpening?: number;
  dmaDraining?: number;
  spkStarvedMs?: number;
  spkStarveEvents?: number;
  dmaLargest?: number;
  /**
   * Button reads the device could not complete.
   *
   * Two names for one counter: the firmware renamed it `lowerReadFailures`,
   * and a board flashed before that still says `talkReadFailures`. Both are
   * read, so the same harness works either side of the rename.
   */
  talkReadFailures?: number;
  lowerReadFailures?: number;
  bargeIns?: number;

  /* Transport plumbing. */
  batches?: number;
  batchAgeMs?: number;
  wsSent?: number;
  rttMs?: number;
  pings?: number;
  pingFailures?: number;
  outboxUsed?: number;
  outboxSlots?: number;
  outboxDiscarded?: number;
  inboxPublished?: number;
  inboxConsumed?: number;
  inboxDiscarded?: number;
  inboxHighWater?: number;
  inboxDeferrals?: number;
  protoFailures?: number;
  recvFailures?: number;
  sendFailures?: number;

  /** Free internal heap right now, in bytes. */
  heapFree?: number;
  /** Lowest free internal heap since boot, in bytes. A floor, not a trend. */
  heapMin?: number;
  /**
   * Free PSRAM right now, in bytes.
   *
   * Read separately because image and audio buffers live there, so a leak in
   * PSRAM is completely invisible in `heapFree`. Absent on firmware older
   * than the field, and reported as zero by the host rig — a missing PSRAM
   * number is not a PSRAM of zero, and the report says which it was.
   */
  psramFree?: number;

  [key: string]: unknown;
}

/**
 * Transport and session integrity counters that must never move during a
 * healthy call. Proven at zero across a 26-minute, 39-turn call.
 */
export const MUST_NOT_MOVE = [
  "livenessRestarts",
  "bridgeLosses",
  "spkOverflow",
  "spkSeqGaps",
  "spkWriteFailures",
  "frameFailures",
  "sendFailures",
  "recvFailures",
  "protoFailures",
  "inboxDiscarded",
  "outboxDiscarded",
  "pingFailures",
] as const;

/**
 * Damage counters: audible holes in the answer, and audio the device could not
 * read at all. Also proven at zero across that call, so a run that moves one
 * of these has broken something a listener can hear.
 */
export const DAMAGE_MUST_NOT_MOVE = [
  "spkSoftDryRefills",
  "spkSoftDryTicks",
  "spkBadFrames",
  "spkDecodeFailures",
  "talkReadFailures",
  "lowerReadFailures",
  "micDropped",
] as const;

/**
 * Counters a healthy call DOES move, kept because their size is diagnostic
 * even though their existence is not a fault.
 *
 * `spkDiscarded` is the one to read first on a long answer: the bridge sends
 * audio as fast as the provider produces it, which is faster than realtime,
 * and a bounded playout ring can only hold so many seconds of it.
 *
 * `spkIgnoredDup` is the one to read when a whole answer was silent. Measured:
 * on the first turn of a call started right after a previous call on the same
 * stream, the playout refused all 163 frames as duplicates and played nothing.
 * Tolerated here because a redial legitimately re-sends frames — but a turn
 * whose audio it eats is a miss on its own account, so nothing hides behind it.
 */
export const TOLERATED_COUNTERS = [
  "spkDiscarded",
  "spkAnswerStarts",
  "spkSupersededMidplay",
  "spkCatchup",
  "spkDebtPaid",
  "spkAnswerDrains",
  "spkIgnoredCall",
  "spkIgnoredStale",
  "spkIgnoredDup",
  "dmaLedgerDeficit",
  "dmaOpening",
  "dmaDraining",
  "spkStarvedMs",
  "spkStarveEvents",
  "downlinkRecycles",
  "bargeIns",
  "inboxDeferrals",
] as const;

/** 20ms of PCM16 mono at 16kHz — one speaker frame, on the wire and in the ring. */
export const FRAME_MS = 20;
/** Bytes of PCM16 in one 20ms frame at 16kHz. */
export const FRAME_BYTES = 640;

/** Difference in one numeric counter between two samples, missing fields as zero. */
export function counterDelta(
  from: DeviceStats | undefined,
  to: DeviceStats | undefined,
  key: string,
) {
  return Number(to?.[key] ?? 0) - Number(from?.[key] ?? 0);
}

/** Every counter in `keys` that moved between two samples, and by how much. */
export function movedCounters(
  from: DeviceStats | undefined,
  to: DeviceStats | undefined,
  keys: readonly string[],
) {
  const moved: Record<string, number> = {};
  if (!from || !to) return moved;
  for (const key of keys) {
    const delta = counterDelta(from, to, key);
    if (delta !== 0) moved[key] = delta;
  }
  return moved;
}

/** Nearest-rank percentile over unsorted numbers; `null` when there is nothing to rank. */
export function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[rank]!;
}

/** Median, max and p95 of a set of measurements, or nulls when empty. */
export function spread(values: readonly number[]) {
  return {
    count: values.length,
    max: values.length === 0 ? null : Math.max(...values),
    median: percentile(values, 0.5),
    min: values.length === 0 ? null : Math.min(...values),
    p95: percentile(values, 0.95),
  };
}

/**
 * Least-squares slope of a series against its own index, scaled to whatever
 * unit the caller's `perStep` is. Used for the heap trend: a leak is a slope,
 * and no single sample can show one.
 */
export function slopePerStep(values: readonly number[]) {
  if (values.length < 2) return 0;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / n;
  let top = 0;
  let bottom = 0;
  for (const [index, value] of values.entries()) {
    top += (index - meanX) * (value - meanY);
    bottom += (index - meanX) ** 2;
  }
  return bottom === 0 ? 0 : top / bottom;
}

/** The events half of a delivery batch, as a stream hands it to a callback. */
export type DeliveredEvents = StreamEventBatch["events"];
