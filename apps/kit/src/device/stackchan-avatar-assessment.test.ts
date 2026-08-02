import { describe, expect, test } from "vitest";
import type { KitAvatarMetrics } from "./kit-device-contract.ts";
import { assessStackChanAvatarRun, parseKitAvatarMetrics } from "./stackchan-avatar-assessment.ts";

function sample(overrides: Partial<KitAvatarMetrics> = {}): KitAvatarMetrics {
  return {
    schemaVersion: 1,
    producedAtMs: 1_000,
    ready: true,
    playoutObservations: 100,
    malformedObservations: 0,
    mailboxOverwrites: 2,
    mailboxFailures: 0,
    analyzerFrames: 80,
    analyzerSequenceGaps: 1,
    mouthOpenRenderedFrames: 10,
    snapshotRaces: 0,
    renderedFrames: 40,
    renderFailures: 0,
    displayTransfers: 40,
    displayTransferFailures: 0,
    displayTransferTimeouts: 0,
    maximumHandoffDelayUs: 4_000,
    maximumAnalyzerUs: 500,
    maximumRenderUs: 3_000,
    maximumDisplayTransferUs: 7_000,
    analyzerStackMinimumFreeBytes: 2_048,
    physicalPlayoutSampleClock: 12_800,
    currentAvatarIndex: 0,
    framebufferBytes: 38_400,
    ...overrides,
  };
}

describe("StackChan avatar evidence", () => {
  test("proves live speaker-clocked mouth and LCD progress", () => {
    const assessment = assessStackChanAvatarRun([
      sample(),
      sample({
        producedAtMs: 2_000,
        playoutObservations: 225,
        mailboxOverwrites: 5,
        analyzerFrames: 170,
        analyzerSequenceGaps: 4,
        mouthOpenRenderedFrames: 22,
        renderedFrames: 55,
        displayTransfers: 55,
        physicalPlayoutSampleClock: 28_800,
      }),
    ]);

    expect(assessment.passed).toBe(true);
    expect(assessment.progress.mouthOpenRenderedFrames).toBe(12);
    expect(assessment.progress.physicalPlayoutSamples).toBe(16_000);
    expect(assessment.loadShedding.mailboxOverwrites).toBe(3);
    expect(assessment.loadShedding.analyzerSequenceGaps).toBe(3);
  });

  test("does not mistake a retained LCD frame for a live talking avatar", () => {
    const assessment = assessStackChanAvatarRun([sample(), sample({ producedAtMs: 2_000 })]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "No completed mouth-open LCD frame was observed during audible playback.",
    );
    expect(assessment.reasons).toContain(
      "The physical speaker playout clock did not advance during the avatar proof.",
    );
  });

  test("fails real visual errors but permits latest-only load shedding", () => {
    const assessment = assessStackChanAvatarRun([
      sample(),
      sample({
        producedAtMs: 2_000,
        playoutObservations: 225,
        malformedObservations: 1,
        mailboxOverwrites: 25,
        analyzerFrames: 120,
        analyzerSequenceGaps: 20,
        mouthOpenRenderedFrames: 18,
        renderedFrames: 50,
        displayTransfers: 50,
        displayTransferTimeouts: 1,
        physicalPlayoutSampleClock: 28_800,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("Avatar playout observer rejected 1 frame.");
    expect(assessment.reasons).toContain("LCD transfers timed out 1 time.");
    expect(assessment.reasons.join(" ")).not.toContain("mailbox overwrite");
    expect(assessment.reasons.join(" ")).not.toContain("sequence gap");
  });

  test("rejects malformed callback payloads before they become physical evidence", () => {
    expect(() => parseKitAvatarMetrics({ ...sample(), ready: 1 })).toThrow("ready");
    expect(() => parseKitAvatarMetrics({ ...sample(), surprise: true })).toThrow("surprise");
  });
});
