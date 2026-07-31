import { describe, expect, test } from "vitest";
import {
  playbackEnduranceDurationsMs,
  runPlaybackEnduranceLadder,
  type PlaybackEnduranceLoadProfile,
  type PlaybackEnduranceRunObservation,
  type PlaybackEnduranceThresholds,
} from "./playback-endurance-ladder.ts";

const idleLoad: PlaybackEnduranceLoadProfile = {
  id: "idle",
  kind: "idle",
};

const loadedCpu: PlaybackEnduranceLoadProfile = {
  id: "capability-churn",
  kind: "loaded",
  requested: {
    concurrentWorkerCount: 1,
    targetCpuPermille: 250,
    workUnit: "render-and-metrics-cycle",
    workUnitsPerSecond: 20,
  },
};

const thresholds: PlaybackEnduranceThresholds = {
  acoustic: {
    maximumAmplitudeStepDecibels: 1.5,
    maximumAmplitudeStepP99Decibels: 1.5,
    maximumDurationErrorMs: 20,
    maximumInternalGapMs: 0,
    maximumMissingToneMs: 20,
    maximumPhaseStepErrorRadians: 0.1,
  },
  acousticPolicy: {
    expectedToneFrequencyHz: 1_000,
    expectedWindowDurationMs: 5,
    maximumAbsoluteRelativeClockDriftPpm: 500,
    relativeClockDriftRequiredAtOrAboveDurationMs: 600_000,
  },
  counterMaximumDeltas: {
    playback_failures: 0,
  },
  counterExpectedDeltas: {
    playback_end_of_stream_markers_consumed: 1,
    playback_end_of_stream_responses: 1,
  },
  loadEvidence: {
    maximumAudioOwnerCoreCpuPermille: 500,
    minimumAppliedWorkUnits: 1,
    minimumBackgroundCoreCpuPermille: 1,
    minimumCpuTimeMs: 1,
    minimumRequestedCpuFraction: 0.8,
    minimumRequestedWorkFraction: 0.9,
    maximumAudioDeadlineMisses: 0,
    maximumAudioServiceLatencyMs: 5,
  },
  maximumRunDurationErrorMs: 20,
  metricMaximumValues: {
    audio_deadline_misses: 0,
  },
  metricMinimumValues: {
    free_internal_heap_bytes: 1,
  },
  metricsCadence: {
    expectedIntervalMs: 1_000,
    maximumIntervalMs: 1_100,
  },
  pcmFrameDurationMs: 20,
};

function passingObservation(
  durationMs: number,
  loadProfile: PlaybackEnduranceLoadProfile,
): PlaybackEnduranceRunObservation {
  const expectedFrameCount = durationMs / 20;
  const metricSamples: PlaybackEnduranceRunObservation["metricSamples"] = [];
  for (let sampleMs = 0; sampleMs <= durationMs; sampleMs += 1_000) {
    metricSamples.push({
      capturedAtMonotonicMs: sampleMs,
      deviceBootId: "boot-001",
      deviceProducedAtMonotonicMs: sampleMs,
      deviceSequence: sampleMs / 1_000,
      values: {
        audio_deadline_misses: 0,
        free_internal_heap_bytes: 220_000,
      },
    });
  }
  return {
    acoustic: {
      analysis: {
        activeWindowCount: durationMs / 2.5,
        amplitudeCoefficientOfVariation: 0.01,
        amplitudeStepP99Decibels: 0.1,
        maximumAmplitudeStepDecibels: 0.1,
        excludedCoherentWindowCount: 0,
        expectedDurationMs: durationMs,
        gapCount: 0,
        longestInternalGapMs: 0,
        maximumPhaseStepErrorRadians: 0.01,
        medianPhaseStepRadians: 0.2,
        medianToneAmplitude: 8_000,
        missingToneMs: 0,
        observedEndMs: durationMs,
        observedSpanMs: durationMs,
        observedStartMs: 0,
        phaseDiscontinuityCount: 0,
        phaseDiscontinuityThresholdRadians: 0.1,
        phaseStepSpanMs: 5,
        sampleRateHz: 48_000,
        toneFrequencyHz: 1_000,
        toneWindowRatio: 1,
        totalDurationMs: durationMs,
        windowDurationMs: 5,
        windowStepMs: 2.5,
      },
      artifact: {
        byteLength: durationMs * 96,
        format: "pcm-s16le-mono",
        hashVerification: {
          computedSha256: "b".repeat(64),
          matched: true,
        },
        path: `/retained/playback-${durationMs}.pcm16le`,
        sampleRateHz: 48_000,
        sha256: "b".repeat(64),
      },
      relativeClockDriftPpm: durationMs >= 600_000 ? 125 : "unavailable",
    },
    completedAtIso: new Date(Date.parse("2026-07-30T12:00:00.000Z") + durationMs).toISOString(),
    countersAfter: {
      downlink_accepted: 10 + expectedFrameCount,
      playback_completed: 10 + expectedFrameCount,
      playback_end_of_stream_markers_consumed: 11,
      playback_end_of_stream_responses: 11,
      playback_failures: 0,
      playback_submitted: 10 + expectedFrameCount,
    },
    countersBefore: {
      downlink_accepted: 10,
      playback_completed: 10,
      playback_end_of_stream_markers_consumed: 10,
      playback_end_of_stream_responses: 10,
      playback_failures: 0,
      playback_submitted: 10,
    },
    loadEvidence:
      loadProfile.kind === "idle"
        ? {
            appliedWorkUnits: 0,
            audioDeadlineMisses: 0,
            audioOwnerCoreCpuPermille: 80,
            backgroundCoreCpuPermille: 0,
            cpuTimeMs: 0,
            maximumAudioServiceLatencyMs: 0,
          }
        : {
            appliedWorkUnits: (durationMs / 1_000) * 20,
            audioDeadlineMisses: 0,
            audioOwnerCoreCpuPermille: 80,
            backgroundCoreCpuPermille: 251,
            cpuTimeMs: durationMs * 0.251,
            maximumAudioServiceLatencyMs: 2,
          },
    metricSamples,
    playbackCompletedAtMonotonicMs: durationMs,
    playbackStartedAtMonotonicMs: 0,
    startedAtIso: "2026-07-30T12:00:00.000Z",
  };
}

async function runWithObservationMutation(
  mutate: (
    observation: PlaybackEnduranceRunObservation,
    durationMs: number,
    loadProfile: PlaybackEnduranceLoadProfile,
  ) => void,
  loadProfiles: PlaybackEnduranceLoadProfile[] = [idleLoad],
) {
  const requestedDurations: number[] = [];
  const result = await runPlaybackEnduranceLadder({
    loadProfiles,
    target: {
      inspect: async () => ({
        device: { family: "m5sticks3", stableId: "70:04:1D:D5:45:88" },
        firmware: { algorithm: "sha256", value: "a".repeat(64) },
      }),
      runPlayback: async (request) => {
        requestedDurations.push(request.durationMs);
        const observation = passingObservation(request.durationMs, request.loadProfile);
        mutate(observation, request.durationMs, request.loadProfile);
        return observation;
      },
    },
    thresholds,
  });
  return { requestedDurations, result };
}

describe("playback endurance ladder", () => {
  test("graduates through one, two, and ten minutes and emits persistence-ready proof", async () => {
    /*
     * Long playback is useful only if every device runs the same escalating
     * proof. Keeping the durations in the core prevents one target adapter
     * from quietly substituting a short smoke test and calling it endurance.
     * The fake target completes instantly, so this checks the production
     * durations without making the unit test itself wait thirteen minutes.
     */
    const requestedDurations: number[] = [];
    const result = await runPlaybackEnduranceLadder({
      loadProfiles: [idleLoad],
      target: {
        inspect: async () => ({
          device: {
            family: "m5sticks3",
            stableId: "70:04:1D:D5:45:88",
          },
          firmware: {
            algorithm: "sha256",
            value: "a".repeat(64),
          },
        }),
        runPlayback: async (request) => {
          requestedDurations.push(request.durationMs);
          return passingObservation(request.durationMs, request.loadProfile);
        },
      },
      thresholds,
    });

    expect(playbackEnduranceDurationsMs).toEqual([60_000, 120_000, 600_000]);
    expect(requestedDurations).toEqual([60_000, 120_000, 600_000]);
    expect(result.passed).toBe(true);
    expect(result.plannedRunCount).toBe(3);
    expect(result.runs).toHaveLength(3);
    expect(result.runs[0]).toMatchObject({
      acoustic: {
        artifact: {
          path: "/retained/playback-60000.pcm16le",
          sha256: "b".repeat(64),
        },
        assessment: { passed: true, reasons: [] },
        relativeClockDriftPpm: "unavailable",
      },
      counters: {
        deltas: {
          downlink_accepted: 3_000,
          playback_completed: 3_000,
          playback_failures: 0,
          playback_submitted: 3_000,
        },
      },
      device: {
        family: "m5sticks3",
        stableId: "70:04:1D:D5:45:88",
      },
      durationMs: 60_000,
      firmware: {
        algorithm: "sha256",
        value: "a".repeat(64),
      },
      frameAccounting: {
        acceptedDelta: 3_000,
        completedDelta: 3_000,
        expectedFrameCount: 3_000,
        submittedDelta: 3_000,
      },
      metricsCadence: {
        expectedMinimumSampleCount: 60,
        maximumObservedGapMs: 1_000,
        missingSampleCount: 0,
        outOfOrderSampleCount: 0,
        sampleCount: 61,
      },
      metricSamples: expect.arrayContaining([
        {
          capturedAtMonotonicMs: 30_000,
          deviceBootId: "boot-001",
          deviceProducedAtMonotonicMs: 30_000,
          deviceSequence: 30,
          values: {
            audio_deadline_misses: 0,
            free_internal_heap_bytes: 220_000,
          },
        },
      ]),
      metricThresholdBreaches: [],
      result: { passed: true, reasons: [] },
      schemaVersion: 1,
      thresholds,
    });
    /*
     * A manifest that contains Date, bigint, callbacks, or undefined-valued
     * evidence may look fine in memory and then lose proof when written as
     * JSONL. Round-tripping here makes persistence a property of the public
     * result rather than an assumption made by each CLI.
     */
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("persists each judged run before beginning the next physical stage", async () => {
    /*
     * A ten-minute run can be terminated by unplugging the hub, a host crash,
     * or a later load-profile failure. Waiting until the whole ladder returns
     * would lose the already-complete one- and two-minute proofs. The hook is
     * therefore part of the sequencing contract: stage N+1 cannot begin until
     * stage N's immutable manifest has reached the caller's evidence sink.
     */
    const persistedIndexes: number[] = [];
    const result = await runPlaybackEnduranceLadder({
      loadProfiles: [idleLoad],
      onRunManifest: async (manifest) => {
        persistedIndexes.push(manifest.ladderIndex);
      },
      target: {
        inspect: async () => ({
          device: { family: "m5sticks3", stableId: "70:04:1D:D5:45:88" },
          firmware: { algorithm: "sha256", value: "a".repeat(64) },
        }),
        runPlayback: async (request) => {
          expect(persistedIndexes).toHaveLength(request.ladderIndex);
          return passingObservation(request.durationMs, request.loadProfile);
        },
      },
      thresholds,
    });

    expect(result.passed).toBe(true);
    expect(persistedIndexes).toEqual([0, 1, 2]);
  });

  test("classifies caller-defined thresholds as diagnostic rather than acceptance", async () => {
    /*
     * The generic engine is intentionally useful for tuning, but arbitrary
     * callers can omit load or loosen every ceiling. A green diagnostic must
     * never be mistaken for the versioned release gate; only a target-specific
     * canonical wrapper may opt into the acceptance classification.
     */
    const result = await runPlaybackEnduranceLadder({
      loadProfiles: [idleLoad],
      target: {
        inspect: async () => ({
          device: { family: "m5sticks3", stableId: "70:04:1D:D5:45:88" },
          firmware: { algorithm: "sha256", value: "a".repeat(64) },
        }),
        runPlayback: async (request) => passingObservation(request.durationMs, request.loadProfile),
      },
      thresholds,
    });

    expect(result.passed).toBe(true);
    expect(result.acceptancePassed).toBe(false);
    expect(result.policy).toEqual({
      classification: "diagnostic",
      id: "iterate.playback-endurance.diagnostic",
      version: 1,
    });
    expect(result.runs[0]).toMatchObject({
      policy: result.policy,
      result: {
        acceptancePassed: false,
        passed: true,
      },
    });
  });

  test("normalizes absent acoustic endpoints into lossless JSON evidence", async () => {
    /*
     * A no-tone analysis legitimately has no observed start or end. Leaving
     * those fields as `undefined` makes JSON.stringify silently delete them,
     * so a persisted failure would no longer equal the result the judge
     * returned. Explicit null preserves both absence and schema shape.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.acoustic.analysis.activeWindowCount = 0;
      observation.acoustic.analysis.missingToneMs = 60_000;
      observation.acoustic.analysis.observedEndMs = undefined;
      observation.acoustic.analysis.observedSpanMs = 0;
      observation.acoustic.analysis.observedStartMs = undefined;
      observation.acoustic.analysis.toneWindowRatio = 0;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.acoustic.analysis.observedStartMs).toBeNull();
    expect(result.runs[0]!.acoustic.analysis.observedEndMs).toBeNull();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("stops before longer stages when the acoustic artifact is too short", async () => {
    /*
     * The analyzer and the artifact are independent evidence. If an adapter
     * accidentally analyzes a synthetic buffer while retaining only a tiny
     * room recording, trusting the analysis alone creates a compelling false
     * green. The core therefore checks that the immutable PCM artifact could
     * physically contain the requested run and refuses to spend another
     * twelve minutes after this first-stage failure.
     */
    const requestedDurations: number[] = [];
    const result = await runPlaybackEnduranceLadder({
      loadProfiles: [idleLoad],
      target: {
        inspect: async () => ({
          device: { family: "m5sticks3", stableId: "70:04:1D:D5:45:88" },
          firmware: { algorithm: "sha256", value: "a".repeat(64) },
        }),
        runPlayback: async (request) => {
          requestedDurations.push(request.durationMs);
          const observation = passingObservation(request.durationMs, request.loadProfile);
          observation.acoustic.artifact.byteLength = 64;
          return observation;
        },
      },
      thresholds,
    });

    expect(result.passed).toBe(false);
    expect(result.stoppedAfterFailure).toBe(true);
    expect(requestedDurations).toEqual([60_000]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.result.reasons).toContain(
      "acoustic artifact has 64 bytes but 5760000 are required for the requested run",
    );
  });

  test.each([
    {
      difference: -1,
      label: "one frame short",
    },
    {
      difference: 1,
      label: "one frame too many",
    },
  ])("rejects playback that is $label", async ({ difference }) => {
    /*
     * A queue can look continuously busy while replaying a frame or dropping
     * one. Requiring accepted, submitted, and completed counters to equal the
     * duration-derived 20 ms frame count catches both kinds of jiggle. This is
     * exact accounting, not a minimum-throughput test: overshoot is a defect
     * too because it means stale or duplicated audio reached the speaker.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.countersAfter.playback_completed =
        observation.countersAfter.playback_completed! + difference;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.frameAccounting).toMatchObject({
      completedDelta: 3_000 + difference,
      expectedFrameCount: 3_000,
    });
    expect(result.runs[0]!.result.reasons).toContain(
      `frame counter playback_completed delta ${3_000 + difference} does not equal expected 3000`,
    );
  });

  test("requires one clean end-of-stream marker and response per playback stage", async () => {
    /*
     * Exact audio frame counts do not prove the response ended cleanly. If the
     * EOS marker is lost, firmware can eventually classify the final drain as
     * an underrun after every content frame was already counted. Acceptance
     * therefore requires both ordered EOS events, not merely zero failures.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.countersAfter.playback_end_of_stream_markers_consumed =
        observation.countersBefore.playback_end_of_stream_markers_consumed;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toContain(
      "counter playback_end_of_stream_markers_consumed delta 0 does not equal required 1",
    );
  });

  test("refuses to invent a frame delta when either counter snapshot is missing", async () => {
    /*
     * Treating an absent before-value as zero can accidentally manufacture the
     * exact expected delta. Counter schemas do evolve, so missing evidence must
     * be represented as uncomputable rather than silently normalized.
     */
    const { result } = await runWithObservationMutation((observation) => {
      delete observation.countersBefore.downlink_accepted;
      observation.countersAfter.downlink_accepted = 3_000;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.counters.deltas.downlink_accepted).toBeNull();
    expect(result.runs[0]!.result.reasons).toContain(
      "counter downlink_accepted is missing from the before snapshot",
    );
  });

  test.each(["before", "after"])(
    "fails when a maximum-constrained counter is missing from the %s snapshot",
    async (position) => {
      /*
       * A configured maximum means the counter is required evidence. Missing
       * from either side is unknown, never an implicit zero-error delta.
       */
      const { result } = await runWithObservationMutation((observation) => {
        if (position === "before") {
          delete observation.countersBefore.playback_failures;
        } else {
          delete observation.countersAfter.playback_failures;
        }
      });

      expect(result.passed).toBe(false);
      expect(result.runs[0]!.counters.deltas.playback_failures).toBeNull();
      expect(result.runs[0]!.result.reasons).toContain(
        `counter playback_failures is missing from the ${position} snapshot`,
      );
      expect(result.runs[0]!.result.reasons).toContain(
        "required maximum counter playback_failures was not observed in both snapshots",
      );
    },
  );

  test.each([
    { label: "NaN", value: Number.NaN },
    { label: "infinity", value: Number.POSITIVE_INFINITY },
    { label: "a fractional value", value: 3_010.5 },
  ])("rejects $label in a cumulative counter", async ({ value }) => {
    /*
     * JavaScript comparisons against NaN are false, so an unchecked NaN can
     * evade every min/max test and then serialize as null. Counters are exact
     * cumulative integers; malformed adapter evidence is a contract error,
     * not a failed endurance run with a lossy manifest.
     */
    await expect(
      runWithObservationMutation((observation) => {
        observation.countersAfter.playback_completed = value;
      }),
    ).rejects.toThrow("Invalid playback endurance observation");
  });

  test.each([
    {
      label: "a non-finite playback timestamp",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.playbackCompletedAtMonotonicMs = Number.POSITIVE_INFINITY;
      },
    },
    {
      label: "a negative artifact byte length",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.artifact.byteLength = -1;
      },
    },
    {
      label: "a zero artifact sample rate",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.artifact.sampleRateHz = 0;
      },
    },
    {
      label: "a partial PCM16 sample",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.artifact.byteLength += 1;
      },
    },
    {
      label: "a non-finite load measurement",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.loadEvidence.maximumAudioServiceLatencyMs = Number.NaN;
      },
    },
    {
      label: "a non-finite acoustic analysis value",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.medianToneAmplitude = Number.NaN;
      },
    },
    {
      label: "a negative acoustic count",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.gapCount = -1;
      },
    },
    {
      label: "an impossible tone-window ratio",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.toneWindowRatio = 1.1;
      },
    },
    {
      label: "a non-finite numeric metric",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.metricSamples[20]!.values.free_internal_heap_bytes = Number.POSITIVE_INFINITY;
      },
    },
    {
      label: "an empty device boot identity",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.metricSamples[20]!.deviceBootId = "";
      },
    },
    {
      label: "a fractional device metric sequence",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.metricSamples[20]!.deviceSequence = 20.5;
      },
    },
    {
      label: "a negative device production timestamp",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.metricSamples[20]!.deviceProducedAtMonotonicMs = -1;
      },
    },
  ])("rejects $label before constructing JSON evidence", async ({ mutate }) => {
    /*
     * These values all become ambiguous or lossy JSON. Rejecting at the
     * adapter boundary preserves the invariant that every returned manifest
     * can be written verbatim and read back without semantic change.
     */
    await expect(runWithObservationMutation(mutate)).rejects.toThrow(
      "Invalid playback endurance observation",
    );
  });

  test.each([
    {
      label: "a boot identity change",
      expectedReason: "1 metrics samples changed device boot identity",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.metricSamples[20]!.deviceBootId = "boot-002";
      },
    },
    {
      label: "a skipped device metric sequence",
      expectedReason: "2 device metric sequence discontinuities were observed",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.metricSamples[20]!.deviceSequence = 21;
      },
    },
    {
      label: "a regressed device production clock",
      expectedReason: "1 device metric production timestamps did not strictly advance",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.metricSamples[20]!.deviceProducedAtMonotonicMs =
          observation.metricSamples[19]!.deviceProducedAtMonotonicMs;
      },
    },
  ])("fails $label inside one run", async ({ expectedReason, mutate }) => {
    /*
     * Host callback cadence cannot distinguish a live device from replayed
     * reports after a reboot or stalled producer. The device clock, boot ID,
     * and sequence are therefore one continuity proof and must advance
     * coherently throughout a physical stage.
     */
    const { result } = await runWithObservationMutation(mutate);

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toContain(expectedReason);
  });

  test.each([
    {
      label: "a non-finite metrics cadence",
      mutate: (value: PlaybackEnduranceThresholds) => {
        value.metricsCadence.maximumIntervalMs = Number.NaN;
      },
    },
    {
      label: "a non-finite relative-clock-drift ceiling",
      mutate: (value: PlaybackEnduranceThresholds) => {
        value.acousticPolicy.maximumAbsoluteRelativeClockDriftPpm = Number.POSITIVE_INFINITY;
      },
    },
    {
      label: "a zero acoustic-analysis window",
      mutate: (value: PlaybackEnduranceThresholds) => {
        value.acousticPolicy.expectedWindowDurationMs = 0;
      },
    },
  ])("rejects $label before inspecting or running a target", async ({ mutate }) => {
    /*
     * A NaN threshold makes `value > threshold` false for every value. Catch it
     * before target inspection so malformed policy cannot touch or flash a
     * physical device.
     */
    const invalidThresholds = structuredClone(thresholds);
    mutate(invalidThresholds);
    let inspected = false;

    await expect(
      runPlaybackEnduranceLadder({
        loadProfiles: [idleLoad],
        target: {
          inspect: async () => {
            inspected = true;
            return {
              device: {
                family: "m5sticks3",
                stableId: "70:04:1D:D5:45:88",
              },
              firmware: { algorithm: "sha256", value: "a".repeat(64) },
            };
          },
          runPlayback: async (request) =>
            passingObservation(request.durationMs, request.loadProfile),
        },
        thresholds: invalidThresholds,
      }),
    ).rejects.toThrow("Invalid playback endurance configuration");
    expect(inspected).toBe(false);
  });

  test("rejects an impossible load worker count before inspecting a target", async () => {
    /*
     * The worker count establishes the physical upper bound for cumulative
     * CPU time. Zero or fractional workers would make that proof meaningless,
     * so this is rejected as bad configuration rather than run evidence.
     */
    const invalidLoadedProfile = structuredClone(loadedCpu);
    if (invalidLoadedProfile.kind !== "loaded") {
      throw new Error("The loaded test fixture must remain a loaded profile.");
    }
    invalidLoadedProfile.requested.concurrentWorkerCount = 0;
    let inspected = false;

    await expect(
      runPlaybackEnduranceLadder({
        loadProfiles: [invalidLoadedProfile],
        target: {
          inspect: async () => {
            inspected = true;
            return {
              device: {
                family: "m5sticks3",
                stableId: "70:04:1D:D5:45:88",
              },
              firmware: { algorithm: "sha256", value: "a".repeat(64) },
            };
          },
          runPlayback: async (request) =>
            passingObservation(request.durationMs, request.loadProfile),
        },
        thresholds,
      }),
    ).rejects.toThrow("Invalid playback endurance configuration");
    expect(inspected).toBe(false);
  });

  test("audits cadence from every retained sample, including an out-of-order gap", async () => {
    /*
     * A start/end snapshot cannot prove diagnostics remained alive during the
     * run. Remove a middle block and inject a reordered sample so the audit
     * must detect both the long blind spot and ordering corruption while the
     * manifest still retains the exact observations for later JSONL review.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.metricSamples = observation.metricSamples.filter(
        (sample) => sample.capturedAtMonotonicMs < 10_000 || sample.capturedAtMonotonicMs > 15_000,
      );
      observation.metricSamples.splice(18, 0, {
        capturedAtMonotonicMs: 17_500,
        deviceBootId: "boot-001",
        deviceProducedAtMonotonicMs: 17_500,
        deviceSequence: 18,
        values: {
          audio_deadline_misses: 0,
          free_internal_heap_bytes: 220_000,
        },
      });
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.metricsCadence).toMatchObject({
      lateGapCount: 1,
      maximumObservedGapMs: 7_000,
      /*
       * The reordered sample is retained as evidence but cannot satisfy the
       * cadence quota. Counting it would let duplicate or replayed reports
       * conceal one genuinely missing interval.
       */
      missingSampleCount: 5,
      outOfOrderSampleCount: 1,
      sampleCount: 56,
    });
    expect(result.runs[0]!.metricSamples).toHaveLength(56);
  });

  test("retains and fails a transient metric spike that recovers before teardown", async () => {
    /*
     * Audio deadline counters can spike for one report and then return to
     * zero after a task restart. Looking only at the final sample would erase
     * the incident. The manifest must preserve the offending middle sample
     * and identify it explicitly so a long run cannot average away a click.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.metricSamples[30]!.values.audio_deadline_misses = 1;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.metricThresholdBreaches).toEqual([
      {
        capturedAtMonotonicMs: 30_000,
        kind: "maximum",
        maximum: 0,
        metric: "audio_deadline_misses",
        observed: 1,
      },
    ]);
    expect(result.runs[0]!.metricSamples[30]).toMatchObject({
      capturedAtMonotonicMs: 30_000,
      values: { audio_deadline_misses: 1 },
    });
  });

  test("retains and fails a transient internal-heap collapse", async () => {
    /*
     * Minima need per-sample scrutiny for the same reason as deadline maxima:
     * a heap exhaustion can recover by the final snapshot after already
     * forcing an allocation failure or audio dropout.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.metricSamples[30]!.values.free_internal_heap_bytes = 0;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.metricThresholdBreaches).toEqual([
      {
        capturedAtMonotonicMs: 30_000,
        kind: "minimum",
        metric: "free_internal_heap_bytes",
        minimum: 1,
        observed: 0,
      },
    ]);
  });

  test("does not call a requested load profile applied without work and per-core CPU proof", async () => {
    /*
     * Merely asking a low-priority load task to run is not evidence that it
     * got scheduled. A loaded acoustic pass is meaningful only when the
     * adapter proves nonzero work, CPU time, and CPU on the background core.
     * Aggregate CPU is intentionally absent: it could all belong to audio.
     */
    const { result } = await runWithObservationMutation(
      (observation) => {
        observation.loadEvidence.appliedWorkUnits = 0;
        observation.loadEvidence.backgroundCoreCpuPermille = 0;
        observation.loadEvidence.cpuTimeMs = 0;
      },
      [loadedCpu],
    );

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.loadProfile).toEqual(loadedCpu);
    expect(result.runs[0]!.result.reasons).toEqual(
      expect.arrayContaining([
        "applied load work 0 is below 1",
        "load CPU time 0ms is below 1ms",
        "background-core load CPU 0 permille is below 1",
      ]),
    );
  });

  test("fails loaded playback when audio misses its deadline under background work", async () => {
    /*
     * High background CPU is not success if it starves the audio-owner task.
     * These role-based measurements survive devices with different physical
     * core numbers and prove that load was applied without sacrificing the
     * latency contract.
     */
    const { result } = await runWithObservationMutation(
      (observation) => {
        observation.loadEvidence.audioDeadlineMisses = 1;
        observation.loadEvidence.maximumAudioServiceLatencyMs = 6;
      },
      [loadedCpu],
    );

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toEqual(
      expect.arrayContaining([
        "audio deadline misses 1 exceed 0",
        "maximum audio service latency 6ms exceeds 5ms",
      ]),
    );
  });

  test("applies audio deadline and service-latency limits to idle playback too", async () => {
    /*
     * Idle is the baseline, not a relaxed mode. A deadline miss without
     * synthetic load is an even stronger defect signal and must not be hidden
     * behind the loaded-profile branch.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.loadEvidence.audioDeadlineMisses = 1;
      observation.loadEvidence.maximumAudioServiceLatencyMs = 6;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toEqual(
      expect.arrayContaining([
        "audio deadline misses 1 exceed 0",
        "maximum audio service latency 6ms exceeds 5ms",
      ]),
    );
  });

  test("ties loaded evidence to the requested work rate and background-core CPU", async () => {
    /*
     * Values merely greater than zero only prove that the task ran once. For a
     * sixty-second contention proof, the applied work and measured background
     * CPU must reach explicit fractions of the profile's requested rate and
     * target. The tolerance lives in the retained thresholds so later reviews
     * can reproduce the decision.
     */
    const { result } = await runWithObservationMutation(
      (observation) => {
        observation.loadEvidence.appliedWorkUnits = 1;
        observation.loadEvidence.backgroundCoreCpuPermille = 1;
        observation.loadEvidence.cpuTimeMs = 1;
      },
      [loadedCpu],
    );

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toEqual(
      expect.arrayContaining([
        "applied load work 1 is below requested proof minimum 1080",
        "background-core load CPU 1 permille is below requested proof minimum 200",
        "load CPU time 1ms is below requested proof minimum 12000ms",
      ]),
    );
  });

  test("fails when the audio-owner core exceeds its CPU ceiling", async () => {
    /*
     * Meeting a background-load target by letting audio busy-spin is not an
     * acceptable loaded proof. The audio owner needs its own ceiling so CPU
     * regressions remain visible even while deadlines happen to pass.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.loadEvidence.audioOwnerCoreCpuPermille = 501;
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toContain("audio-owner CPU 501 permille exceeds 500");
  });

  test("requires the adapter to verify the retained acoustic artifact hash", async () => {
    /*
     * A path plus a claimed digest is not evidence that the file analyzed is
     * the file retained. The adapter must hash the completed artifact and
     * assert the computed digest matched before the shared judge accepts it.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.acoustic.artifact.hashVerification = {
        computedSha256: "c".repeat(64),
        matched: false,
      };
    });

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toContain(
      "acoustic artifact SHA-256 verification did not match the retained artifact",
    );
  });

  test.each([
    {
      expectedReason: "acoustic analysis expected duration 0ms does not equal requested 60000ms",
      label: "a different expected duration",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.expectedDurationMs = 0;
      },
    },
    {
      expectedReason:
        "acoustic analysis sample rate 16000Hz does not equal artifact sample rate 48000Hz",
      label: "a different sample rate",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.sampleRateHz = 16_000;
      },
    },
    {
      expectedReason:
        "acoustic analysis duration 1ms is inconsistent with artifact duration 60000ms",
      label: "a duration inconsistent with the retained bytes",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.totalDurationMs = 1;
      },
    },
    {
      expectedReason: "acoustic analysis tone frequency 900Hz does not equal policy 1000Hz",
      label: "a different tone-frequency policy",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.toneFrequencyHz = 900;
      },
    },
    {
      expectedReason: "acoustic analysis window 10ms does not equal policy 5ms",
      label: "a different analysis-window policy",
      mutate: (observation: PlaybackEnduranceRunObservation) => {
        observation.acoustic.analysis.windowDurationMs = 10;
      },
    },
  ])(
    "fails internally inconsistent acoustic evidence using $label",
    async ({ expectedReason, mutate }) => {
      /*
       * A sufficiently large PCM file does not prove the adapter analyzed that
       * file with this run's requested tone policy. These cross-checks make
       * accidental analysis of a stale artifact a failed proof.
       */
      const { result } = await runWithObservationMutation(mutate);

      expect(result.passed).toBe(false);
      expect(result.runs[0]!.result.reasons).toContain(expectedReason);
    },
  );

  test("bounds measured relative clock drift and requires it for the ten-minute proof", async () => {
    /*
     * Relative drift is separate evidence, not a phase-error reinterpretation.
     * Short diagnostic stages may report unavailable, but final endurance must
     * measure it and keep it inside an explicit retained threshold.
     */
    const excessive = await runWithObservationMutation((observation) => {
      observation.acoustic.relativeClockDriftPpm = 501;
    });
    expect(excessive.result.passed).toBe(false);
    expect(excessive.result.runs[0]!.result.reasons).toContain(
      "absolute relative clock drift 501ppm exceeds 500ppm",
    );

    const unavailable = await runWithObservationMutation((observation) => {
      observation.acoustic.relativeClockDriftPpm = "unavailable";
    });
    expect(unavailable.result.passed).toBe(false);
    expect(unavailable.requestedDurations).toEqual([60_000, 120_000, 600_000]);
    expect(unavailable.result.runs[2]!.result.reasons).toContain(
      "relative clock drift is required for playback runs of 600000ms or longer",
    );
  });

  test("rejects impossible CPU time for the declared background worker count", async () => {
    /*
     * One pinned worker cannot consume more than one millisecond of CPU per
     * wall-clock millisecond. Encoding worker count in the profile keeps this
     * sanity check valid if a later load profile deliberately uses more tasks.
     */
    const { result } = await runWithObservationMutation(
      (observation) => {
        observation.loadEvidence.cpuTimeMs = 60_001;
      },
      [loadedCpu],
    );

    expect(result.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toContain(
      "load CPU time 60001ms exceeds 60000ms available to 1 workers",
    );
  });

  test("records relative device/capture clock drift only when separately measured", async () => {
    /*
     * Phase-step error can reveal a discontinuity, but it cannot distinguish
     * the device oscillator from the Mac capture oscillator. The adapter must
     * either provide a separately measured relative drift or state that it is
     * unavailable; the manifest never derives ppm from phase analysis.
     */
    const { result } = await runWithObservationMutation((observation) => {
      observation.acoustic.relativeClockDriftPpm = 125;
    });

    expect(result.passed).toBe(true);
    expect(result.runs.map((run) => run.acoustic.relativeClockDriftPpm)).toEqual([125, 125, 125]);
  });

  test("runs each explicit load profile at every graduated duration", async () => {
    /*
     * Load is an axis of the proof, not a boolean hidden in a device script.
     * Recording the exact profile beside every run lets us compare baseline
     * and contention evidence and prevents an adapter from silently omitting
     * the loaded ten-minute stage.
     */
    const requests: string[] = [];
    const result = await runPlaybackEnduranceLadder({
      loadProfiles: [idleLoad, loadedCpu],
      target: {
        inspect: async () => ({
          device: { family: "m5sticks3", stableId: "70:04:1D:D5:45:88" },
          firmware: { algorithm: "sha256", value: "a".repeat(64) },
        }),
        runPlayback: async (request) => {
          requests.push(`${request.durationMs}:${request.loadProfile.id}`);
          return passingObservation(request.durationMs, request.loadProfile);
        },
      },
      thresholds,
    });

    expect(result.passed).toBe(true);
    expect(requests).toEqual([
      "60000:idle",
      "60000:capability-churn",
      "120000:idle",
      "120000:capability-churn",
      "600000:idle",
      "600000:capability-churn",
    ]);
    expect(result.runs.map((run) => run.loadProfile)).toEqual([
      idleLoad,
      loadedCpu,
      idleLoad,
      loadedCpu,
      idleLoad,
      loadedCpu,
    ]);
  });

  test("stops on the first physical acoustic threshold breach", async () => {
    /*
     * Digital counters can all balance while the codec emits a short silence.
     * The nearby-microphone oracle remains authoritative and its concrete
     * reason is carried into the run manifest for diagnosis.
     */
    const { requestedDurations, result } = await runWithObservationMutation((observation) => {
      observation.acoustic.analysis.gapCount = 1;
      observation.acoustic.analysis.longestInternalGapMs = 5;
      observation.acoustic.analysis.missingToneMs = 5;
    });

    expect(result.passed).toBe(false);
    expect(requestedDurations).toEqual([60_000]);
    expect(result.runs[0]!.acoustic.assessment.passed).toBe(false);
    expect(result.runs[0]!.result.reasons).toContain("longest internal gap 5 ms exceeds 0 ms");
  });
});
