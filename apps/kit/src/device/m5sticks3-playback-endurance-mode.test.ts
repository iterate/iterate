import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runM5StickS3PlaybackEnduranceMode } from "./m5sticks3-playback-endurance-mode.ts";
import type {
  M5StickS3PlaybackEnduranceArtifactAnalyzer,
  M5StickS3PlaybackEnduranceRuntime,
  M5StickS3PlaybackEnduranceStageRequest,
} from "./m5sticks3-playback-endurance-target.ts";
import type { PlaybackEnduranceRunObservation } from "./playback-endurance-ladder.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

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

function observationFor(
  request: M5StickS3PlaybackEnduranceStageRequest,
): Omit<PlaybackEnduranceRunObservation, "metricSamples"> {
  const frames = request.durationMs / 20;
  const loaded = request.loadProfile.kind === "loaded";
  return {
    acoustic: {
      analysis: {
        activeWindowCount: request.durationMs / 2.5,
        amplitudeCoefficientOfVariation: 0.01,
        amplitudeStepP99Decibels: 0.1,
        maximumAmplitudeStepDecibels: 0.1,
        excludedCoherentWindowCount: 0,
        expectedDurationMs: request.durationMs,
        gapCount: 0,
        longestInternalGapMs: 0,
        maximumPhaseStepErrorRadians: 0.01,
        medianPhaseStepRadians: 0.2,
        medianToneAmplitude: 8_000,
        missingToneMs: 0,
        observedEndMs: request.durationMs,
        observedSpanMs: request.durationMs,
        observedStartMs: 0,
        phaseDiscontinuityCount: 0,
        phaseDiscontinuityThresholdRadians: 0.1,
        phaseStepSpanMs: 5,
        sampleRateHz: 48_000,
        toneFrequencyHz: 997,
        toneWindowRatio: 1,
        totalDurationMs: request.durationMs,
        windowDurationMs: 5,
        windowStepMs: 2.5,
      },
      artifact: {
        byteLength: request.durationMs * 96,
        format: "pcm-s16le-mono",
        hashVerification: {
          computedSha256: "b".repeat(64),
          matched: true,
        },
        path: `/retained/${request.runId}.pcm16le`,
        sampleRateHz: 48_000,
        sha256: "b".repeat(64),
      },
      captureProvenance: verifiedCaptureProvenance(`/retained/${request.runId}.pcm16le`),
      relativeClockDriftPpm: request.durationMs >= 600_000 ? 0 : "unavailable",
    },
    completedAtIso: new Date(
      Date.parse("2026-07-30T12:00:00.000Z") + request.durationMs,
    ).toISOString(),
    countersAfter: {
      downlink_accepted: 10 + frames,
      playback_completed: 10 + frames,
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
      playback_submitted: 10 + frames,
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
    loadEvidence: loaded
      ? {
          appliedWorkUnits: (request.durationMs / 1_000) * 20,
          audioDeadlineMisses: 0,
          audioOwnerCoreCpuPermille: 80,
          backgroundCoreCpuPermille: 250,
          cpuTimeMs: request.durationMs * 0.25,
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
    playbackCompletedAtMonotonicMs: request.durationMs,
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

function metricValues() {
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
  };
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

function sourceEvidenceFor(request: M5StickS3PlaybackEnduranceStageRequest) {
  const frameCount = request.durationMs / request.pcmSource.frameDurationMs;
  return {
    artifactPath: `/retained/${request.runId}-source.pcm16le`,
    delivery: {
      discontinuityCount: 0,
      emittedFrameCount: frameCount,
      retainedIncidents: [],
      timing: {
        deviceIngress: healthyCadence(
          frameCount,
          request.pcmSource.frameDurationMs,
          "device-monotonic",
        ),
        provider: healthyCadence(frameCount, request.pcmSource.frameDurationMs, "host-monotonic"),
        schedule: "absolute-media-deadlines" as const,
      },
    },
  };
}

const acceptedSourceArtifactInspector = ({
  expectedByteLength,
  expectedSha256,
}: {
  expectedByteLength: number;
  expectedSha256: string;
}) => ({
  byteLength: expectedByteLength,
  maximumBufferedAudioBytes: Math.min(expectedByteLength, 64 * 1_024),
  sha256: expectedSha256,
});

describe("M5StickS3 playback endurance E2E mode", () => {
  test("fails before creating plausible artifacts when a public runtime operation is missing", async () => {
    /*
     * The checked-in M5Stick capability still lacks stable running identity.
     * The CLI integration should expose that blocker verbatim and leave no
     * empty files that a later automation step could mistake for a run.
     */
    const parent = await mkdtemp(join(tmpdir(), "iterate-endurance-mode-test-"));
    temporaryDirectories.push(parent);
    const outputRoot = join(parent, "not-created");

    await expect(
      runM5StickS3PlaybackEnduranceMode({
        outputRoot,
        runtime: {},
      }),
    ).rejects.toThrow("missing operation inspectRunningSubject");
    await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writes raw callbacks and one manifest per canonical stage through the injected seam", async () => {
    /*
     * This is the off-device E2E for the real command path. The fake runtime
     * advances immediately, but the mode must still request the production
     * 1m/2m/10m idle+load matrix and persist the same evidence files the
     * physical adapter will produce.
     */
    const parent = await mkdtemp(join(tmpdir(), "iterate-endurance-mode-test-"));
    temporaryDirectories.push(parent);
    let nextRun = 0;
    let hostNow = 0;
    const requests: string[] = [];
    const runtime: M5StickS3PlaybackEnduranceRuntime = {
      inspectRunningSubject: async () => structuredClone(subject),
      runExactPlaybackStage: async (request, observeMetric) => {
        requests.push(`${request.durationMs}:${request.loadProfile.kind}`);
        for (
          let elapsedMs = 0, sequence = 0;
          elapsedMs <= request.durationMs;
          elapsedMs += 1_000, sequence += 1
        ) {
          hostNow = elapsedMs;
          observeMetric({
            deviceBootId: subject.bootId,
            deviceProducedAtMonotonicMs: elapsedMs,
            deviceSequence: sequence,
            values: metricValues(),
          });
        }
        return {
          appliedRequest: structuredClone(request),
          observation: observationFor(request),
          quiesceMetricDelivery: async () => {},
          sourceEvidence: sourceEvidenceFor(request),
        };
      },
    };

    const completed = await runM5StickS3PlaybackEnduranceMode({
      analyzeAcousticArtifact: acceptedArtifactAnalyzer,
      createRunId: () => `run-${nextRun++}`,
      inspectSourceArtifact: acceptedSourceArtifactInspector,
      monotonicNow: () => hostNow,
      outputRoot: parent,
      runtime,
    });

    expect(completed.result.acceptancePassed).toBe(true);
    expect(requests).toEqual([
      "60000:idle",
      "60000:loaded",
      "120000:idle",
      "120000:loaded",
      "600000:idle",
      "600000:loaded",
    ]);
    const manifests = (await readFile(completed.manifestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(manifests).toHaveLength(6);
    expect(manifests.map((manifest) => manifest.policy)).toEqual(
      Array.from({ length: 6 }, () => ({
        classification: "acceptance",
        id: "iterate.m5sticks3.playback-endurance",
        version: 1,
      })),
    );
    expect(manifests[0]).toMatchObject({
      acoustic: {
        artifact: {
          sha256: "c".repeat(64),
        },
        watermark: {
          analysis: {
            maximumBufferedAudioBytes: 4_096,
          },
          assessment: {
            passed: true,
          },
        },
      },
      pcmSource: {
        artifact: {
          byteLength: 1_920_000,
          hashVerification: {
            computedSha256: "663b9274c9ed1c08cf93f0bc457fe586d3023c2924c53d7ae04c075d60e611de",
            matched: true,
          },
          path: "/retained/run-0-source.pcm16le",
          sha256: "663b9274c9ed1c08cf93f0bc457fe586d3023c2924c53d7ae04c075d60e611de",
        },
        delivery: {
          discontinuityCount: 0,
          emittedFrameCount: 3_000,
          timing: {
            deviceIngress: {
              clock: "device-monotonic",
              gapCount: 2_999,
              maximumInterFrameGapUs: 20_000,
              minimumInterFrameGapUs: 20_000,
            },
            provider: {
              clock: "host-monotonic",
              gapCount: 2_999,
              maximumInterFrameGapUs: 20_000,
              minimumInterFrameGapUs: 20_000,
            },
            schedule: "absolute-media-deadlines",
          },
        },
        expectedByteLength: 1_920_000,
        inspectionMaximumBufferedAudioBytes: 64 * 1_024,
      },
      thresholds: {
        acousticWatermark: {
          maximumAbsoluteClockDriftPpm: 500,
          maximumAdjacentAmplitudeStepDecibels: 2,
          specVersion: 1,
        },
      },
    });
    const rawMetrics = (await readFile(completed.rawMetricsPath, "utf8")).trim().split("\n");
    expect(rawMetrics).toHaveLength(1_566);
  });

  test("retains a concrete proxy failure and stops after the first 60-second discontinuity", async () => {
    /*
     * The first physical attempt died after roughly 127.5 ms and reconnected.
     * A complete requested-source hash or a later healthy socket must never
     * hide that event. The first manifest needs the exact transport reason,
     * and the expensive loaded/two-minute/ten-minute stages must not begin.
     */
    const parent = await mkdtemp(join(tmpdir(), "iterate-endurance-mode-test-"));
    temporaryDirectories.push(parent);
    let hostNow = 0;
    let stageCount = 0;
    const runtime: M5StickS3PlaybackEnduranceRuntime = {
      inspectRunningSubject: async () => structuredClone(subject),
      runExactPlaybackStage: async (request, observeMetric) => {
        stageCount += 1;
        for (
          let elapsedMs = 0, sequence = 0;
          elapsedMs <= request.durationMs;
          elapsedMs += 1_000, sequence += 1
        ) {
          hostNow = elapsedMs;
          observeMetric({
            deviceBootId: subject.bootId,
            deviceProducedAtMonotonicMs: elapsedMs,
            deviceSequence: sequence,
            values: metricValues(),
          });
        }
        return {
          appliedRequest: structuredClone(request),
          observation: observationFor(request),
          quiesceMetricDelivery: async () => {},
          sourceEvidence: {
            artifactPath: `/retained/${request.runId}-source.pcm16le`,
            delivery: {
              discontinuityCount: 1,
              emittedFrameCount: 7,
              retainedIncidents: [
                {
                  layer: "proxy",
                  observedAtMonotonicMs: 127,
                  reason: "PCM session reconnected after 127.5 ms",
                },
              ],
              timing: sourceEvidenceFor(request).delivery.timing,
            },
          },
        };
      },
    };

    const completed = await runM5StickS3PlaybackEnduranceMode({
      analyzeAcousticArtifact: acceptedArtifactAnalyzer,
      createRunId: () => "physical-reconnect-regression",
      inspectSourceArtifact: acceptedSourceArtifactInspector,
      monotonicNow: () => hostNow,
      outputRoot: parent,
      runtime,
    });

    expect(completed.result).toMatchObject({
      acceptancePassed: false,
      stoppedAfterFailure: true,
    });
    expect(stageCount).toBe(1);
    expect(completed.result.runs).toHaveLength(1);
    expect(completed.result.runs[0]).toMatchObject({
      durationMs: 60_000,
      loadProfile: { kind: "idle" },
      pcmSource: {
        delivery: {
          discontinuityCount: 1,
          emittedFrameCount: 7,
        },
      },
    });
    expect(completed.result.runs[0]!.result.reasons).toContain(
      "PCM proxy discontinuity at 127ms: PCM session reconnected after 127.5 ms",
    );
  });

  test("rejects a complete source whose real-clock provider missed absolute media deadlines", async () => {
    /*
     * Frame count and SHA-256 stay perfect when an event-loop stall emits a
     * frame 12 ms late and then catches up. The device-facing trace observed
     * 32 ms gaps under exactly that failure mode. Preserve the first-frame
     * startup marker and deadline summary so the host cannot blame audible
     * jiggle on the ESP32 while its own provider was already irregular.
     */
    const parent = await mkdtemp(join(tmpdir(), "iterate-endurance-mode-test-"));
    temporaryDirectories.push(parent);
    let hostNow = 0;
    let stageCount = 0;
    const runtime: M5StickS3PlaybackEnduranceRuntime = {
      inspectRunningSubject: async () => structuredClone(subject),
      runExactPlaybackStage: async (request, observeMetric) => {
        stageCount += 1;
        for (
          let elapsedMs = 0, sequence = 0;
          elapsedMs <= request.durationMs;
          elapsedMs += 1_000, sequence += 1
        ) {
          hostNow = elapsedMs;
          observeMetric({
            deviceBootId: subject.bootId,
            deviceProducedAtMonotonicMs: elapsedMs,
            deviceSequence: sequence,
            values: metricValues(),
          });
        }
        return {
          appliedRequest: structuredClone(request),
          observation: observationFor(request),
          quiesceMetricDelivery: async () => {},
          sourceEvidence: {
            ...sourceEvidenceFor(request),
            delivery: {
              discontinuityCount: 0,
              emittedFrameCount: request.durationMs / request.pcmSource.frameDurationMs,
              retainedIncidents: [],
              timing: {
                deviceIngress: sourceEvidenceFor(request).delivery.timing.deviceIngress,
                provider: {
                  clock: "host-monotonic",
                  earlyGapCount: 9,
                  firstFrameIndex: 0,
                  firstFrameObservedAtMonotonicUs: 1_000_000,
                  gapCount: 2_999,
                  interFrameGapP50Us: 20_000,
                  interFrameGapP95Us: 20_000,
                  interFrameGapP99Us: 20_000,
                  lastFrameIndex: 2_999,
                  lastFrameObservedAtMonotonicUs: 60_980_000,
                  lateGapCount: 9,
                  maximumFrameLatenessUs: 12_000,
                  maximumInterFrameGapUs: 32_000,
                  minimumInterFrameGapUs: 8_000,
                  missedDeadlineCount: 9,
                  timelineOriginAtMonotonicUs: 988_000,
                },
                schedule: "absolute-media-deadlines",
              },
            },
          },
        };
      },
    };

    const completed = await runM5StickS3PlaybackEnduranceMode({
      analyzeAcousticArtifact: acceptedArtifactAnalyzer,
      createRunId: () => "provider-timing-regression",
      inspectSourceArtifact: acceptedSourceArtifactInspector,
      monotonicNow: () => hostNow,
      outputRoot: parent,
      runtime,
    });

    expect(completed.result.acceptancePassed).toBe(false);
    expect(stageCount).toBe(1);
    expect(completed.result.runs[0]!.result.reasons).toContain(
      "PCM provider missed 9 absolute media deadlines; maximum frame lateness was 12000us",
    );
    expect(completed.result.runs[0]!.result.reasons).toContain(
      "PCM provider maximum inter-frame gap 32000us exceeded 25000us",
    );
  });

  test("separately rejects Captun jitter measured at public device ingress", async () => {
    /*
     * A locally smooth provider does not prove the public path: the measured
     * Captun trace kept the same bytes and EOS but produced 81 catch-up gaps
     * below 15 ms and 75 stalls above 25 ms at device ingress. Retain its
     * quantiles and counts independently of provider cadence so the manifest
     * identifies the tunnel/device boundary rather than blaming the source.
     */
    const parent = await mkdtemp(join(tmpdir(), "iterate-endurance-mode-test-"));
    temporaryDirectories.push(parent);
    let hostNow = 0;
    let stageCount = 0;
    const runtime: M5StickS3PlaybackEnduranceRuntime = {
      inspectRunningSubject: async () => structuredClone(subject),
      runExactPlaybackStage: async (request, observeMetric) => {
        stageCount += 1;
        for (
          let elapsedMs = 0, sequence = 0;
          elapsedMs <= request.durationMs;
          elapsedMs += 1_000, sequence += 1
        ) {
          hostNow = elapsedMs;
          observeMetric({
            deviceBootId: subject.bootId,
            deviceProducedAtMonotonicMs: elapsedMs,
            deviceSequence: sequence,
            values: metricValues(),
          });
        }
        const sourceEvidence = sourceEvidenceFor(request);
        return {
          appliedRequest: structuredClone(request),
          observation: observationFor(request),
          quiesceMetricDelivery: async () => {},
          sourceEvidence: {
            ...sourceEvidence,
            delivery: {
              ...sourceEvidence.delivery,
              timing: {
                ...sourceEvidence.delivery.timing,
                deviceIngress: {
                  ...sourceEvidence.delivery.timing.deviceIngress,
                  earlyGapCount: 81,
                  gapCount: 2_999,
                  interFrameGapP50Us: 20_040,
                  interFrameGapP95Us: 31_440,
                  interFrameGapP99Us: 52_700,
                  lastFrameObservedAtMonotonicUs: 62_060_500,
                  lateGapCount: 75,
                  maximumFrameLatenessUs: 80_500,
                  maximumInterFrameGapUs: 100_500,
                  minimumInterFrameGapUs: 2,
                  missedDeadlineCount: 75,
                },
                provider: {
                  ...sourceEvidence.delivery.timing.provider,
                  earlyGapCount: 0,
                  gapCount: 2_999,
                  interFrameGapP50Us: 20_060,
                  interFrameGapP95Us: 22_060,
                  interFrameGapP99Us: 22_740,
                  lateGapCount: 0,
                  maximumInterFrameGapUs: 23_180,
                  minimumInterFrameGapUs: 16_400,
                },
              },
            },
          },
        };
      },
    };

    const completed = await runM5StickS3PlaybackEnduranceMode({
      analyzeAcousticArtifact: acceptedArtifactAnalyzer,
      createRunId: () => "public-ingress-timing-regression",
      inspectSourceArtifact: acceptedSourceArtifactInspector,
      monotonicNow: () => hostNow,
      outputRoot: parent,
      runtime,
    });

    expect(completed.result.acceptancePassed).toBe(false);
    expect(stageCount).toBe(1);
    expect(completed.result.runs[0]!.result.reasons).toContain(
      "PCM device ingress observed 81 gaps below 15000us and 75 gaps above 25000us",
    );
    expect(completed.result.runs[0]!.pcmSource?.delivery.timing).toMatchObject({
      deviceIngress: {
        interFrameGapP95Us: 31_440,
        interFrameGapP99Us: 52_700,
        maximumInterFrameGapUs: 100_500,
      },
      provider: {
        interFrameGapP95Us: 22_060,
        interFrameGapP99Us: 22_740,
        maximumInterFrameGapUs: 23_180,
      },
    });
  });

  test.each([
    {
      name: "the host-resolved Standard microphone mode",
      processing: {
        activeMicrophoneMode: "standard",
        preferredMicrophoneMode: "wide-spectrum",
        verification: "host-resolved-avfoundation-microphone-mode",
      },
    },
    {
      name: "the former three-disabled-switch overclaim",
      processing: {
        automaticGainControl: "disabled",
        echoCancellation: "disabled",
        noiseSuppression: "disabled",
        verification: "host-verified-capture-chain",
      },
    },
  ])("rejects $name before advancing past the first physical stage", async ({ processing }) => {
    /*
     * AVFoundation Standard includes voice DSP, and AVFoundation never exposed
     * the three independent switches the previous schema claimed to verify.
     * Both cases can make an acoustic gap less visible. The release judge must
     * require a host-observed active Wide Spectrum mode and stop immediately,
     * even if every device counter and watermark result is otherwise green.
     */
    const parent = await mkdtemp(join(tmpdir(), "iterate-endurance-mode-test-"));
    temporaryDirectories.push(parent);
    let hostNow = 0;
    let stageCount = 0;
    const runtime: M5StickS3PlaybackEnduranceRuntime = {
      inspectRunningSubject: async () => structuredClone(subject),
      runExactPlaybackStage: async (request, observeMetric) => {
        stageCount += 1;
        for (
          let elapsedMs = 0, sequence = 0;
          elapsedMs <= request.durationMs;
          elapsedMs += 1_000, sequence += 1
        ) {
          hostNow = elapsedMs;
          observeMetric({
            deviceBootId: subject.bootId,
            deviceProducedAtMonotonicMs: elapsedMs,
            deviceSequence: sequence,
            values: metricValues(),
          });
        }
        const observation = observationFor(request);
        (
          observation.acoustic.captureProvenance as unknown as {
            processing: unknown;
          }
        ).processing = processing;
        return {
          appliedRequest: structuredClone(request),
          observation,
          quiesceMetricDelivery: async () => {},
          sourceEvidence: sourceEvidenceFor(request),
        };
      },
    };

    const completed = await runM5StickS3PlaybackEnduranceMode({
      analyzeAcousticArtifact: acceptedArtifactAnalyzer,
      createRunId: () => "processing-provenance-regression",
      inspectSourceArtifact: acceptedSourceArtifactInspector,
      monotonicNow: () => hostNow,
      outputRoot: parent,
      runtime,
    });

    expect(completed.result.acceptancePassed).toBe(false);
    expect(stageCount).toBe(1);
    expect(completed.result.runs[0]!.result.reasons).toContain(
      "active AVFoundation microphone mode was not host-resolved as Wide Spectrum",
    );
  });
});
