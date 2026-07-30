import type {
  AcousticToneAnalysis,
  AcousticToneAssessment,
  AcousticToneThresholds,
} from "./acoustic-tone-analysis.ts";
import type {
  DualCarrierPrbs31ArtifactAnalysis,
  DualCarrierPrbs31Assessment,
  DualCarrierPrbs31Challenge,
  DualCarrierPrbs31Thresholds,
} from "./acoustic-prbs31-challenge.ts";
import type { MacOsCaptureProvenance } from "./macos-pcm16-capture.ts";

export interface PlaybackEnduranceDeviceIdentity {
  family: string;
  stableId: string;
}

export interface PlaybackEnduranceFirmwareIdentity {
  algorithm: "sha256";
  value: string;
}

export interface PlaybackEndurancePolicyIdentity {
  classification: "acceptance" | "diagnostic";
  id: string;
  version: number;
}

export type PlaybackEnduranceLoadProfile =
  | {
      id: string;
      kind: "idle";
    }
  | {
      id: string;
      kind: "loaded";
      requested: {
        concurrentWorkerCount: number;
        targetCpuPermille: number;
        workUnit: string;
        workUnitsPerSecond: number;
      };
    };

/**
 * Role names, rather than ESP32 core numbers, keep the proof portable.
 *
 * One device may pin audio to core 1 while another uses core 0. What matters
 * is that the adapter separately measures the audio owner and the lower
 * priority background load, then proves the latter did real work without
 * making the former miss a service deadline.
 */
export interface PlaybackEnduranceLoadEvidence {
  appliedWorkUnits: number;
  audioDeadlineMisses: number;
  audioOwnerCoreCpuPermille: number;
  backgroundCoreCpuPermille: number;
  cpuTimeMs: number;
  maximumAudioServiceLatencyMs: number;
}

export interface PlaybackEnduranceArtifact {
  byteLength: number;
  format: "pcm-s16le-mono";
  hashVerification: {
    computedSha256: string;
    matched: boolean;
  };
  path: string;
  sampleRateHz: number;
  sha256: string;
}

export interface PlaybackEndurancePcmDeliveryIncident {
  layer: "device-ingress" | "provider" | "proxy" | "public-tunnel";
  observedAtMonotonicMs: number;
  reason: string;
}

export interface PlaybackEndurancePcmCadenceEvidence {
  clock: "device-monotonic" | "host-monotonic";
  earlyGapCount: number;
  firstFrameIndex: number;
  firstFrameObservedAtMonotonicUs: number;
  gapCount: number;
  interFrameGapP50Us: number;
  interFrameGapP95Us: number;
  interFrameGapP99Us: number;
  lastFrameIndex: number;
  lastFrameObservedAtMonotonicUs: number;
  lateGapCount: number;
  maximumFrameLatenessUs: number;
  maximumInterFrameGapUs: number;
  minimumInterFrameGapUs: number;
  missedDeadlineCount: number;
  timelineOriginAtMonotonicUs: number;
}

/**
 * Host-verifiable proof of the bytes offered to the PCM transport.
 *
 * The source and microphone artifacts answer different questions. The source
 * proves that the host generated and retained the complete requested stream;
 * the capture proves what became audible. Delivery accounting between them
 * prevents a reconnect or provider stall from being misdiagnosed as an ESP32
 * speaker failure.
 */
export interface PlaybackEndurancePcmSourceEvidence {
  artifact: PlaybackEnduranceArtifact;
  delivery: {
    discontinuityCount: number;
    emittedFrameCount: number;
    retainedIncidents: PlaybackEndurancePcmDeliveryIncident[];
    timing: {
      deviceIngress: PlaybackEndurancePcmCadenceEvidence;
      provider: PlaybackEndurancePcmCadenceEvidence;
      schedule: "absolute-media-deadlines";
    };
  };
  expectedByteLength: number;
  inspectionMaximumBufferedAudioBytes: number;
}

export interface PlaybackEnduranceMetricSample {
  /**
   * Host receipt time is the delivery-cadence authority. A device timestamp
   * can remain perfectly spaced while callbacks are buffered and replayed.
   */
  capturedAtMonotonicMs: number;
  /** Stable boot identity binds a sample to the subject inspected for the run. */
  deviceBootId: string;
  /** Device production time diagnoses source-side stalls independently of delivery. */
  deviceProducedAtMonotonicMs: number;
  /** Exact sequence exposes callback loss, replay, and duplicate subscriptions. */
  deviceSequence: number;
  values: Record<string, number | string>;
}

/**
 * JSON-stable form of analyzer output retained in a proof manifest.
 *
 * The analyzer uses undefined when it observes no tone because that is natural
 * inside TypeScript. A persisted proof cannot: JSON drops undefined object
 * properties. Null keeps "not observed" explicit and round-trippable.
 */
export interface PlaybackEndurancePersistedAcousticAnalysis extends Omit<
  AcousticToneAnalysis,
  "observedEndMs" | "observedStartMs"
> {
  observedEndMs: number | null;
  observedStartMs: number | null;
}

/**
 * Complete device-specific evidence returned to the device-neutral judge.
 *
 * Adapters own acquisition because serial ports, Cap'n Web handles, audio
 * capture, and load tasks vary by target. They do not return a pass/fail bit:
 * the shared core makes that decision from raw observations so no target can
 * silently weaken the proof.
 */
export interface PlaybackEnduranceRunObservation {
  acoustic: {
    analysis: AcousticToneAnalysis;
    artifact: PlaybackEnduranceArtifact;
    captureProvenance?: MacOsCaptureProvenance;
    relativeClockDriftPpm: number | "unavailable";
    watermark?: {
      analysis: DualCarrierPrbs31ArtifactAnalysis;
      challenge: DualCarrierPrbs31Challenge;
    };
  };
  completedAtIso: string;
  countersAfter: Record<string, number>;
  countersBefore: Record<string, number>;
  loadEvidence: PlaybackEnduranceLoadEvidence;
  metricSamples: PlaybackEnduranceMetricSample[];
  pcmSource?: PlaybackEndurancePcmSourceEvidence;
  playbackCompletedAtMonotonicMs: number;
  playbackStartedAtMonotonicMs: number;
  startedAtIso: string;
}

export interface PlaybackEnduranceThresholds {
  acoustic: AcousticToneThresholds;
  /**
   * Required whenever an observation carries the run-keyed watermark.
   *
   * Legacy tone-only diagnostics may omit it. A watermark observation with no
   * explicit versioned policy fails closed in the shared manifest judge.
   */
  acousticWatermark?: DualCarrierPrbs31Thresholds;
  acousticPolicy: {
    expectedToneFrequencyHz: number;
    expectedWindowDurationMs: number;
    maximumAbsoluteRelativeClockDriftPpm: number;
    relativeClockDriftRequiredAtOrAboveDurationMs: number;
  };
  counterExpectedDeltas: Record<string, number>;
  counterMaximumDeltas: Record<string, number>;
  loadEvidence: {
    minimumAppliedWorkUnits: number;
    maximumAudioOwnerCoreCpuPermille: number;
    minimumBackgroundCoreCpuPermille: number;
    minimumCpuTimeMs: number;
    minimumRequestedCpuFraction: number;
    minimumRequestedWorkFraction: number;
    maximumAudioDeadlineMisses: number;
    maximumAudioServiceLatencyMs: number;
  };
  maximumRunDurationErrorMs: number;
  metricMaximumValues: Record<string, number>;
  metricMinimumValues: Record<string, number>;
  metricsCadence: {
    expectedIntervalMs: number;
    maximumIntervalMs: number;
  };
  pcmSourceTiming?: {
    maximumFrameLatenessUs: number;
    maximumInterFrameGapUs: number;
    minimumInterFrameGapUs: number;
  };
  pcmFrameDurationMs: number;
}

export interface PlaybackEnduranceTarget {
  inspect(): Promise<{
    device: PlaybackEnduranceDeviceIdentity;
    firmware: PlaybackEnduranceFirmwareIdentity;
  }>;
  runPlayback(request: {
    durationMs: number;
    ladderIndex: number;
    loadProfile: PlaybackEnduranceLoadProfile;
  }): Promise<PlaybackEnduranceRunObservation>;
}

export interface PlaybackEnduranceMetricsCadenceAudit {
  deviceBootChangeCount: number;
  deviceClockRegressionCount: number;
  deviceSequenceDiscontinuityCount: number;
  deviceSequenceMissingSampleCount: number;
  expectedMinimumSampleCount: number;
  firstSampleOffsetMs: number;
  lastSampleOffsetMs: number;
  lateGapCount: number;
  maximumObservedGapMs: number;
  missingSampleCount: number;
  outsideRunSampleCount: number;
  outOfOrderSampleCount: number;
  sampleCount: number;
  validSampleCount: number;
}

/**
 * A self-contained JSON value suitable for one JSONL proof record.
 *
 * The manifest intentionally repeats raw counter snapshots, their deltas, all
 * metrics samples, thresholds, and assessments. This costs a few hundred
 * small records over ten minutes but lets later tooling audit the original
 * evidence without recreating state from console output.
 */
export interface PlaybackEnduranceRunManifest {
  acoustic: {
    analysis: PlaybackEndurancePersistedAcousticAnalysis;
    artifact: PlaybackEnduranceArtifact;
    assessment: AcousticToneAssessment;
    captureProvenance?: MacOsCaptureProvenance;
    relativeClockDriftPpm: number | "unavailable";
    watermark?: {
      analysis: DualCarrierPrbs31ArtifactAnalysis;
      assessment: DualCarrierPrbs31Assessment;
      challenge: DualCarrierPrbs31Challenge;
    };
  };
  completedAtIso: string;
  counters: {
    after: Record<string, number>;
    before: Record<string, number>;
    deltas: Record<string, number | null>;
  };
  device: PlaybackEnduranceDeviceIdentity;
  durationMs: number;
  firmware: PlaybackEnduranceFirmwareIdentity;
  frameAccounting: {
    acceptedDelta: number | null;
    completedDelta: number | null;
    expectedFrameCount: number;
    submittedDelta: number | null;
  };
  ladderIndex: number;
  loadEvidence: PlaybackEnduranceLoadEvidence;
  loadProfile: PlaybackEnduranceLoadProfile;
  metricSamples: PlaybackEnduranceMetricSample[];
  metricThresholdBreaches: (
    | {
        capturedAtMonotonicMs: number;
        kind: "maximum";
        maximum: number;
        metric: string;
        observed: number | null;
      }
    | {
        capturedAtMonotonicMs: number;
        kind: "minimum";
        metric: string;
        minimum: number;
        observed: number | null;
      }
  )[];
  metricsCadence: PlaybackEnduranceMetricsCadenceAudit;
  policy: PlaybackEndurancePolicyIdentity;
  pcmSource?: PlaybackEndurancePcmSourceEvidence;
  result: {
    acceptancePassed: boolean;
    passed: boolean;
    reasons: string[];
  };
  runDurationMs: number;
  schemaVersion: 1;
  startedAtIso: string;
  thresholds: PlaybackEnduranceThresholds;
}

export interface PlaybackEnduranceLadderResult {
  acceptancePassed: boolean;
  passed: boolean;
  plannedRunCount: number;
  policy: PlaybackEndurancePolicyIdentity;
  runs: PlaybackEnduranceRunManifest[];
  stoppedAfterFailure: boolean;
}
