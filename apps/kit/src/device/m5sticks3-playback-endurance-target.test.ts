import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createDualCarrierPrbs31Challenge,
  renderDualCarrierPrbs31Pcm16,
} from "./acoustic-prbs31-challenge.ts";
import {
  createM5StickS3PlaybackEnduranceTarget,
  m5StickS3PlaybackEnduranceAcceptancePolicy,
  m5StickS3PlaybackEnduranceRequiredMetrics,
  requireM5StickS3PlaybackEnduranceRuntime,
  runM5StickS3PlaybackEnduranceAcceptance,
  type M5StickS3PlaybackEnduranceArtifactAnalyzer,
  type M5StickS3PlaybackEnduranceMetricReport,
  type M5StickS3PlaybackEnduranceRuntime,
  type M5StickS3PlaybackEnduranceSourceEvidence,
  type M5StickS3PlaybackEnduranceStageRequest,
} from "./m5sticks3-playback-endurance-target.ts";
import type {
  PlaybackEnduranceLoadProfile,
  PlaybackEnduranceRunObservation,
} from "./playback-endurance-ladder.ts";

const idleLoad: PlaybackEnduranceLoadProfile = {
  id: "idle",
  kind: "idle",
};
const loadedProfile: PlaybackEnduranceLoadProfile = {
  id: "capability-churn",
  kind: "loaded",
  requested: {
    concurrentWorkerCount: 1,
    targetCpuPermille: 250,
    workUnit: "render-and-metrics-cycle",
    workUnitsPerSecond: 20,
  },
};
const subject = {
  bootId: "boot-001",
  controlSessionId: "control-001",
  device: {
    family: "m5sticks3",
    stableId: "70:04:1D:D5:45:88",
  },
  firmware: {
    algorithm: "sha256" as const,
    value: "a".repeat(64),
  },
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function requiredMetricValues(overrides: Record<string, number | string> = {}) {
  return {
    audio_owner_stack_headroom_bytes: 4_000,
    control_stack_headroom_bytes: 4_000,
    cpu_permille: 100,
    downlink_accepted: 0,
    free_dma_heap_bytes: 96_000,
    free_internal_heap_bytes: 220_000,
    largest_free_dma_block_bytes: 48_000,
    largest_free_internal_heap_block_bytes: 96_000,
    main_stack_headroom_bytes: 4_000,
    minimum_free_dma_heap_bytes: 90_000,
    minimum_free_internal_heap_bytes: 210_000,
    network_stack_headroom_bytes: 4_000,
    playback_completed: 0,
    playback_dma_deadline_miss_incidents: 0,
    playback_driver_failures: 0,
    playback_driver_queue_overflow_incidents: 0,
    playback_driver_stop_failures: 0,
    playback_end_of_stream_markers_consumed: 0,
    playback_end_of_stream_padding_descriptors_completed: 0,
    playback_end_of_stream_responses: 0,
    playback_end_of_stream_silence_descriptors: 0,
    playback_fatal_frames_flushed: 0,
    playback_freshness_frames_dropped: 0,
    playback_freshness_incidents: 0,
    playback_generation_frames_flushed: 0,
    playback_invalid_frames: 0,
    playback_downlink_interarrival_samples: 1,
    playback_maximum_downlink_interarrival_ms: 20,
    playback_maximum_eof_to_successful_refill_us: 1_200,
    playback_maximum_receive_to_dma_start_ms: 60,
    playback_maximum_write_call_duration_us: 120,
    playback_minimum_reuse_lead_at_successful_refill_us: 18_600,
    playback_owner_clock_regressions: 0,
    playback_partial_prebuffer_frames_dropped: 0,
    playback_partial_prebuffer_incidents: 0,
    playback_state_errors: 0,
    playback_submitted: 0,
    playback_receive_to_dma_start_samples: 1,
    playback_underrun_late_frames_dropped: 0,
    playback_underrun_frames_flushed: 0,
    playback_underrun_incidents: 0,
    playback_underrun_silence_frames_completed: 0,
    playback_underrun_silence_frames_retired: 0,
    playback_underrun_silence_frames_submitted: 0,
    playback_write_backpressure_destructive_resets: 0,
    playback_write_backpressure_frames_dropped: 0,
    playback_write_backpressure_incidents: 0,
    ...overrides,
  };
}

function report(
  sequence: number,
  producedAtMonotonicMs: number,
  overrides: Partial<M5StickS3PlaybackEnduranceMetricReport> = {},
): M5StickS3PlaybackEnduranceMetricReport {
  return {
    deviceBootId: subject.bootId,
    deviceProducedAtMonotonicMs: producedAtMonotonicMs,
    deviceSequence: sequence,
    values: requiredMetricValues(),
    ...overrides,
  };
}

function stageObservation(
  durationMs: number,
  loadProfile: PlaybackEnduranceLoadProfile,
  acousticArtifact: {
    path: string;
    sampleRateHz: number;
  } = {
    path: `/retained/playback-${durationMs}.pcm16le`,
    sampleRateHz: 48_000,
  },
): Omit<PlaybackEnduranceRunObservation, "metricSamples"> {
  const expectedFrameCount = durationMs / 20;
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
        toneFrequencyHz: 997,
        toneWindowRatio: 1,
        totalDurationMs: durationMs,
        windowDurationMs: 5,
        windowStepMs: 2.5,
      },
      artifact: {
        byteLength: (durationMs * acousticArtifact.sampleRateHz * 2) / 1_000,
        format: "pcm-s16le-mono",
        hashVerification: {
          computedSha256: "b".repeat(64),
          matched: true,
        },
        path: acousticArtifact.path,
        sampleRateHz: acousticArtifact.sampleRateHz,
        sha256: "b".repeat(64),
      },
      captureProvenance: verifiedCaptureProvenance(acousticArtifact.path),
      relativeClockDriftPpm: "unavailable",
    },
    completedAtIso: new Date(Date.parse("2026-07-30T12:00:00.000Z") + durationMs).toISOString(),
    countersAfter: {
      downlink_accepted: 10 + expectedFrameCount,
      playback_completed: 10 + expectedFrameCount,
      playback_dma_deadline_miss_incidents: 0,
      playback_driver_failures: 0,
      playback_driver_queue_overflow_incidents: 0,
      playback_driver_stop_failures: 0,
      playback_end_of_stream_markers_consumed: 11,
      playback_end_of_stream_responses: 11,
      playback_fatal_frames_flushed: 0,
      playback_freshness_frames_dropped: 0,
      playback_freshness_incidents: 0,
      playback_generation_frames_flushed: 0,
      playback_invalid_frames: 0,
      playback_owner_clock_regressions: 0,
      playback_partial_prebuffer_frames_dropped: 0,
      playback_partial_prebuffer_incidents: 0,
      playback_state_errors: 0,
      playback_submitted: 10 + expectedFrameCount,
      playback_underrun_late_frames_dropped: 0,
      playback_underrun_frames_flushed: 0,
      playback_underrun_incidents: 0,
      playback_underrun_silence_frames_completed: 0,
      playback_underrun_silence_frames_retired: 0,
      playback_underrun_silence_frames_submitted: 0,
      playback_write_backpressure_destructive_resets: 0,
      playback_write_backpressure_frames_dropped: 0,
    },
    countersBefore: {
      downlink_accepted: 10,
      playback_completed: 10,
      playback_dma_deadline_miss_incidents: 0,
      playback_driver_failures: 0,
      playback_driver_queue_overflow_incidents: 0,
      playback_driver_stop_failures: 0,
      playback_end_of_stream_markers_consumed: 10,
      playback_end_of_stream_responses: 10,
      playback_fatal_frames_flushed: 0,
      playback_freshness_frames_dropped: 0,
      playback_freshness_incidents: 0,
      playback_generation_frames_flushed: 0,
      playback_invalid_frames: 0,
      playback_owner_clock_regressions: 0,
      playback_partial_prebuffer_frames_dropped: 0,
      playback_partial_prebuffer_incidents: 0,
      playback_state_errors: 0,
      playback_submitted: 10,
      playback_underrun_late_frames_dropped: 0,
      playback_underrun_frames_flushed: 0,
      playback_underrun_incidents: 0,
      playback_underrun_silence_frames_completed: 0,
      playback_underrun_silence_frames_retired: 0,
      playback_underrun_silence_frames_submitted: 0,
      playback_write_backpressure_destructive_resets: 0,
      playback_write_backpressure_frames_dropped: 0,
    },
    loadEvidence:
      loadProfile.kind === "loaded"
        ? {
            appliedWorkUnits: (durationMs / 1_000) * 20,
            audioDeadlineMisses: 0,
            audioOwnerCoreCpuPermille: 80,
            backgroundCoreCpuPermille: 250,
            cpuTimeMs: durationMs * 0.25,
            maximumAudioServiceLatencyMs: 2,
          }
        : {
            appliedWorkUnits: 0,
            audioDeadlineMisses: 0,
            audioOwnerCoreCpuPermille: 80,
            backgroundCoreCpuPermille: 0,
            cpuTimeMs: 0,
            maximumAudioServiceLatencyMs: 0,
          },
    playbackCompletedAtMonotonicMs: durationMs,
    playbackStartedAtMonotonicMs: 0,
    startedAtIso: "2026-07-30T12:00:00.000Z",
  };
}

const acceptedArtifactAnalyzer: M5StickS3PlaybackEnduranceArtifactAnalyzer = (options) => ({
  acquired: true,
  amplitudeEnvelopeBlockMs: 20,
  anchors: [],
  artifactByteLength: (options.expectedDurationMs * options.sampleRateHz * 2) / 1_000,
  artifactSha256: "c".repeat(64),
  carrierAgreement: true,
  confidentChipRatio: 1,
  decodedSeedMatchesExpected: true,
  duplicatedChipCount: 0,
  expectedDurationMs: options.expectedDurationMs,
  expectedSeedCommitment: options.challenge.seedCommitmentSha256,
  fittedClockDriftPpm: 0,
  longestUncertainRunChips: 0,
  maximumAbsoluteTimelineOffsetChipsAfterBaseline: 0,
  maximumAdjacentAmplitudeStepDecibels: 0,
  maximumBufferedAudioBytes: 4_096,
  maximumShortTermAmplitudeRangeDecibels: 0,
  minimumSoftCorrelationByCarrier: [1, 1],
  p01SoftCorrelationByCarrier: [1, 1],
  sampleRateHz: options.sampleRateHz,
  shortTermAmplitudeWindowMs: 100,
  skippedChipCount: 0,
  specVersion: 1,
  timelineDiscontinuityCount: 0,
});

function createTestTarget(
  options: Omit<
    Parameters<typeof createM5StickS3PlaybackEnduranceTarget>[0],
    "analyzeAcousticArtifact" | "inspectSourceArtifact"
  >,
) {
  /*
   * Control-flow tests use a deterministic host-filesystem boundary so they
   * do not manufacture multi-minute PCM files. The primary happy-path test
   * below deliberately bypasses this helper and exercises the real bounded
   * artifact reader against bytes retained on disk.
   */
  return createM5StickS3PlaybackEnduranceTarget({
    ...options,
    analyzeAcousticArtifact: acceptedArtifactAnalyzer,
    inspectSourceArtifact: ({ expectedByteLength, expectedSha256 }) => ({
      byteLength: expectedByteLength,
      maximumBufferedAudioBytes: Math.min(expectedByteLength, 64 * 1_024),
      sha256: expectedSha256,
    }),
  });
}

function verifiedCaptureProvenance(artifactPath: string) {
  return {
    input: {
      avFoundationSpecifier: ":0",
      displayName: "Built-in Microphone",
      stableId: "AppleHDAEngineInput:1B,0,1,0:1",
      verification: "host-resolved-coreaudio-uid" as const,
    },
    processing: {
      activeMicrophoneMode: "wide-spectrum" as const,
      preferredMicrophoneMode: "wide-spectrum" as const,
      verification: "host-resolved-avfoundation-microphone-mode" as const,
    },
    recorder: {
      arguments: ["-f", "s16le", artifactPath],
      executable: "/opt/homebrew/bin/ffmpeg",
      version: "ffmpeg version test",
    },
  };
}

function encodePcm16Le(samples: Int16Array) {
  const bytes = Buffer.allocUnsafe(samples.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(samples[index]!, index * 2);
  }
  return bytes;
}

function healthyCadence(
  frameCount: number,
  frameDurationMs: number,
  clock: "device-monotonic" | "host-monotonic",
) {
  const timelineOriginAtMonotonicUs = clock === "host-monotonic" ? 1_000_000 : 2_000_000;
  const interFrameGapUs = frameDurationMs * 1_000;
  return {
    clock,
    earlyGapCount: 0,
    firstFrameIndex: 0,
    firstFrameObservedAtMonotonicUs: timelineOriginAtMonotonicUs,
    gapCount: frameCount - 1,
    interFrameGapP50Us: interFrameGapUs,
    interFrameGapP95Us: interFrameGapUs,
    interFrameGapP99Us: interFrameGapUs,
    lastFrameIndex: frameCount - 1,
    lastFrameObservedAtMonotonicUs:
      timelineOriginAtMonotonicUs + (frameCount - 1) * frameDurationMs * 1_000,
    lateGapCount: 0,
    maximumFrameLatenessUs: 0,
    maximumInterFrameGapUs: interFrameGapUs,
    minimumInterFrameGapUs: interFrameGapUs,
    missedDeadlineCount: 0,
    timelineOriginAtMonotonicUs,
  };
}

function healthyDeliveryTiming(frameCount: number, frameDurationMs: number) {
  return {
    deviceIngress: healthyCadence(frameCount, frameDurationMs, "device-monotonic"),
    provider: healthyCadence(frameCount, frameDurationMs, "host-monotonic"),
    schedule: "absolute-media-deadlines" as const,
  };
}

type TestPlaybackStage = Omit<
  Awaited<ReturnType<M5StickS3PlaybackEnduranceRuntime["runExactPlaybackStage"]>>,
  "sourceEvidence"
> & {
  sourceEvidence?: M5StickS3PlaybackEnduranceSourceEvidence;
};

function runtimeFor(
  runExactPlaybackStage: (
    ...arguments_: Parameters<M5StickS3PlaybackEnduranceRuntime["runExactPlaybackStage"]>
  ) => Promise<TestPlaybackStage>,
  inspectRunningSubject: M5StickS3PlaybackEnduranceRuntime["inspectRunningSubject"] = async () =>
    structuredClone(subject),
): M5StickS3PlaybackEnduranceRuntime {
  return {
    inspectRunningSubject,
    async runExactPlaybackStage(request, observeMetric) {
      const stage = await runExactPlaybackStage(request, observeMetric);
      return {
        ...stage,
        sourceEvidence: stage.sourceEvidence ?? {
          artifactPath: `/retained/${request.runId}-source.pcm16le`,
          delivery: {
            discontinuityCount: 0,
            emittedFrameCount: request.durationMs / request.pcmSource.frameDurationMs,
            retainedIncidents: [],
            timing: healthyDeliveryTiming(
              request.durationMs / request.pcmSource.frameDurationMs,
              request.pcmSource.frameDurationMs,
            ),
          },
        },
      };
    },
  };
}

describe("M5StickS3 playback endurance target", () => {
  test("owns one frozen acceptance policy with idle and loaded proofs at every duration", async () => {
    /*
     * The generic engine accepts arbitrary diagnostic thresholds. The real
     * M5Stick entrypoint must not: an idle-only or gap-tolerant caller policy
     * could otherwise return a green result carrying the same name as the
     * release gate. This wrapper exposes no threshold/profile override.
     */
    const requests: string[] = [];
    const result = await runM5StickS3PlaybackEnduranceAcceptance({
      target: {
        inspect: async () => ({
          device: subject.device,
          firmware: subject.firmware,
        }),
        runPlayback: async (request) => {
          requests.push(`${request.durationMs}:${request.loadProfile.kind}`);
          const observation = stageObservation(request.durationMs, request.loadProfile);
          if (request.durationMs >= 600_000) {
            observation.acoustic.relativeClockDriftPpm = 0;
          }
          return {
            ...observation,
            metricSamples: Array.from({ length: request.durationMs / 1_000 + 1 }, (_, index) => ({
              capturedAtMonotonicMs: index * 1_000,
              deviceBootId: subject.bootId,
              deviceProducedAtMonotonicMs: index * 1_000,
              deviceSequence: index,
              values: requiredMetricValues(),
            })),
          };
        },
      },
    });

    expect(Object.isFrozen(m5StickS3PlaybackEnduranceAcceptancePolicy)).toBe(true);
    expect(Object.isFrozen(m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.acoustic)).toBe(
      true,
    );
    expect(
      Object.isFrozen(m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.acousticWatermark),
    ).toBe(true);
    expect(
      m5StickS3PlaybackEnduranceAcceptancePolicy.loadProfiles.map((profile) => profile.kind),
    ).toEqual(["idle", "loaded"]);
    expect(
      m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.acoustic.maximumInternalGapMs,
    ).toBe(0);
    expect(m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.acousticWatermark).toMatchObject({
      maximumAbsoluteClockDriftPpm: 500,
      maximumAdjacentAmplitudeStepDecibels: 2,
      maximumShortTermAmplitudeRangeDecibels: 2,
      specVersion: 1,
    });
    expect(
      m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.counterMaximumDeltas,
    ).toMatchObject({
      playback_dma_deadline_miss_incidents: 0,
      playback_driver_queue_overflow_incidents: 0,
      playback_underrun_incidents: 0,
      playback_write_backpressure_destructive_resets: 0,
    });
    expect(m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.metricMaximumValues).toMatchObject(
      {
        playback_maximum_downlink_interarrival_ms: 40,
        playback_maximum_eof_to_successful_refill_us: 10_000,
        playback_maximum_receive_to_dma_start_ms: 120,
        playback_maximum_write_call_duration_us: 5_000,
      },
    );
    expect(m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.metricMinimumValues).toMatchObject(
      {
        playback_minimum_reuse_lead_at_successful_refill_us: 1_000,
        playback_downlink_interarrival_samples: 1,
        playback_receive_to_dma_start_samples: 1,
      },
    );
    expect(m5StickS3PlaybackEnduranceRequiredMetrics).not.toContain(
      "playback_write_backpressure_retry_attempts",
    );
    expect(requests).toEqual([
      "60000:idle",
      "60000:loaded",
      "120000:idle",
      "120000:loaded",
      "600000:idle",
      "600000:loaded",
    ]);
    expect(result.passed).toBe(true);
    expect(result.acceptancePassed).toBe(true);
    expect(result.policy).toEqual({
      classification: "acceptance",
      id: "iterate.m5sticks3.playback-endurance",
      version: 1,
    });
  });

  test("forwards one exact stage/profile request and retains every live metric callback", async () => {
    /*
     * A generic ladder request is not evidence that the target applied it.
     * The target adds an unpredictable run ID and immutable tone/collection
     * policy, then requires the runtime to echo that exact object alongside
     * the physical result. This catches adapters that silently fall back to a
     * short smoke tone or omit the requested background load.
     */
    const rawRecords: unknown[] = [];
    const hostTimes = [0, 1_000, 2_000];
    let receivedRequest: M5StickS3PlaybackEnduranceStageRequest | undefined;
    const directory = await mkdtemp(join(tmpdir(), "iterate-target-artifact-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "capture.pcm16le");
    const challenge = createDualCarrierPrbs31Challenge({ runId: "run-001" });
    await writeFile(
      artifactPath,
      encodePcm16Le(
        renderDualCarrierPrbs31Pcm16({
          challenge,
          chunkSamples: 173,
          durationMs: 2_000,
        }),
      ),
    );
    const target = createM5StickS3PlaybackEnduranceTarget({
      createRunId: () => "run-001",
      monotonicNow: () => hostTimes.shift()!,
      rawMetricSink: {
        append(record) {
          rawRecords.push(structuredClone(record));
        },
      },
      runtime: runtimeFor(async (request, observeMetric) => {
        receivedRequest = structuredClone(request);
        observeMetric(report(40, 10_000));
        observeMetric(report(41, 11_000));
        observeMetric(report(42, 12_000));
        return {
          appliedRequest: structuredClone(request),
          observation: stageObservation(request.durationMs, request.loadProfile, {
            path: artifactPath,
            sampleRateHz: 16_000,
          }),
          quiesceMetricDelivery: async () => {},
          sourceEvidence: {
            artifactPath,
            delivery: {
              discontinuityCount: 0,
              emittedFrameCount: 100,
              retainedIncidents: [],
              timing: healthyDeliveryTiming(100, 20),
            },
          },
        };
      }),
    });

    await expect(target.inspect()).resolves.toEqual({
      device: subject.device,
      firmware: subject.firmware,
    });
    const observation = await target.runPlayback({
      durationMs: 2_000,
      ladderIndex: 4,
      loadProfile: loadedProfile,
    });

    expect(receivedRequest).toEqual({
      acousticChallenge: challenge,
      durationMs: 2_000,
      ladderIndex: 4,
      loadProfile: loadedProfile,
      metricCollection: {
        expectedIntervalMs: 1_000,
        maximumHostDeliveryLagGrowthMs: 250,
        maximumRetainedSampleCount: 5,
      },
      pcmSource: {
        artifact: {
          byteLength: 64_000,
          format: "pcm-s16le-mono",
          sampleRateHz: 16_000,
          sha256: "7fd7f3ede9ee90275323fdeca2e7f8a1d49f9a50ff07b70eefb771d4988497f0",
        },
        frameDurationMs: 20,
        timingPolicy: {
          maximumFrameLatenessUs: 5_000,
          maximumInterFrameGapUs: 25_000,
          minimumInterFrameGapUs: 15_000,
          schedule: "absolute-media-deadlines",
        },
      },
      runId: "run-001",
    });
    expect(observation.metricSamples).toEqual([
      {
        capturedAtMonotonicMs: 0,
        deviceBootId: "boot-001",
        deviceProducedAtMonotonicMs: 10_000,
        deviceSequence: 40,
        values: requiredMetricValues(),
      },
      {
        capturedAtMonotonicMs: 1_000,
        deviceBootId: "boot-001",
        deviceProducedAtMonotonicMs: 11_000,
        deviceSequence: 41,
        values: requiredMetricValues(),
      },
      {
        capturedAtMonotonicMs: 2_000,
        deviceBootId: "boot-001",
        deviceProducedAtMonotonicMs: 12_000,
        deviceSequence: 42,
        values: requiredMetricValues(),
      },
    ]);
    expect(rawRecords).toHaveLength(3);
    expect(rawRecords[0]).toMatchObject({
      hostReceivedAtMonotonicMs: 0,
      report: {
        deviceBootId: "boot-001",
        deviceSequence: 40,
      },
      runId: "run-001",
      schemaVersion: 1,
    });
    expect(observation.acoustic.artifact).toMatchObject({
      byteLength: 64_000,
      hashVerification: {
        computedSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        matched: true,
      },
      path: artifactPath,
      sampleRateHz: 16_000,
    });
    expect(observation.acoustic.artifact.sha256).not.toBe("b".repeat(64));
    expect(observation.pcmSource).toEqual({
      artifact: {
        byteLength: 64_000,
        format: "pcm-s16le-mono",
        hashVerification: {
          computedSha256: "7fd7f3ede9ee90275323fdeca2e7f8a1d49f9a50ff07b70eefb771d4988497f0",
          matched: true,
        },
        path: artifactPath,
        sampleRateHz: 16_000,
        sha256: "7fd7f3ede9ee90275323fdeca2e7f8a1d49f9a50ff07b70eefb771d4988497f0",
      },
      delivery: {
        discontinuityCount: 0,
        emittedFrameCount: 100,
        retainedIncidents: [],
        timing: healthyDeliveryTiming(100, 20),
      },
      expectedByteLength: 64_000,
      inspectionMaximumBufferedAudioBytes: 64_000,
    });
    expect(observation.acoustic.watermark).toMatchObject({
      analysis: {
        decodedSeedMatchesExpected: true,
        expectedSeedCommitment: challenge.seedCommitmentSha256,
        maximumBufferedAudioBytes: 64 * 1_024,
      },
      challenge,
    });
  });

  test("waits for metric delivery to quiesce before sealing a stage", async () => {
    /*
     * Cap'n Web callbacks may already be queued when playback completes.
     * Sealing the collector as soon as the playback promise resolves loses
     * those samples, while leaving the callback live lets one stage's metrics
     * bleed into the next. The runtime therefore owes an explicit quiescence
     * acknowledgement, and callbacks delivered while obtaining it remain
     * part of this stage's raw and judged evidence.
     */
    const rawRecords: unknown[] = [];
    const hostTimes = [0, 1_000];
    let quiesced = false;
    const target = createTestTarget({
      createRunId: () => "run-quiescence",
      monotonicNow: () => hostTimes.shift()!,
      rawMetricSink: {
        append(record) {
          rawRecords.push(structuredClone(record));
        },
      },
      runtime: runtimeFor(
        async (request, observeMetric) =>
          ({
            appliedRequest: structuredClone(request),
            observation: stageObservation(request.durationMs, request.loadProfile),
            quiesceMetricDelivery: async () => {
              observeMetric(report(42, 11_000));
              quiesced = true;
            },
          }) as Awaited<ReturnType<M5StickS3PlaybackEnduranceRuntime["runExactPlaybackStage"]>>,
      ),
    });

    await target.inspect();
    const observationPromise = target.runPlayback({
      durationMs: 2_000,
      ladderIndex: 0,
      loadProfile: idleLoad,
    });

    expect(quiesced).toBe(false);
    await expect(observationPromise).resolves.toMatchObject({
      metricSamples: [{ deviceSequence: 42 }],
    });
    expect(quiesced).toBe(true);
    expect(rawRecords).toHaveLength(1);
  });

  test("fails closed when an untrusted runtime omits metric-delivery quiescence", async () => {
    /*
     * Static typing does not protect a CLI adapter populated from a remote
     * capability. Treat an absent acknowledgement as unknown subscription
     * state, not as an empty tail of metrics.
     */
    const target = createTestTarget({
      createRunId: () => "run-missing-quiescence",
      monotonicNow: () => 0,
      rawMetricSink: { append() {} },
      runtime: runtimeFor((async (request: M5StickS3PlaybackEnduranceStageRequest) => ({
        appliedRequest: structuredClone(request),
        observation: stageObservation(request.durationMs, request.loadProfile),
      })) as unknown as M5StickS3PlaybackEnduranceRuntime["runExactPlaybackStage"]),
    });

    await target.inspect();
    await expect(
      target.runPlayback({
        durationMs: 2_000,
        ladderIndex: 0,
        loadProfile: idleLoad,
      }),
    ).rejects.toThrow("did not provide metric-delivery quiescence evidence");
  });

  test("rejects an adapter that applies a different duration or load profile", async () => {
    /*
     * A long recording can look healthy even if the provider produced only a
     * short tone and the remainder was silence, while a loaded request can be
     * accidentally run idle. Both dimensions are part of the echoed request;
     * any mutation invalidates the stage before the generic judge sees it.
     */
    const target = createTestTarget({
      createRunId: () => "run-002",
      monotonicNow: () => 0,
      rawMetricSink: { append() {} },
      runtime: runtimeFor(async (request, observeMetric) => {
        observeMetric(report(1, 0));
        return {
          appliedRequest: {
            ...structuredClone(request),
            durationMs: request.durationMs - 20,
            loadProfile: idleLoad,
          },
          observation: stageObservation(request.durationMs, request.loadProfile),
          quiesceMetricDelivery: async () => {},
        };
      }),
    });

    await target.inspect();
    await expect(
      target.runPlayback({
        durationMs: 60_000,
        ladderIndex: 0,
        loadProfile: loadedProfile,
      }),
    ).rejects.toThrow(
      "did not prove the exact requested duration, load profile, acoustic challenge, and run ID",
    );
  });

  test.each(m5StickS3PlaybackEnduranceRequiredMetrics)(
    "fails closed when callback metric %s is unavailable",
    async (missingMetric) => {
      /*
       * Missing telemetry is unknown, never zero. Iterating the production
       * required-field list prevents a future parser/firmware rename from
       * silently weakening only one of the underrun, deadline, memory, or
       * descriptor-timing gates.
       */
      const target = createTestTarget({
        createRunId: () => "run-missing-metric",
        monotonicNow: () => 0,
        rawMetricSink: { append() {} },
        runtime: runtimeFor(async (request, observeMetric) => {
          const values = requiredMetricValues();
          delete values[missingMetric as keyof typeof values];
          observeMetric(report(1, 0, { values }));
          return {
            appliedRequest: structuredClone(request),
            observation: stageObservation(request.durationMs, request.loadProfile),
            quiesceMetricDelivery: async () => {},
          };
        }),
      });

      await target.inspect();
      await expect(
        target.runPlayback({
          durationMs: 60_000,
          ladderIndex: 0,
          loadProfile: idleLoad,
        }),
      ).rejects.toThrow(`required device metric ${missingMetric} is unavailable`);
    },
  );

  test("fails closed when a loaded stage has no measured load evidence", async () => {
    /*
     * Requesting work is not proof that it ran. A no-op capability loop could
     * make audio look excellent precisely because the intended contention was
     * absent, so missing applied-work/CPU/deadline evidence is a harness error.
     */
    const target = createTestTarget({
      createRunId: () => "run-no-load-proof",
      monotonicNow: () => 0,
      rawMetricSink: { append() {} },
      runtime: runtimeFor(async (request, observeMetric) => {
        observeMetric(report(1, 0));
        const observation = stageObservation(request.durationMs, request.loadProfile);
        Reflect.set(observation, "loadEvidence", undefined);
        return {
          appliedRequest: structuredClone(request),
          observation,
          quiesceMetricDelivery: async () => {},
        };
      }),
    });

    await target.inspect();
    await expect(
      target.runPlayback({
        durationMs: 60_000,
        ladderIndex: 0,
        loadProfile: loadedProfile,
      }),
    ).rejects.toThrow("loaded stage did not return measured load evidence");
  });

  test("bounds retained metrics while still writing the overflowing callback to raw evidence", async () => {
    /*
     * A reconnect bug can duplicate subscriptions indefinitely. Keeping all
     * callbacks in memory would turn a diagnostics failure into host OOM and
     * erase the artifact. The collector retains only cadence plus a tiny
     * duplicate allowance, latches overflow, and writes the offending record
     * before failing so the cause survives the process.
     */
    const rawRecords: unknown[] = [];
    let hostTime = 0;
    const target = createTestTarget({
      createRunId: () => "run-overflow",
      monotonicNow: () => hostTime++,
      rawMetricSink: {
        append(record) {
          rawRecords.push(structuredClone(record));
        },
      },
      runtime: runtimeFor(async (request, observeMetric) => {
        for (let sequence = 0; sequence < 7; sequence += 1) {
          observeMetric(report(sequence, sequence));
        }
        return {
          appliedRequest: structuredClone(request),
          observation: stageObservation(request.durationMs, request.loadProfile),
          quiesceMetricDelivery: async () => {},
        };
      }),
    });

    await target.inspect();
    await expect(
      target.runPlayback({
        durationMs: 2_000,
        ladderIndex: 0,
        loadProfile: idleLoad,
      }),
    ).rejects.toThrow("metric callback count exceeded bounded maximum 5");
    expect(rawRecords).toHaveLength(7);
  });

  test("rejects sequence, boot, and host-delivery discontinuities", async () => {
    /*
     * Device timestamps alone can be replayed from a buffered callback and
     * still look perfectly one-second-spaced. Pairing them with host receipt,
     * boot ID, and exact sequence detects delayed bursts, callback loss, and a
     * reboot hidden behind a reconnect.
     */
    const cases = [
      {
        label: "sequence gap",
        reports: [report(1, 0), report(3, 1_000)],
        times: [0, 1_000],
        reason: "device metric sequence advanced from 1 to 3",
      },
      {
        label: "boot change",
        reports: [report(1, 0), report(2, 1_000, { deviceBootId: "boot-002" })],
        times: [0, 1_000],
        reason: "device boot ID changed during playback",
      },
      {
        label: "buffered delivery",
        reports: [report(1, 0), report(2, 1_000)],
        times: [0, 1_251],
        reason: "host delivery lag growth 251ms exceeded 250ms",
      },
    ];

    for (const scenario of cases) {
      const times = [...scenario.times];
      const target = createTestTarget({
        createRunId: () => `run-${scenario.label}`,
        monotonicNow: () => times.shift()!,
        rawMetricSink: { append() {} },
        runtime: runtimeFor(async (request, observeMetric) => {
          for (const metricReport of scenario.reports) {
            observeMetric(metricReport);
          }
          return {
            appliedRequest: structuredClone(request),
            observation: stageObservation(request.durationMs, request.loadProfile),
            quiesceMetricDelivery: async () => {},
          };
        }),
      });

      await target.inspect();
      await expect(
        target.runPlayback({
          durationMs: 2_000,
          ladderIndex: 0,
          loadProfile: idleLoad,
        }),
        scenario.label,
      ).rejects.toThrow(scenario.reason);
    }
  });

  test("rejects saturated counters instead of treating UINT32_MAX as stable zero-delta proof", async () => {
    /*
     * Firmware counters saturate rather than wrap. Once a required incident or
     * frame counter reaches UINT32_MAX, identical before/after values no
     * longer prove that nothing happened during this run.
     */
    const target = createTestTarget({
      createRunId: () => "run-saturated",
      monotonicNow: () => 0,
      rawMetricSink: { append() {} },
      runtime: runtimeFor(async (request, observeMetric) => {
        observeMetric(
          report(1, 0, {
            values: requiredMetricValues({
              playback_underrun_incidents: 0xffff_ffff,
            }),
          }),
        );
        return {
          appliedRequest: structuredClone(request),
          observation: stageObservation(request.durationMs, request.loadProfile),
          quiesceMetricDelivery: async () => {},
        };
      }),
    });

    await target.inspect();
    await expect(
      target.runPlayback({
        durationMs: 60_000,
        ladderIndex: 0,
        loadProfile: idleLoad,
      }),
    ).rejects.toThrow("required device metric playback_underrun_incidents saturated at UINT32_MAX");
  });

  test("re-inspects the running subject around every stage", async () => {
    /*
     * A Wi-Fi reconnect can mount a rebooted or even different board at the
     * same capability path. Identity proven only before a thirteen-minute
     * ladder would let later artifacts inherit the wrong firmware/boot.
     */
    let inspection = 0;
    const target = createTestTarget({
      createRunId: () => "run-subject-change",
      monotonicNow: () => 0,
      rawMetricSink: { append() {} },
      runtime: runtimeFor(
        async (request, observeMetric) => {
          observeMetric(report(1, 0));
          return {
            appliedRequest: structuredClone(request),
            observation: stageObservation(request.durationMs, request.loadProfile),
            quiesceMetricDelivery: async () => {},
          };
        },
        async () => ({
          ...structuredClone(subject),
          bootId: inspection++ < 2 ? "boot-001" : "boot-002",
        }),
      ),
    });

    await target.inspect();
    await expect(
      target.runPlayback({
        durationMs: 60_000,
        ladderIndex: 0,
        loadProfile: idleLoad,
      }),
    ).rejects.toThrow("running M5StickS3 subject changed during playback stage");
  });

  test("names the exact unavailable public operation rather than fabricating evidence", () => {
    /*
     * The current capability surface cannot identify the running firmware or
     * execute/prove a loaded exact acoustic stage. A clean partial-runtime guard
     * makes that gap executable documentation for the real CLI integration.
     */
    expect(() => requireM5StickS3PlaybackEnduranceRuntime({})).toThrow(
      "missing operation inspectRunningSubject " +
        "(stable device ID, running firmware SHA-256, boot ID, and control-session ID)",
    );
    expect(() =>
      requireM5StickS3PlaybackEnduranceRuntime({
        inspectRunningSubject: async () => structuredClone(subject),
      }),
    ).toThrow(
      "missing operation runExactPlaybackStage " +
        "(exact run-keyed acoustic challenge, applied load proof, physical " +
        "recording, and detailed metrics)",
    );
  });
});
