import { describe, expect, test } from "vitest";
import {
  assessPlaybackRecoveryProof,
  playbackRecoveryIsComplete,
  playbackRecoverySafetyMaximumDeltas,
} from "./playback-recovery-policy.ts";

const strictMaximumDeltas = {
  playback_driver_queue_overflow_incidents: 0,
  playback_driver_failures: 0,
  playback_underrun_frames_flushed: 0,
  playback_underrun_incidents: 0,
  playback_underrun_late_frames_dropped: 0,
  playback_underrun_silence_frames_completed: 0,
  playback_underrun_silence_frames_retired: 0,
  playback_underrun_silence_frames_submitted: 0,
  playback_write_backpressure_destructive_resets: 0,
};

function recoveryMetrics(overrides: Readonly<Record<string, number>> = {}): Record<string, number> {
  return {
    downlink_accepted: 500,
    playback_completed: 492,
    playback_driver_failures: 0,
    playback_driver_queue_overflow_incidents: 0,
    playback_end_of_stream_markers_consumed: 1,
    playback_end_of_stream_responses: 1,
    playback_submitted: 492,
    playback_underrun_frames_flushed: 0,
    playback_underrun_incidents: 7,
    playback_underrun_late_frames_dropped: 8,
    playback_underrun_silence_frames_completed: 8,
    playback_underrun_silence_frames_retired: 0,
    playback_underrun_silence_frames_submitted: 8,
    playback_write_backpressure_destructive_resets: 0,
    ...overrides,
  };
}

describe("bounded playback recovery proof", () => {
  test("conserves every source slot without allowing a stale PCM backlog", () => {
    /*
     * Eight missing playout slots are replaced by eight silence descriptors
     * and the corresponding eight late content frames are discarded. Content
     * plus discard must still account for all 500 wire frames, and completed
     * silence must catch up before the proof ends. This is the precise
     * distinction between bounded realtime recovery and merely hiding loss in
     * another queue.
     */
    const baseline = recoveryMetrics({
      downlink_accepted: 0,
      playback_completed: 0,
      playback_end_of_stream_markers_consumed: 0,
      playback_end_of_stream_responses: 0,
      playback_submitted: 0,
      playback_underrun_incidents: 0,
      playback_underrun_late_frames_dropped: 0,
      playback_underrun_silence_frames_completed: 0,
      playback_underrun_silence_frames_retired: 0,
      playback_underrun_silence_frames_submitted: 0,
    });
    const current = recoveryMetrics();

    expect(
      assessPlaybackRecoveryProof({
        baseline,
        current,
        expectedContentFrames: 500,
        safetyMaximumDeltas: playbackRecoverySafetyMaximumDeltas(strictMaximumDeltas),
      }),
    ).toEqual({
      incidentCount: 7,
      kind: "healthy",
      recoveryFrameCount: 8,
    });
    expect(playbackRecoveryIsComplete({ baseline, current, expectedContentFrames: 500 })).toBe(
      true,
    );
  });

  test("accepts an exact clean-EOS retirement instead of waiting through a silent tail", () => {
    /*
     * The physical Stick can complete its last content descriptor while a
     * recovery-silence descriptor remains later in the DMA cycle. Synchronous
     * EOS stop must retire that descriptor immediately: waiting for its EOF
     * adds latency, while treating it as completed makes a false physical
     * claim. The two dispositions together still conserve every submitted
     * recovery descriptor.
     */
    const baseline = recoveryMetrics({
      downlink_accepted: 0,
      playback_completed: 0,
      playback_end_of_stream_markers_consumed: 0,
      playback_end_of_stream_responses: 0,
      playback_submitted: 0,
      playback_underrun_incidents: 0,
      playback_underrun_late_frames_dropped: 0,
      playback_underrun_silence_frames_completed: 0,
      playback_underrun_silence_frames_retired: 0,
      playback_underrun_silence_frames_submitted: 0,
    });
    const current = recoveryMetrics({
      playback_underrun_silence_frames_completed: 7,
      playback_underrun_silence_frames_retired: 1,
    });

    expect(
      assessPlaybackRecoveryProof({
        baseline,
        current,
        expectedContentFrames: 500,
        safetyMaximumDeltas: playbackRecoverySafetyMaximumDeltas(strictMaximumDeltas),
      }),
    ).toEqual({
      incidentCount: 7,
      kind: "healthy",
      recoveryFrameCount: 8,
    });
  });

  test("does not report completion while a silence descriptor or source frame is unaccounted", () => {
    /*
     * The first physical schema-2 sample observed eight silence submissions
     * but only seven completions because the runner stopped mid-incident.
     * Treating that sample as a pass would reproduce the exact mistake this
     * mode exists to prevent: a locally submitted descriptor is not yet a
     * consumed physical slot.
     */
    const baseline = recoveryMetrics({
      downlink_accepted: 0,
      playback_completed: 0,
      playback_end_of_stream_markers_consumed: 0,
      playback_end_of_stream_responses: 0,
      playback_submitted: 0,
      playback_underrun_incidents: 0,
      playback_underrun_late_frames_dropped: 0,
      playback_underrun_silence_frames_completed: 0,
      playback_underrun_silence_frames_retired: 0,
      playback_underrun_silence_frames_submitted: 0,
    });
    const incomplete = recoveryMetrics({
      playback_underrun_silence_frames_completed: 7,
    });

    expect(
      playbackRecoveryIsComplete({
        baseline,
        current: incomplete,
        expectedContentFrames: 500,
      }),
    ).toBe(false);
    expect(
      assessPlaybackRecoveryProof({
        baseline,
        current: incomplete,
        expectedContentFrames: 500,
        safetyMaximumDeltas: playbackRecoverySafetyMaximumDeltas(strictMaximumDeltas),
      }),
    ).toMatchObject({
      kind: "failure",
      reasons: expect.arrayContaining([
        "recovery silence completed delta 7 plus retired delta 0 does not equal submitted delta 8",
      ]),
    });
  });

  test("keeps overflow, destructive reset, and ordinary flushes terminal", () => {
    /*
     * Recovery mode relaxes only the five counters that describe its intended
     * silence/drop mechanism. It is not a generic “allow errors” switch:
     * losing ESP-IDF's finished pointer or recreating the channel remains a
     * failed real-device result.
     */
    expect(playbackRecoverySafetyMaximumDeltas(strictMaximumDeltas)).toEqual({
      playback_driver_failures: 0,
      playback_driver_queue_overflow_incidents: 0,
      playback_underrun_frames_flushed: 0,
      playback_write_backpressure_destructive_resets: 0,
    });
  });
});
