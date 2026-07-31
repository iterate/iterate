import { describe, expect, test } from "vitest";
import { assessPlaybackCounterPolicy } from "./playback-counter-policy.ts";

describe("playback counter policy", () => {
  test("fails as soon as any no-loss counter increases from the run baseline", () => {
    /*
     * A one-second metrics callback can be the first observable evidence of a
     * speaker deadline miss. Waiting only for an exact frame total then turns
     * that explicit incident into a misleading 30-second timeout and records
     * tens of seconds of unrelated room audio. The proof runner needs the
     * complete set of changed counters in one terminal diagnostic so the
     * retained artifact ends close to the actual fault.
     */
    expect(
      assessPlaybackCounterPolicy({
        baseline: {
          playback_dma_deadline_miss_incidents: 4,
          playback_underrun_frames_flushed: 2,
          playback_underrun_incidents: 2,
        },
        current: {
          playback_dma_deadline_miss_incidents: 5,
          playback_underrun_frames_flushed: 3,
          playback_underrun_incidents: 3,
        },
        maximumDeltas: {
          playback_dma_deadline_miss_incidents: 0,
          playback_underrun_frames_flushed: 0,
          playback_underrun_incidents: 0,
        },
      }),
    ).toEqual({
      /*
       * The violated counter list explains why the gate fired, but a
       * stochastic physical failure is not diagnosable without the coherent
       * timing, heap, stack, queue, and transport values from that same
       * callback. Keeping the full inputs on the failure object makes the
       * existing runner log a self-contained incident instead of forcing an
       * unreproducible rerun.
       */
      baseline: {
        playback_dma_deadline_miss_incidents: 4,
        playback_underrun_frames_flushed: 2,
        playback_underrun_incidents: 2,
      },
      current: {
        playback_dma_deadline_miss_incidents: 5,
        playback_underrun_frames_flushed: 3,
        playback_underrun_incidents: 3,
      },
      kind: "failure",
      maximumDeltas: {
        playback_dma_deadline_miss_incidents: 0,
        playback_underrun_frames_flushed: 0,
        playback_underrun_incidents: 0,
      },
      reason:
        "Playback proof counter policy failed: playback_dma_deadline_miss_incidents delta 1 exceeds 0; " +
        "playback_underrun_frames_flushed delta 1 exceeds 0; " +
        "playback_underrun_incidents delta 1 exceeds 0.",
      violations: [
        {
          baseline: 4,
          counter: "playback_dma_deadline_miss_incidents",
          current: 5,
          delta: 1,
          maximumDelta: 0,
          problem: "maximum-delta-exceeded",
        },
        {
          baseline: 2,
          counter: "playback_underrun_frames_flushed",
          current: 3,
          delta: 1,
          maximumDelta: 0,
          problem: "maximum-delta-exceeded",
        },
        {
          baseline: 2,
          counter: "playback_underrun_incidents",
          current: 3,
          delta: 1,
          maximumDelta: 0,
          problem: "maximum-delta-exceeded",
        },
      ],
    });
  });

  test("accepts unchanged historical incidents because the baseline scopes the proof", () => {
    /*
     * Reflashing before every diagnostic run is unnecessarily destructive and
     * hides whether counters survive ordinary reconnects. A prior incident is
     * evidence about the boot, but it is not evidence that this particular
     * playback failed; only a delta during the armed interval is terminal.
     */
    expect(
      assessPlaybackCounterPolicy({
        baseline: { playback_underrun_incidents: 7 },
        current: { playback_underrun_incidents: 7 },
        maximumDeltas: { playback_underrun_incidents: 0 },
      }),
    ).toEqual({ kind: "healthy" });
  });

  test("fails closed when a required counter is missing or regresses", () => {
    /*
     * Treating an absent or reset counter as zero can turn a firmware schema
     * mismatch or reboot into a clean run. Both outcomes invalidate a
     * before/after proof even when the audible artifact happens to look sane.
     */
    expect(
      assessPlaybackCounterPolicy({
        baseline: {
          playback_driver_failures: 3,
          playback_state_errors: 8,
        },
        current: {
          playback_state_errors: 1,
        },
        maximumDeltas: {
          playback_driver_failures: 0,
          playback_state_errors: 0,
        },
      }),
    ).toMatchObject({
      kind: "failure",
      violations: [
        {
          counter: "playback_driver_failures",
          problem: "missing-current",
        },
        {
          counter: "playback_state_errors",
          delta: -7,
          problem: "counter-regressed",
        },
      ],
    });
  });

  test("rejects UINT32_MAX because a saturated counter cannot prove zero new incidents", () => {
    /*
     * Firmware counters deliberately saturate rather than wrap. Once a
     * no-loss counter reaches UINT32_MAX, seeing the same value before and
     * after does not tell us whether this run added another incident.
     */
    expect(
      assessPlaybackCounterPolicy({
        baseline: { playback_underrun_incidents: 0xffff_ffff },
        current: { playback_underrun_incidents: 0xffff_ffff },
        maximumDeltas: { playback_underrun_incidents: 0 },
      }),
    ).toMatchObject({
      kind: "failure",
      violations: [
        {
          counter: "playback_underrun_incidents",
          problem: "counter-saturated",
        },
      ],
    });
  });
});
