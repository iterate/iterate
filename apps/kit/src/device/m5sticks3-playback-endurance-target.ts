import { isDeepStrictEqual } from "node:util";
import {
  analyzeDualCarrierPrbs31Pcm16Artifact,
  createDualCarrierPrbs31Challenge,
  dualCarrierPrbs31DefaultThresholds,
  type DualCarrierPrbs31ArtifactAnalysis,
  type DualCarrierPrbs31Challenge,
} from "./acoustic-prbs31-challenge.ts";
import type {
  PlaybackEnduranceDeviceIdentity,
  PlaybackEnduranceFirmwareIdentity,
  PlaybackEnduranceLoadProfile,
  PlaybackEnduranceMetricSample,
  PlaybackEnduranceRunObservation,
  PlaybackEnduranceTarget,
  PlaybackEnduranceThresholds,
} from "./playback-endurance-ladder.ts";
import { runPlaybackEnduranceLadder } from "./playback-endurance-ladder.ts";
import { assertPlaybackEnduranceInspection } from "./playback-endurance-validation.ts";

const metricsExpectedIntervalMs = 1_000;
const metricDuplicateBudget = 2;
const maximumHostDeliveryLagGrowthMs = 250;
const uint32Maximum = 0xffff_ffff;

const acceptancePolicyIdentity = {
  classification: "acceptance" as const,
  id: "iterate.m5sticks3.playback-endurance",
  version: 1,
};

/**
 * Versioned release policy for the first physical M5StickS3 target.
 *
 * Callers may use the generic ladder for diagnostics, but only this frozen
 * profile can produce an acceptance-classified result. In particular, load is
 * not a flag that an invocation can omit and no-interruption counters default
 * to zero rather than relying on each CLI author to remember them.
 */
export const m5StickS3PlaybackEnduranceAcceptancePolicy = deepFreeze({
  identity: acceptancePolicyIdentity,
  loadProfiles: [
    {
      id: "idle",
      kind: "idle" as const,
    },
    {
      id: "capability-churn",
      kind: "loaded" as const,
      requested: {
        concurrentWorkerCount: 1,
        targetCpuPermille: 250,
        workUnit: "render-and-metrics-cycle",
        workUnitsPerSecond: 20,
      },
    },
  ],
  thresholds: {
    acoustic: {
      maximumAmplitudeStepDecibels: 1.5,
      maximumAmplitudeStepP99Decibels: 1.5,
      maximumDurationErrorMs: 200,
      maximumInternalGapMs: 0,
      maximumMissingToneMs: 200,
      maximumPhaseStepErrorRadians: 0.1,
    },
    acousticWatermark: {
      ...dualCarrierPrbs31DefaultThresholds,
    },
    acousticPolicy: {
      expectedToneFrequencyHz: 997,
      expectedWindowDurationMs: 5,
      maximumAbsoluteRelativeClockDriftPpm: 500,
      relativeClockDriftRequiredAtOrAboveDurationMs: 600_000,
    },
    counterExpectedDeltas: {
      playback_end_of_stream_markers_consumed: 1,
      playback_end_of_stream_responses: 1,
    },
    counterMaximumDeltas: {
      playback_dma_deadline_miss_incidents: 0,
      playback_driver_failures: 0,
      playback_driver_queue_overflow_incidents: 0,
      playback_driver_stop_failures: 0,
      playback_fatal_frames_flushed: 0,
      playback_freshness_frames_dropped: 0,
      playback_freshness_incidents: 0,
      playback_generation_frames_flushed: 0,
      playback_invalid_frames: 0,
      playback_owner_clock_regressions: 0,
      playback_partial_prebuffer_frames_dropped: 0,
      playback_partial_prebuffer_incidents: 0,
      playback_state_errors: 0,
      playback_underrun_frames_flushed: 0,
      playback_underrun_incidents: 0,
      playback_write_backpressure_destructive_resets: 0,
      playback_write_backpressure_frames_dropped: 0,
    },
    loadEvidence: {
      maximumAudioDeadlineMisses: 0,
      maximumAudioOwnerCoreCpuPermille: 500,
      maximumAudioServiceLatencyMs: 5,
      minimumAppliedWorkUnits: 1,
      minimumBackgroundCoreCpuPermille: 1,
      minimumCpuTimeMs: 1,
      minimumRequestedCpuFraction: 0.8,
      minimumRequestedWorkFraction: 0.9,
    },
    maximumRunDurationErrorMs: 200,
    metricMaximumValues: {
      cpu_permille: 950,
      playback_dma_deadline_miss_incidents: 0,
      playback_driver_failures: 0,
      playback_driver_queue_overflow_incidents: 0,
      playback_driver_stop_failures: 0,
      playback_fatal_frames_flushed: 0,
      playback_freshness_frames_dropped: 0,
      playback_freshness_incidents: 0,
      playback_generation_frames_flushed: 0,
      playback_invalid_frames: 0,
      playback_owner_clock_regressions: 0,
      playback_partial_prebuffer_frames_dropped: 0,
      playback_partial_prebuffer_incidents: 0,
      playback_state_errors: 0,
      playback_underrun_frames_flushed: 0,
      playback_underrun_incidents: 0,
      playback_last_eof_to_successful_refill_us: 10_000,
      playback_last_write_call_duration_us: 5_000,
      playback_maximum_eof_to_successful_refill_us: 10_000,
      playback_maximum_write_call_duration_us: 5_000,
      playback_write_backpressure_destructive_resets: 0,
      playback_write_backpressure_frames_dropped: 0,
    },
    metricMinimumValues: {
      audio_owner_stack_headroom_bytes: 1_024,
      control_stack_headroom_bytes: 1_024,
      free_dma_heap_bytes: 16 * 1_024,
      free_internal_heap_bytes: 32 * 1_024,
      largest_free_dma_block_bytes: 4 * 1_024,
      largest_free_internal_heap_block_bytes: 8 * 1_024,
      main_stack_headroom_bytes: 1_024,
      minimum_free_dma_heap_bytes: 16 * 1_024,
      minimum_free_internal_heap_bytes: 32 * 1_024,
      network_stack_headroom_bytes: 1_024,
      playback_last_reuse_lead_at_successful_refill_us: 1_000,
      playback_minimum_reuse_lead_at_successful_refill_us: 1_000,
      playback_successful_refill_timing_samples: 1,
    },
    metricsCadence: {
      expectedIntervalMs: metricsExpectedIntervalMs,
      maximumIntervalMs: metricsExpectedIntervalMs + maximumHostDeliveryLagGrowthMs,
    },
    pcmFrameDurationMs: 20,
  } satisfies PlaybackEnduranceThresholds,
});

/**
 * Executes the release gate without accepting caller-selected policy.
 *
 * Keeping this wrapper tiny is intentional: device E2E code supplies only a
 * target and an evidence sink, so it cannot accidentally downgrade a
 * ten-minute loaded acceptance proof into a convenient diagnostic.
 */
export function runM5StickS3PlaybackEnduranceAcceptance(options: {
  onRunManifest?: Parameters<typeof runPlaybackEnduranceLadder>[0]["onRunManifest"];
  target: PlaybackEnduranceTarget;
}) {
  return runPlaybackEnduranceLadder({
    loadProfiles: structuredClone(m5StickS3PlaybackEnduranceAcceptancePolicy.loadProfiles),
    onRunManifest: options.onRunManifest,
    policy: structuredClone(m5StickS3PlaybackEnduranceAcceptancePolicy.identity),
    target: options.target,
    thresholds: structuredClone(m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds),
  });
}

export const m5StickS3PlaybackEnduranceRequiredMetrics = Object.freeze([
  "audio_owner_stack_headroom_bytes",
  "control_stack_headroom_bytes",
  "cpu_permille",
  "downlink_accepted",
  "free_dma_heap_bytes",
  "free_internal_heap_bytes",
  "largest_free_dma_block_bytes",
  "largest_free_internal_heap_block_bytes",
  "main_stack_headroom_bytes",
  "minimum_free_dma_heap_bytes",
  "minimum_free_internal_heap_bytes",
  "network_stack_headroom_bytes",
  "playback_completed",
  "playback_dma_deadline_miss_incidents",
  "playback_driver_failures",
  "playback_driver_queue_overflow_incidents",
  "playback_driver_stop_failures",
  "playback_end_of_stream_markers_consumed",
  "playback_end_of_stream_responses",
  "playback_end_of_stream_padding_descriptors_completed",
  "playback_end_of_stream_silence_descriptors",
  "playback_fatal_frames_flushed",
  "playback_freshness_frames_dropped",
  "playback_freshness_incidents",
  "playback_generation_frames_flushed",
  "playback_invalid_frames",
  "playback_last_eof_to_successful_refill_us",
  "playback_last_reuse_lead_at_successful_refill_us",
  "playback_last_write_call_duration_us",
  "playback_maximum_eof_to_successful_refill_us",
  "playback_maximum_write_call_duration_us",
  "playback_minimum_reuse_lead_at_successful_refill_us",
  "playback_owner_clock_regressions",
  "playback_partial_prebuffer_frames_dropped",
  "playback_partial_prebuffer_incidents",
  "playback_state_errors",
  "playback_submitted",
  "playback_successful_refill_timing_samples",
  "playback_underrun_frames_flushed",
  "playback_underrun_incidents",
  "playback_write_backpressure_destructive_resets",
  "playback_write_backpressure_frames_dropped",
  "playback_write_backpressure_incidents",
] as const);

const saturatingMetricNames = new Set<string>([
  "downlink_accepted",
  "playback_completed",
  "playback_dma_deadline_miss_incidents",
  "playback_driver_failures",
  "playback_driver_queue_overflow_incidents",
  "playback_driver_stop_failures",
  "playback_end_of_stream_markers_consumed",
  "playback_end_of_stream_responses",
  "playback_end_of_stream_padding_descriptors_completed",
  "playback_end_of_stream_silence_descriptors",
  "playback_fatal_frames_flushed",
  "playback_freshness_frames_dropped",
  "playback_freshness_incidents",
  "playback_generation_frames_flushed",
  "playback_invalid_frames",
  "playback_owner_clock_regressions",
  "playback_partial_prebuffer_frames_dropped",
  "playback_partial_prebuffer_incidents",
  "playback_state_errors",
  "playback_submitted",
  "playback_successful_refill_timing_samples",
  "playback_underrun_frames_flushed",
  "playback_underrun_incidents",
  "playback_write_backpressure_destructive_resets",
  "playback_write_backpressure_frames_dropped",
  "playback_write_backpressure_incidents",
]);

export interface M5StickS3PlaybackEnduranceSubject {
  bootId: string;
  controlSessionId: string;
  device: PlaybackEnduranceDeviceIdentity;
  firmware: PlaybackEnduranceFirmwareIdentity;
}

export interface M5StickS3PlaybackEnduranceMetricReport {
  deviceBootId: string;
  deviceProducedAtMonotonicMs: number;
  deviceSequence: number;
  values: Record<string, number | string>;
}

export interface M5StickS3PlaybackEnduranceStageRequest {
  acousticChallenge: DualCarrierPrbs31Challenge;
  durationMs: number;
  ladderIndex: number;
  loadProfile: PlaybackEnduranceLoadProfile;
  metricCollection: {
    expectedIntervalMs: number;
    maximumHostDeliveryLagGrowthMs: number;
    maximumRetainedSampleCount: number;
  };
  runId: string;
}

export interface M5StickS3PlaybackEnduranceRuntime {
  /**
   * Resolves identity from the running subject, not merely the selected port
   * or the image that the host intended to flash.
   */
  inspectRunningSubject(): Promise<M5StickS3PlaybackEnduranceSubject>;
  /**
   * Owns hardware/provider-specific acquisition while echoing the exact
   * request it actually applied. The target, not this operation, judges it.
   */
  runExactPlaybackStage(
    request: M5StickS3PlaybackEnduranceStageRequest,
    observeMetric: (report: M5StickS3PlaybackEnduranceMetricReport) => void,
  ): Promise<{
    appliedRequest: M5StickS3PlaybackEnduranceStageRequest;
    observation: Omit<PlaybackEnduranceRunObservation, "metricSamples">;
    /**
     * Unsubscribes the stage callback and resolves only after every callback
     * already accepted by the transport has either been delivered or rejected
     * by that unsubscribe. A plain playback-complete promise is insufficient:
     * Cap'n Web callback messages may still be queued behind its response.
     */
    quiesceMetricDelivery(): Promise<void>;
  }>;
}

export interface M5StickS3PlaybackEnduranceRawMetricRecord {
  hostReceivedAtMonotonicMs: number;
  report: M5StickS3PlaybackEnduranceMetricReport;
  runId: string;
  schemaVersion: 1;
}

export interface M5StickS3PlaybackEnduranceRawMetricSink {
  /**
   * This method is intentionally synchronous. The host writes each 1 Hz
   * callback before retaining it in memory, so a crash does not erase the
   * diagnostic record that immediately preceded it.
   */
  append(record: M5StickS3PlaybackEnduranceRawMetricRecord): void;
}

export type M5StickS3PlaybackEnduranceArtifactAnalyzer = (options: {
  artifactPath: string;
  challenge: DualCarrierPrbs31Challenge;
  expectedDurationMs: number;
  sampleRateHz: number;
}) => DualCarrierPrbs31ArtifactAnalysis;

/**
 * Converts the device-neutral ladder request into the exact M5StickS3 proof.
 *
 * This is an injected boundary because today's public M5Stick capability does
 * not expose sufficient identity, per-descriptor playback telemetry, or load
 * control. Keeping the missing operations explicit lets the real CLI fail
 * closed now and lets firmware add those operations later without moving
 * acceptance policy into the device-specific script.
 */
export function createM5StickS3PlaybackEnduranceTarget(options: {
  analyzeAcousticArtifact?: M5StickS3PlaybackEnduranceArtifactAnalyzer;
  createRunId(): string;
  monotonicNow(): number;
  rawMetricSink: M5StickS3PlaybackEnduranceRawMetricSink;
  runtime: M5StickS3PlaybackEnduranceRuntime;
}): PlaybackEnduranceTarget {
  let initialSubject: M5StickS3PlaybackEnduranceSubject | undefined;

  return {
    async inspect() {
      const inspected = await options.runtime.inspectRunningSubject();
      assertSubject(inspected);
      if (initialSubject && !sameSubject(initialSubject, inspected)) {
        throw new Error("The running M5StickS3 subject changed between endurance inspections.");
      }
      initialSubject ??= structuredClone(inspected);
      return {
        device: structuredClone(inspected.device),
        firmware: structuredClone(inspected.firmware),
      };
    },

    async runPlayback(request) {
      if (!initialSubject) {
        throw new Error(
          "M5StickS3 playback endurance must inspect the running subject before playback.",
        );
      }
      const subjectBefore = await options.runtime.inspectRunningSubject();
      assertSubject(subjectBefore);
      if (!sameSubject(initialSubject, subjectBefore)) {
        throw new Error("The running M5StickS3 subject changed before playback stage.");
      }
      const maximumRetainedSampleCount =
        Math.floor(request.durationMs / metricsExpectedIntervalMs) + 1 + metricDuplicateBudget;
      const runId = requireRunId(options.createRunId());
      const exactRequest: M5StickS3PlaybackEnduranceStageRequest = {
        acousticChallenge: createDualCarrierPrbs31Challenge({ runId }),
        durationMs: request.durationMs,
        ladderIndex: request.ladderIndex,
        loadProfile: structuredClone(request.loadProfile),
        metricCollection: {
          expectedIntervalMs: metricsExpectedIntervalMs,
          maximumHostDeliveryLagGrowthMs,
          maximumRetainedSampleCount,
        },
        runId,
      };
      const collector = new MetricCollector({
        expectedBootId: subjectBefore.bootId,
        maximumHostDeliveryLagGrowthMs,
        maximumRetainedSampleCount,
        monotonicNow: options.monotonicNow,
        rawMetricSink: options.rawMetricSink,
        runId: exactRequest.runId,
      });
      const stage = await options.runtime.runExactPlaybackStage(
        structuredClone(exactRequest),
        (report) => collector.observe(report),
      );
      if (typeof stage.quiesceMetricDelivery !== "function") {
        throw new Error(
          "The M5StickS3 runtime did not provide metric-delivery quiescence evidence.",
        );
      }
      /*
       * Finish only after the subscription is known dead. This ordering both
       * retains callbacks queued behind playback completion and prevents them
       * from contaminating the following ladder stage.
       */
      await stage.quiesceMetricDelivery();
      const metricSamples = collector.finish();
      if (!isDeepStrictEqual(stage.appliedRequest, exactRequest)) {
        throw new Error(
          "The M5StickS3 runtime did not prove the exact requested duration, " +
            "load profile, acoustic challenge, and run ID.",
        );
      }
      assertLoadEvidence(stage.observation, request.loadProfile);
      assertUnsaturatedSnapshots(stage.observation);
      if (stage.observation.acoustic.artifact.format !== "pcm-s16le-mono") {
        throw new Error("The M5StickS3 acoustic artifact is not mono signed 16-bit PCM.");
      }
      /*
       * The runtime owns capture mechanics but never certifies its own file.
       * Reopen, hash, and analyze that retained path in the host acceptance
       * process using the exact run challenge. Adapter-supplied hash and tone
       * JSON are deliberately overwritten, so stale green metadata cannot
       * bless a different recording.
       */
      const officialAcousticAnalysis = (
        options.analyzeAcousticArtifact ?? analyzeDualCarrierPrbs31Pcm16Artifact
      )({
        artifactPath: stage.observation.acoustic.artifact.path,
        challenge: exactRequest.acousticChallenge,
        expectedDurationMs: exactRequest.durationMs,
        sampleRateHz: stage.observation.acoustic.artifact.sampleRateHz,
      });

      const subjectAfter = await options.runtime.inspectRunningSubject();
      assertSubject(subjectAfter);
      if (!sameSubject(subjectBefore, subjectAfter)) {
        throw new Error("The running M5StickS3 subject changed during playback stage.");
      }
      return {
        ...stage.observation,
        acoustic: {
          ...stage.observation.acoustic,
          artifact: {
            ...stage.observation.acoustic.artifact,
            byteLength: officialAcousticAnalysis.artifactByteLength,
            hashVerification: {
              computedSha256: officialAcousticAnalysis.artifactSha256,
              matched: true,
            },
            sha256: officialAcousticAnalysis.artifactSha256,
          },
          relativeClockDriftPpm: officialAcousticAnalysis.fittedClockDriftPpm,
          watermark: {
            analysis: officialAcousticAnalysis,
            challenge: structuredClone(exactRequest.acousticChallenge),
          },
        },
        metricSamples,
      };
    },
  };
}

/**
 * Narrows a partial host integration to the complete acceptance runtime.
 *
 * Real entrypoints use this guard while capabilities are being brought up.
 * Reporting a named missing operation is materially safer than filling absent
 * fields from environment variables or aggregate metrics and calling the
 * resulting object physical evidence.
 */
export function requireM5StickS3PlaybackEnduranceRuntime(
  runtime: Partial<M5StickS3PlaybackEnduranceRuntime>,
): M5StickS3PlaybackEnduranceRuntime {
  if (typeof runtime.inspectRunningSubject !== "function") {
    throw new Error(
      "M5StickS3 playback endurance is unavailable: missing operation " +
        "inspectRunningSubject (stable device ID, running firmware SHA-256, " +
        "boot ID, and control-session ID).",
    );
  }
  if (typeof runtime.runExactPlaybackStage !== "function") {
    throw new Error(
      "M5StickS3 playback endurance is unavailable: missing operation " +
        "runExactPlaybackStage (exact run-keyed acoustic challenge, applied load proof, physical " +
        "recording, and detailed metrics).",
    );
  }
  return runtime as M5StickS3PlaybackEnduranceRuntime;
}

class MetricCollector {
  readonly #expectedBootId: string;
  readonly #maximumHostDeliveryLagGrowthMs: number;
  readonly #maximumRetainedSampleCount: number;
  readonly #monotonicNow: () => number;
  readonly #rawMetricSink: M5StickS3PlaybackEnduranceRawMetricSink;
  readonly #runId: string;
  readonly #samples: PlaybackEnduranceMetricSample[] = [];
  #failure: Error | undefined;
  #firstDeviceProducedAtMonotonicMs: number | undefined;
  #firstHostReceivedAtMonotonicMs: number | undefined;
  #lastDeviceProducedAtMonotonicMs: number | undefined;
  #lastDeviceSequence: number | undefined;
  #lastHostReceivedAtMonotonicMs: number | undefined;

  constructor(options: {
    expectedBootId: string;
    maximumHostDeliveryLagGrowthMs: number;
    maximumRetainedSampleCount: number;
    monotonicNow(): number;
    rawMetricSink: M5StickS3PlaybackEnduranceRawMetricSink;
    runId: string;
  }) {
    this.#expectedBootId = options.expectedBootId;
    this.#maximumHostDeliveryLagGrowthMs = options.maximumHostDeliveryLagGrowthMs;
    this.#maximumRetainedSampleCount = options.maximumRetainedSampleCount;
    this.#monotonicNow = options.monotonicNow;
    this.#rawMetricSink = options.rawMetricSink;
    this.#runId = options.runId;
  }

  observe(report: M5StickS3PlaybackEnduranceMetricReport) {
    const hostReceivedAtMonotonicMs = this.#monotonicNow();
    /*
     * Raw evidence comes first. Even a malformed or overflowing callback is
     * valuable proof of what the public subscription actually delivered.
     */
    this.#rawMetricSink.append({
      hostReceivedAtMonotonicMs,
      report: structuredClone(report),
      runId: this.#runId,
      schemaVersion: 1,
    });
    if (this.#failure) return;
    const reportFailure = validateMetricReport(report);
    if (reportFailure) {
      this.#failure = reportFailure;
      return;
    }
    if (report.deviceBootId !== this.#expectedBootId) {
      this.#failure = new Error(
        `The device boot ID changed during playback: expected ` +
          `${this.#expectedBootId}, received ${report.deviceBootId}.`,
      );
      return;
    }
    if (
      this.#lastDeviceSequence !== undefined &&
      report.deviceSequence !== this.#lastDeviceSequence + 1
    ) {
      this.#failure = new Error(
        `The device metric sequence advanced from ${this.#lastDeviceSequence} ` +
          `to ${report.deviceSequence}; callbacks were lost, replayed, or duplicated.`,
      );
      return;
    }
    if (
      this.#lastDeviceProducedAtMonotonicMs !== undefined &&
      report.deviceProducedAtMonotonicMs <= this.#lastDeviceProducedAtMonotonicMs
    ) {
      this.#failure = new Error(
        "The device metric production clock did not advance monotonically.",
      );
      return;
    }
    if (
      this.#lastHostReceivedAtMonotonicMs !== undefined &&
      hostReceivedAtMonotonicMs <= this.#lastHostReceivedAtMonotonicMs
    ) {
      this.#failure = new Error("The host metric receipt clock did not advance monotonically.");
      return;
    }

    this.#firstDeviceProducedAtMonotonicMs ??= report.deviceProducedAtMonotonicMs;
    this.#firstHostReceivedAtMonotonicMs ??= hostReceivedAtMonotonicMs;
    const deviceElapsedMs =
      report.deviceProducedAtMonotonicMs - this.#firstDeviceProducedAtMonotonicMs;
    const hostElapsedMs = hostReceivedAtMonotonicMs - this.#firstHostReceivedAtMonotonicMs;
    const deliveryLagGrowthMs = Math.abs(hostElapsedMs - deviceElapsedMs);
    if (deliveryLagGrowthMs > this.#maximumHostDeliveryLagGrowthMs) {
      this.#failure = new Error(
        `The host delivery lag growth ${deliveryLagGrowthMs}ms exceeded ` +
          `${this.#maximumHostDeliveryLagGrowthMs}ms.`,
      );
      return;
    }
    if (this.#samples.length >= this.#maximumRetainedSampleCount) {
      this.#failure = new Error(
        `The metric callback count exceeded bounded maximum ` +
          `${this.#maximumRetainedSampleCount}.`,
      );
      return;
    }

    this.#samples.push({
      capturedAtMonotonicMs: hostReceivedAtMonotonicMs,
      deviceBootId: report.deviceBootId,
      deviceProducedAtMonotonicMs: report.deviceProducedAtMonotonicMs,
      deviceSequence: report.deviceSequence,
      values: structuredClone(report.values),
    });
    this.#lastDeviceProducedAtMonotonicMs = report.deviceProducedAtMonotonicMs;
    this.#lastDeviceSequence = report.deviceSequence;
    this.#lastHostReceivedAtMonotonicMs = hostReceivedAtMonotonicMs;
  }

  finish() {
    if (this.#failure) throw this.#failure;
    return structuredClone(this.#samples);
  }
}

function validateMetricReport(report: M5StickS3PlaybackEnduranceMetricReport) {
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return new Error("The M5StickS3 playback endurance metric callback was not an object.");
  }
  if (!report.deviceBootId?.trim()) {
    return new Error("The M5StickS3 playback endurance metric callback omitted deviceBootId.");
  }
  if (!Number.isSafeInteger(report.deviceSequence) || report.deviceSequence < 0) {
    return new Error(
      "The M5StickS3 playback endurance metric callback has an invalid deviceSequence.",
    );
  }
  if (
    !Number.isFinite(report.deviceProducedAtMonotonicMs) ||
    report.deviceProducedAtMonotonicMs < 0
  ) {
    return new Error(
      "The M5StickS3 playback endurance metric callback has an invalid device production time.",
    );
  }
  if (typeof report.values !== "object" || report.values === null || Array.isArray(report.values)) {
    return new Error("The M5StickS3 playback endurance metric callback omitted metric values.");
  }
  for (const metric of m5StickS3PlaybackEnduranceRequiredMetrics) {
    const value = report.values[metric];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return new Error(`The required device metric ${metric} is unavailable or invalid.`);
    }
    if (saturatingMetricNames.has(metric) && value === uint32Maximum) {
      return new Error(`The required device metric ${metric} saturated at UINT32_MAX.`);
    }
  }
  return undefined;
}

function assertSubject(subject: M5StickS3PlaybackEnduranceSubject) {
  assertPlaybackEnduranceInspection(subject.device, subject.firmware);
  if (!subject.bootId?.trim()) {
    throw new Error("Invalid M5StickS3 playback endurance inspection: boot ID is required.");
  }
  if (!subject.controlSessionId?.trim()) {
    throw new Error(
      "Invalid M5StickS3 playback endurance inspection: control-session ID is required.",
    );
  }
}

function sameSubject(
  left: M5StickS3PlaybackEnduranceSubject,
  right: M5StickS3PlaybackEnduranceSubject,
) {
  return isDeepStrictEqual(left, right);
}

function requireRunId(runId: string) {
  if (!runId.trim()) {
    throw new Error("M5StickS3 playback endurance requires a non-empty run ID.");
  }
  return runId;
}

function assertLoadEvidence(
  observation: Omit<PlaybackEnduranceRunObservation, "metricSamples">,
  loadProfile: PlaybackEnduranceLoadProfile,
) {
  const evidence = Reflect.get(observation, "loadEvidence");
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    throw new Error(
      loadProfile.kind === "loaded"
        ? "The loaded stage did not return measured load evidence."
        : "The idle stage did not return measured CPU/deadline evidence.",
    );
  }
}

function assertUnsaturatedSnapshots(
  observation: Omit<PlaybackEnduranceRunObservation, "metricSamples">,
) {
  for (const [position, snapshot] of [
    ["before", observation.countersBefore],
    ["after", observation.countersAfter],
  ] as const) {
    for (const [name, value] of Object.entries(snapshot)) {
      if (saturatingMetricNames.has(name) && value === uint32Maximum) {
        throw new Error(`The required ${position} counter ${name} saturated at UINT32_MAX.`);
      }
    }
  }
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
