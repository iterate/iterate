import { describe, expect, test } from "vitest";
import type { DeviceRuntimeMetrics } from "./device-runtime-log.ts";
import type { KitSynchronousPlaybackHealthMetrics } from "./kit-device-contract.ts";
import {
  assessPhysicalAecStartupTransition,
  derivePhysicalAecLifecycleDelta,
} from "./physical-aec-lifecycle.ts";

/*
 * The physical generation barrier is both necessary and destructive. These
 * tests preserve the distinction we need operationally: its one empty-buffer
 * reset is valid startup, but the same reset during a measured interval—or a
 * startup reset that discards even one frame—is evidence of broken audio.
 */
describe("physical AEC lifecycle ledgers", () => {
  test("accepts exactly one lossless startup generation barrier", () => {
    const before = fixture(10);
    const after = fixture(10);
    before.playback.lifetimePlaybackResets = 0;
    after.playback.lifetimePlaybackResets = 1;

    expect(
      assessPhysicalAecStartupTransition({
        afterGeneral: after.general,
        afterPlayback: after.playback,
        beforeGeneral: before.general,
        beforePlayback: before.playback,
      }),
    ).toEqual({
      observed: {
        captureFailures: 0,
        captureFrameDrops: 0,
        playbackDroppedFrames: 0,
        playbackIntegrityFailures: 0,
        playbackResets: 1,
        uplinkFrameDrops: 0,
        uplinkRestarts: 0,
      },
      passed: true,
      reasons: [],
    });
  });

  test("accepts the sole lossless barrier when lifetime prewarming beats subscription", () => {
    /*
     * A direct-LAN peer can establish the lifetime `/pcm` generation before
     * the first one-second metrics callback. Conversation media gating must
     * not reset that already-warm generation again. The absolute post-start
     * counter is the invariant; requiring a delta of one made fast transports
     * fail while slower Captun happened to pass.
     */
    const before = fixture(0);
    const after = fixture(0);
    before.playback.lifetimePlaybackResets = 1;
    after.playback.lifetimePlaybackResets = 1;

    expect(
      assessPhysicalAecStartupTransition({
        afterGeneral: after.general,
        afterPlayback: after.playback,
        beforeGeneral: before.general,
        beforePlayback: before.playback,
      }),
    ).toMatchObject({ passed: true, reasons: [] });
  });

  test("rejects a missing or duplicate absolute startup barrier", () => {
    const missingBefore = fixture(0);
    const missingAfter = fixture(0);
    const duplicateBefore = fixture(0);
    const duplicateAfter = fixture(0);
    duplicateBefore.playback.lifetimePlaybackResets = 1;
    duplicateAfter.playback.lifetimePlaybackResets = 2;

    expect(
      assessPhysicalAecStartupTransition({
        afterGeneral: missingAfter.general,
        afterPlayback: missingAfter.playback,
        beforeGeneral: missingBefore.general,
        beforePlayback: missingBefore.playback,
      }).reasons,
    ).toContain("Startup generation barrier lifetime count was 0; expected exactly 1.");
    expect(
      assessPhysicalAecStartupTransition({
        afterGeneral: duplicateAfter.general,
        afterPlayback: duplicateAfter.playback,
        beforeGeneral: duplicateBefore.general,
        beforePlayback: duplicateBefore.playback,
      }).reasons,
    ).toContain("Startup generation barrier lifetime count was 2; expected exactly 1.");
  });

  test("rejects the previously observed first-frame loss instead of baselining it away", () => {
    const before = fixture(20);
    const after = fixture(20);
    before.playback.lifetimePlaybackResets = 0;
    after.playback.lifetimePlaybackResets = 1;
    after.general.uplink_dropped = Number(after.general.uplink_dropped) + 1;

    const assessment = assessPhysicalAecStartupTransition({
      afterGeneral: after.general,
      afterPlayback: after.playback,
      beforeGeneral: before.general,
      beforePlayback: before.playback,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("Startup reported 1 uplink frame drops; expected 0.");
  });

  test("keeps a later reset in the measured media ledger", () => {
    const before = fixture(30);
    const after = fixture(30);
    after.playback.lifetimePlaybackResets += 1;
    after.playback.lifetimePlaybackFramesDiscardedByReset += 2;

    expect(
      derivePhysicalAecLifecycleDelta({
        afterGeneral: after.general,
        afterPlayback: after.playback,
        beforeGeneral: before.general,
        beforePlayback: before.playback,
      }),
    ).toMatchObject({ playbackDroppedFrames: 2, playbackResets: 1 });
  });

  test("fails closed when a required counter is absent or regresses", () => {
    const before = fixture(40);
    const after = fixture(40);
    delete after.general.audio_dropped;
    after.playback.lifetimePlaybackWriteFailures = 39;

    expect(
      derivePhysicalAecLifecycleDelta({
        afterGeneral: after.general,
        afterPlayback: after.playback,
        beforeGeneral: before.general,
        beforePlayback: before.playback,
      }),
    ).toMatchObject({ captureFrameDrops: 1, playbackIntegrityFailures: 1 });
  });

  /*
   * A codec can keep accepting writes while the device inserts silence because
   * no fresh network frame is available. The destructive ledger must therefore
   * count hardware-clock starvation and age-policy discards, not just API/queue
   * failures; otherwise the exact choppy physical run that motivated these
   * counters is reported as lossless.
   */
  test("classifies speaker-clock starvation and stale media as destructive", () => {
    const before = fixture(50);
    const after = fixture(50);
    after.playback.lifetimePlaybackUnderrunIncidents += 1;
    after.playback.lifetimePlaybackUnderrunSilenceSamples += 160;
    after.playback.lifetimePlaybackStaleFramesDiscarded += 2;

    expect(
      derivePhysicalAecLifecycleDelta({
        afterGeneral: after.general,
        afterPlayback: after.playback,
        beforeGeneral: before.general,
        beforePlayback: before.playback,
      }),
    ).toMatchObject({ playbackDroppedFrames: 2, playbackIntegrityFailures: 1 });
  });
});

function fixture(value: number): {
  general: DeviceRuntimeMetrics;
  playback: KitSynchronousPlaybackHealthMetrics;
} {
  return {
    general: {
      audio_dropped: value,
      audio_failures: value,
      uplink_dropped: value,
      uplink_restart_incidents: value,
    },
    playback: {
      lifetimePlaybackContentSamples: value,
      lifetimePlaybackResets: value,
      lifetimePlaybackFramesDiscardedByReset: value,
      lifetimePlaybackWriteFailures: value,
      lifetimePlaybackQueueOverflows: value,
      lifetimePlaybackPolicyErrors: value,
      lifetimePlaybackResetFailures: value,
      lifetimePlaybackObservationFailures: value,
      lifetimePlaybackUnderrunIncidents: value,
      lifetimePlaybackUnderrunSilenceSamples: value,
      lifetimePlaybackStaleFramesDiscarded: value,
      lastPlaybackWriteUs: value,
      maximumPlaybackWriteUs: value,
      lastReceiveToRenderMs: value,
      maximumReceiveToRenderMs: value,
    },
  };
}
