import { assessAcousticToneAnalysis } from "./acoustic-tone-analysis.ts";
import { assessDualCarrierPrbs31Analysis } from "./acoustic-prbs31-challenge.ts";
import type {
  PlaybackEnduranceDeviceIdentity,
  PlaybackEnduranceFirmwareIdentity,
  PlaybackEnduranceLoadProfile,
  PlaybackEnduranceMetricsCadenceAudit,
  PlaybackEndurancePolicyIdentity,
  PlaybackEnduranceRunManifest,
  PlaybackEnduranceRunObservation,
  PlaybackEnduranceThresholds,
} from "./playback-endurance-types.ts";
import { assertPlaybackEnduranceObservation } from "./playback-endurance-validation.ts";

export function buildPlaybackEnduranceRunManifest(options: {
  device: PlaybackEnduranceDeviceIdentity;
  durationMs: number;
  firmware: PlaybackEnduranceFirmwareIdentity;
  ladderIndex: number;
  loadProfile: PlaybackEnduranceLoadProfile;
  observation: PlaybackEnduranceRunObservation;
  policy: PlaybackEndurancePolicyIdentity;
  thresholds: PlaybackEnduranceThresholds;
}): PlaybackEnduranceRunManifest {
  assertPlaybackEnduranceObservation(options.observation);
  const runDurationMs =
    options.observation.playbackCompletedAtMonotonicMs -
    options.observation.playbackStartedAtMonotonicMs;
  const metricsCadence = auditMetricsCadence(
    options.observation.metricSamples,
    options.observation.playbackStartedAtMonotonicMs,
    options.observation.playbackCompletedAtMonotonicMs,
    options.thresholds.metricsCadence,
  );
  const watermark = options.observation.acoustic.watermark;
  const analyzerAssessment = watermark
    ? options.thresholds.acousticWatermark
      ? assessDualCarrierPrbs31Analysis(watermark.analysis, options.thresholds.acousticWatermark)
      : {
          passed: false,
          reasons: ["the run-keyed acoustic watermark has no versioned acceptance thresholds"],
        }
    : assessAcousticToneAnalysis(
        options.observation.acoustic.analysis,
        options.thresholds.acoustic,
      );
  /*
   * Analyzer threshold success is insufficient if the adapter analyzed the
   * wrong file or used a different policy. Cross-check the retained PCM facts
   * here, in the device-neutral judge, so an adapter cannot manufacture a
   * green run by accidentally returning a valid analysis of stale evidence.
   */
  const acousticConsistencyReasons = assessAcousticEvidenceConsistency(options);
  const acousticAssessment = {
    passed: analyzerAssessment.passed && acousticConsistencyReasons.length === 0,
    reasons: [...analyzerAssessment.reasons, ...acousticConsistencyReasons],
  };
  const counterDeltas = calculateCounterDeltas(
    options.observation.countersBefore,
    options.observation.countersAfter,
    [
      "downlink_accepted",
      "playback_completed",
      "playback_submitted",
      ...Object.keys(options.thresholds.counterExpectedDeltas),
      ...Object.keys(options.thresholds.counterMaximumDeltas),
    ],
  );
  const reasons = [...acousticAssessment.reasons];
  const metricThresholdBreaches: PlaybackEnduranceRunManifest["metricThresholdBreaches"] = [];
  const minimumAcousticArtifactBytes = Math.ceil(
    (options.durationMs * options.observation.acoustic.artifact.sampleRateHz * 2) / 1_000,
  );
  const expectedFrameCount = options.durationMs / options.thresholds.pcmFrameDurationMs;
  const acceptedDelta = counterDeltas.downlink_accepted ?? null;
  const submittedDelta = counterDeltas.playback_submitted ?? null;
  const completedDelta = counterDeltas.playback_completed ?? null;

  const durationErrorMs = Math.abs(runDurationMs - options.durationMs);
  if (durationErrorMs > options.thresholds.maximumRunDurationErrorMs) {
    reasons.push(
      `run duration error ${durationErrorMs}ms exceeds ` +
        `${options.thresholds.maximumRunDurationErrorMs}ms`,
    );
  }
  if (options.observation.acoustic.artifact.byteLength < minimumAcousticArtifactBytes) {
    reasons.push(
      `acoustic artifact has ${options.observation.acoustic.artifact.byteLength} bytes but ` +
        `${minimumAcousticArtifactBytes} are required for the requested run`,
    );
  }
  if (
    !options.observation.acoustic.artifact.hashVerification.matched ||
    options.observation.acoustic.artifact.hashVerification.computedSha256 !==
      options.observation.acoustic.artifact.sha256
  ) {
    reasons.push("acoustic artifact SHA-256 verification did not match the retained artifact");
  }
  if (metricsCadence.outOfOrderSampleCount > 0) {
    reasons.push(
      `${metricsCadence.outOfOrderSampleCount} metrics samples were not strictly ordered`,
    );
  }
  if (metricsCadence.deviceBootChangeCount > 0) {
    reasons.push(
      `${metricsCadence.deviceBootChangeCount} metrics samples changed device boot identity`,
    );
  }
  if (metricsCadence.deviceClockRegressionCount > 0) {
    reasons.push(
      `${metricsCadence.deviceClockRegressionCount} device metric production timestamps ` +
        "did not strictly advance",
    );
  }
  if (metricsCadence.deviceSequenceDiscontinuityCount > 0) {
    reasons.push(
      `${metricsCadence.deviceSequenceDiscontinuityCount} device metric sequence ` +
        "discontinuities were observed",
    );
  }
  if (metricsCadence.deviceSequenceMissingSampleCount > 0) {
    reasons.push(
      `${metricsCadence.deviceSequenceMissingSampleCount} device-produced metrics samples ` +
        "were missing",
    );
  }
  if (metricsCadence.outsideRunSampleCount > 0) {
    reasons.push(
      `${metricsCadence.outsideRunSampleCount} metrics samples were outside the playback run`,
    );
  }
  if (metricsCadence.missingSampleCount > 0) {
    reasons.push(`${metricsCadence.missingSampleCount} expected metrics samples were not observed`);
  }
  if (metricsCadence.lateGapCount > 0) {
    reasons.push(
      `${metricsCadence.lateGapCount} metrics cadence gaps exceeded ` +
        `${options.thresholds.metricsCadence.maximumIntervalMs}ms`,
    );
  }
  /*
   * End-of-run snapshots miss transient starvation. Inspecting every retained
   * sample catches a one-second deadline spike even if the counter or gauge
   * recovers before teardown. Missing and nonnumeric fields are also failures;
   * absence is not evidence that a threshold was respected.
   */
  for (const sample of options.observation.metricSamples) {
    for (const [metric, maximum] of Object.entries(options.thresholds.metricMaximumValues)) {
      const observed = sample.values[metric];
      if (typeof observed !== "number" || !Number.isFinite(observed) || observed > maximum) {
        metricThresholdBreaches.push({
          capturedAtMonotonicMs: sample.capturedAtMonotonicMs,
          kind: "maximum",
          maximum,
          metric,
          observed: typeof observed === "number" && Number.isFinite(observed) ? observed : null,
        });
      }
    }
    for (const [metric, minimum] of Object.entries(options.thresholds.metricMinimumValues)) {
      const observed = sample.values[metric];
      if (typeof observed !== "number" || !Number.isFinite(observed) || observed < minimum) {
        metricThresholdBreaches.push({
          capturedAtMonotonicMs: sample.capturedAtMonotonicMs,
          kind: "minimum",
          metric,
          minimum,
          observed: typeof observed === "number" && Number.isFinite(observed) ? observed : null,
        });
      }
    }
  }
  for (const breach of metricThresholdBreaches) {
    if (breach.observed === null) {
      reasons.push(
        `metric ${breach.metric} was missing or nonnumeric at ` +
          `${breach.capturedAtMonotonicMs}ms`,
      );
    } else if (breach.kind === "maximum") {
      reasons.push(
        `metric ${breach.metric} value ${breach.observed} exceeds ` +
          `${breach.maximum} at ${breach.capturedAtMonotonicMs}ms`,
      );
    } else {
      reasons.push(
        `metric ${breach.metric} value ${breach.observed} is below ` +
          `${breach.minimum} at ${breach.capturedAtMonotonicMs}ms`,
      );
    }
  }
  for (const [counter, delta] of Object.entries(counterDeltas)) {
    const beforePresent = Object.hasOwn(options.observation.countersBefore, counter);
    const afterPresent = Object.hasOwn(options.observation.countersAfter, counter);
    if (!beforePresent) {
      reasons.push(`counter ${counter} is missing from the before snapshot`);
    }
    if (!afterPresent) {
      reasons.push(`counter ${counter} is missing from the after snapshot`);
    }
    if (delta !== null && delta < 0) {
      reasons.push(`counter ${counter} regressed by ${Math.abs(delta)}`);
    }
  }
  for (const [counter, maximumDelta] of Object.entries(options.thresholds.counterMaximumDeltas)) {
    const delta = counterDeltas[counter];
    if (delta === undefined || delta === null) {
      reasons.push(`required maximum counter ${counter} was not observed in both snapshots`);
    } else if (delta > maximumDelta) {
      reasons.push(`counter ${counter} delta ${delta} exceeds ${maximumDelta}`);
    }
  }
  for (const [counter, expectedDelta] of Object.entries(options.thresholds.counterExpectedDeltas)) {
    const delta = counterDeltas[counter];
    if (delta === undefined || delta === null) {
      reasons.push(`required exact counter ${counter} was not observed in both snapshots`);
    } else if (delta !== expectedDelta) {
      reasons.push(`counter ${counter} delta ${delta} does not equal required ${expectedDelta}`);
    }
  }
  if (!Number.isSafeInteger(expectedFrameCount)) {
    reasons.push(
      `duration ${options.durationMs}ms does not contain whole ` +
        `${options.thresholds.pcmFrameDurationMs}ms PCM frames`,
    );
  }
  const frameCounterDeltas = {
    downlink_accepted: acceptedDelta,
    playback_completed: completedDelta,
    playback_submitted: submittedDelta,
  };
  for (const [counter, delta] of Object.entries(frameCounterDeltas)) {
    if (delta === null) {
      reasons.push(`required frame counter ${counter} was not observed`);
    } else if (delta !== expectedFrameCount) {
      reasons.push(
        `frame counter ${counter} delta ${delta} does not equal ` +
          `expected ${expectedFrameCount}`,
      );
    }
  }
  const evidence = options.observation.loadEvidence;
  const minimums = options.thresholds.loadEvidence;
  if (evidence.audioOwnerCoreCpuPermille > minimums.maximumAudioOwnerCoreCpuPermille) {
    reasons.push(
      `audio-owner CPU ${evidence.audioOwnerCoreCpuPermille} permille exceeds ` +
        `${minimums.maximumAudioOwnerCoreCpuPermille}`,
    );
  }
  if (evidence.audioDeadlineMisses > minimums.maximumAudioDeadlineMisses) {
    reasons.push(
      `audio deadline misses ${evidence.audioDeadlineMisses} exceed ` +
        `${minimums.maximumAudioDeadlineMisses}`,
    );
  }
  if (evidence.maximumAudioServiceLatencyMs > minimums.maximumAudioServiceLatencyMs) {
    reasons.push(
      `maximum audio service latency ${evidence.maximumAudioServiceLatencyMs}ms exceeds ` +
        `${minimums.maximumAudioServiceLatencyMs}ms`,
    );
  }
  if (options.loadProfile.kind === "loaded") {
    const maximumAvailableCpuTimeMs =
      runDurationMs * options.loadProfile.requested.concurrentWorkerCount;
    if (evidence.cpuTimeMs > maximumAvailableCpuTimeMs) {
      reasons.push(
        `load CPU time ${evidence.cpuTimeMs}ms exceeds ` +
          `${maximumAvailableCpuTimeMs}ms available to ` +
          `${options.loadProfile.requested.concurrentWorkerCount} workers`,
      );
    }
    if (evidence.appliedWorkUnits < minimums.minimumAppliedWorkUnits) {
      reasons.push(
        `applied load work ${evidence.appliedWorkUnits} is below ` +
          `${minimums.minimumAppliedWorkUnits}`,
      );
    }
    if (evidence.cpuTimeMs < minimums.minimumCpuTimeMs) {
      reasons.push(`load CPU time ${evidence.cpuTimeMs}ms is below ${minimums.minimumCpuTimeMs}ms`);
    }
    if (evidence.backgroundCoreCpuPermille < minimums.minimumBackgroundCoreCpuPermille) {
      reasons.push(
        `background-core load CPU ${evidence.backgroundCoreCpuPermille} permille is below ` +
          `${minimums.minimumBackgroundCoreCpuPermille}`,
      );
    }
    const requestedWorkMinimum = Math.ceil(
      options.loadProfile.requested.workUnitsPerSecond *
        (options.durationMs / 1_000) *
        minimums.minimumRequestedWorkFraction,
    );
    if (evidence.appliedWorkUnits < requestedWorkMinimum) {
      reasons.push(
        `applied load work ${evidence.appliedWorkUnits} is below requested ` +
          `proof minimum ${requestedWorkMinimum}`,
      );
    }
    const requestedBackgroundCpuMinimum = Math.ceil(
      options.loadProfile.requested.targetCpuPermille * minimums.minimumRequestedCpuFraction,
    );
    if (evidence.backgroundCoreCpuPermille < requestedBackgroundCpuMinimum) {
      reasons.push(
        `background-core load CPU ${evidence.backgroundCoreCpuPermille} permille ` +
          `is below requested proof minimum ${requestedBackgroundCpuMinimum}`,
      );
    }
    const requestedCpuTimeMinimum = Math.ceil(
      (options.durationMs *
        options.loadProfile.requested.targetCpuPermille *
        minimums.minimumRequestedCpuFraction) /
        1_000,
    );
    if (evidence.cpuTimeMs < requestedCpuTimeMinimum) {
      reasons.push(
        `load CPU time ${evidence.cpuTimeMs}ms is below requested proof ` +
          `minimum ${requestedCpuTimeMinimum}ms`,
      );
    }
  }

  return {
    acoustic: {
      analysis: {
        ...options.observation.acoustic.analysis,
        /*
         * Failed no-tone analyses have no endpoints. Preserve that absence as
         * null because JSON would silently erase undefined properties.
         */
        observedEndMs: options.observation.acoustic.analysis.observedEndMs ?? null,
        observedStartMs: options.observation.acoustic.analysis.observedStartMs ?? null,
      },
      artifact: options.observation.acoustic.artifact,
      assessment: acousticAssessment,
      captureProvenance: options.observation.acoustic.captureProvenance
        ? structuredClone(options.observation.acoustic.captureProvenance)
        : undefined,
      relativeClockDriftPpm: options.observation.acoustic.relativeClockDriftPpm,
      watermark: watermark
        ? {
            analysis: structuredClone(watermark.analysis),
            assessment: analyzerAssessment,
            challenge: structuredClone(watermark.challenge),
          }
        : undefined,
    },
    completedAtIso: options.observation.completedAtIso,
    counters: {
      after: { ...options.observation.countersAfter },
      before: { ...options.observation.countersBefore },
      deltas: counterDeltas,
    },
    device: { ...options.device },
    durationMs: options.durationMs,
    firmware: { ...options.firmware },
    frameAccounting: {
      acceptedDelta,
      completedDelta,
      expectedFrameCount,
      submittedDelta,
    },
    ladderIndex: options.ladderIndex,
    loadEvidence: { ...options.observation.loadEvidence },
    loadProfile: structuredClone(options.loadProfile),
    metricSamples: structuredClone(options.observation.metricSamples),
    metricThresholdBreaches,
    metricsCadence,
    policy: structuredClone(options.policy),
    result: {
      acceptancePassed: options.policy.classification === "acceptance" && reasons.length === 0,
      passed: reasons.length === 0,
      reasons,
    },
    runDurationMs,
    schemaVersion: 1,
    startedAtIso: options.observation.startedAtIso,
    thresholds: structuredClone(options.thresholds),
  };
}

/**
 * Correlates analyzer claims with the physical artifact and run contract.
 *
 * These checks deliberately live outside the tone analyzer: the analyzer
 * knows only the options an adapter handed it, while this judge knows what the
 * ladder actually requested. Keeping those authorities separate makes stale
 * paths, wrong sample rates, and weakened analysis settings observable.
 */
function assessAcousticEvidenceConsistency(
  options: Parameters<typeof buildPlaybackEnduranceRunManifest>[0],
) {
  const reasons: string[] = [];
  const acoustic = options.observation.acoustic;
  const analysis = acoustic.analysis;
  const artifact = acoustic.artifact;
  const policy = options.thresholds.acousticPolicy;
  const watermark = acoustic.watermark;

  if (watermark) {
    const analysis = watermark.analysis;
    if (analysis.expectedDurationMs !== options.durationMs) {
      reasons.push(
        `watermark analysis expected duration ${analysis.expectedDurationMs}ms ` +
          `does not equal requested ${options.durationMs}ms`,
      );
    }
    if (analysis.sampleRateHz !== artifact.sampleRateHz) {
      reasons.push(
        `watermark analysis sample rate ${analysis.sampleRateHz}Hz does not equal ` +
          `artifact sample rate ${artifact.sampleRateHz}Hz`,
      );
    }
    if (analysis.expectedSeedCommitment !== watermark.challenge.seedCommitmentSha256) {
      reasons.push("watermark analysis seed commitment does not match the run challenge");
    }
    if (analysis.artifactByteLength !== artifact.byteLength) {
      reasons.push(
        `watermark artifact length ${analysis.artifactByteLength} does not equal ` +
          `retained artifact length ${artifact.byteLength}`,
      );
    }
    if (analysis.artifactSha256 !== artifact.sha256) {
      reasons.push("watermark artifact SHA-256 does not match the retained artifact");
    }
    if (
      !Number.isSafeInteger(analysis.maximumBufferedAudioBytes) ||
      analysis.maximumBufferedAudioBytes <= 0 ||
      analysis.maximumBufferedAudioBytes > 64 * 1_024
    ) {
      reasons.push(
        `watermark analyzer buffered ${analysis.maximumBufferedAudioBytes} audio bytes; ` +
          `a positive bound no greater than 65536 is required`,
      );
    }
    if (
      !Number.isFinite(analysis.fittedClockDriftPpm) ||
      (options.thresholds.acousticWatermark !== undefined &&
        Math.abs(analysis.fittedClockDriftPpm) >
          options.thresholds.acousticWatermark.maximumAbsoluteClockDriftPpm)
    ) {
      const maximumClockDriftPpm =
        options.thresholds.acousticWatermark?.maximumAbsoluteClockDriftPpm ?? "unavailable";
      reasons.push(
        `absolute watermark clock drift ` +
          `${Math.abs(analysis.fittedClockDriftPpm)}ppm exceeds ` +
          `${maximumClockDriftPpm}ppm`,
      );
    }
    const provenance = acoustic.captureProvenance;
    if (!provenance) {
      reasons.push("acoustic capture provenance is required for watermark acceptance");
    } else {
      if (
        provenance.input.verification !== "host-resolved-coreaudio-uid" ||
        !provenance.input.stableId.trim()
      ) {
        reasons.push("acoustic capture input was not host-resolved to a stable CoreAudio identity");
      }
      if (
        provenance.processing.verification !== "host-resolved-avfoundation-microphone-mode" ||
        provenance.processing.activeMicrophoneMode !== "wide-spectrum"
      ) {
        reasons.push("active AVFoundation microphone mode was not host-resolved as Wide Spectrum");
      }
      if (
        !provenance.recorder.executable.trim() ||
        !provenance.recorder.version.trim() ||
        provenance.recorder.arguments.at(-1) !== artifact.path
      ) {
        reasons.push("acoustic recorder identity or exact output argument is unavailable");
      }
    }
    return reasons;
  }

  if (analysis.expectedDurationMs !== options.durationMs) {
    reasons.push(
      `acoustic analysis expected duration ${analysis.expectedDurationMs}ms ` +
        `does not equal requested ${options.durationMs}ms`,
    );
  }
  if (analysis.sampleRateHz !== artifact.sampleRateHz) {
    reasons.push(
      `acoustic analysis sample rate ${analysis.sampleRateHz}Hz does not equal ` +
        `artifact sample rate ${artifact.sampleRateHz}Hz`,
    );
  }
  /*
   * PCM16 mono stores exactly two bytes per sample. One-sample tolerance
   * absorbs only floating-point conversion; it cannot hide analysis of a
   * truncated or different recording.
   */
  const artifactDurationMs = (artifact.byteLength * 1_000) / (2 * artifact.sampleRateHz);
  const oneArtifactSampleMs = 1_000 / artifact.sampleRateHz;
  if (Math.abs(analysis.totalDurationMs - artifactDurationMs) > oneArtifactSampleMs) {
    reasons.push(
      `acoustic analysis duration ${analysis.totalDurationMs}ms is inconsistent ` +
        `with artifact duration ${artifactDurationMs}ms`,
    );
  }
  if (analysis.toneFrequencyHz !== policy.expectedToneFrequencyHz) {
    reasons.push(
      `acoustic analysis tone frequency ${analysis.toneFrequencyHz}Hz does not ` +
        `equal policy ${policy.expectedToneFrequencyHz}Hz`,
    );
  }
  if (analysis.windowDurationMs !== policy.expectedWindowDurationMs) {
    reasons.push(
      `acoustic analysis window ${analysis.windowDurationMs}ms does not equal ` +
        `policy ${policy.expectedWindowDurationMs}ms`,
    );
  }
  if (
    acoustic.relativeClockDriftPpm === "unavailable" &&
    options.durationMs >= policy.relativeClockDriftRequiredAtOrAboveDurationMs
  ) {
    reasons.push(
      `relative clock drift is required for playback runs of ` +
        `${policy.relativeClockDriftRequiredAtOrAboveDurationMs}ms or longer`,
    );
  } else if (
    acoustic.relativeClockDriftPpm !== "unavailable" &&
    Math.abs(acoustic.relativeClockDriftPpm) > policy.maximumAbsoluteRelativeClockDriftPpm
  ) {
    reasons.push(
      `absolute relative clock drift ` +
        `${Math.abs(acoustic.relativeClockDriftPpm)}ppm exceeds ` +
        `${policy.maximumAbsoluteRelativeClockDriftPpm}ppm`,
    );
  }

  return reasons;
}

/**
 * Audits arrival order and the two run boundaries, not merely adjacent
 * samples. Without boundary gaps, a metrics source could stop for most of a
 * ten-minute run, emit two adjacent samples at the end, and appear healthy.
 *
 * Invalid or replayed records stay in the manifest but do not satisfy the
 * expected sample count. Otherwise a burst of duplicate reports could conceal
 * the exact diagnostics outage this audit exists to find.
 */
function auditMetricsCadence(
  samples: PlaybackEnduranceRunObservation["metricSamples"],
  playbackStartedAtMonotonicMs: number,
  playbackCompletedAtMonotonicMs: number,
  thresholds: PlaybackEnduranceThresholds["metricsCadence"],
): PlaybackEnduranceMetricsCadenceAudit {
  let deviceBootChangeCount = 0;
  let deviceClockRegressionCount = 0;
  let deviceSequenceDiscontinuityCount = 0;
  let deviceSequenceMissingSampleCount = 0;
  let outOfOrderSampleCount = 0;
  let outsideRunSampleCount = 0;
  let lateGapCount = 0;
  let maximumObservedGapMs = 0;
  let previousSampleMs = playbackStartedAtMonotonicMs;
  let firstValidSampleMs: number | undefined;
  let firstDeviceBootId: string | undefined;
  let previousDeviceProducedAtMonotonicMs: number | undefined;
  let previousDeviceSequence: number | undefined;
  let validSampleCount = 0;
  for (const sample of samples) {
    const sampleMs = sample.capturedAtMonotonicMs;
    firstDeviceBootId ??= sample.deviceBootId;
    if (sample.deviceBootId !== firstDeviceBootId) {
      deviceBootChangeCount += 1;
    }
    if (
      previousDeviceProducedAtMonotonicMs !== undefined &&
      sample.deviceProducedAtMonotonicMs <= previousDeviceProducedAtMonotonicMs
    ) {
      deviceClockRegressionCount += 1;
    }
    if (
      previousDeviceSequence !== undefined &&
      sample.deviceSequence !== previousDeviceSequence + 1
    ) {
      deviceSequenceDiscontinuityCount += 1;
      if (sample.deviceSequence > previousDeviceSequence + 1) {
        deviceSequenceMissingSampleCount += sample.deviceSequence - previousDeviceSequence - 1;
      }
    }
    previousDeviceProducedAtMonotonicMs = sample.deviceProducedAtMonotonicMs;
    previousDeviceSequence = sample.deviceSequence;
    if (
      !Number.isFinite(sampleMs) ||
      sampleMs < playbackStartedAtMonotonicMs ||
      sampleMs > playbackCompletedAtMonotonicMs
    ) {
      outsideRunSampleCount += 1;
      continue;
    }
    if (validSampleCount > 0 && sampleMs <= previousSampleMs) {
      outOfOrderSampleCount += 1;
      continue;
    }
    const gapMs = sampleMs - previousSampleMs;
    maximumObservedGapMs = Math.max(maximumObservedGapMs, gapMs);
    if (gapMs > thresholds.maximumIntervalMs) {
      lateGapCount += 1;
    }
    firstValidSampleMs ??= sampleMs;
    previousSampleMs = sampleMs;
    validSampleCount += 1;
  }
  const finalGapMs = playbackCompletedAtMonotonicMs - previousSampleMs;
  maximumObservedGapMs = Math.max(maximumObservedGapMs, finalGapMs);
  if (finalGapMs > thresholds.maximumIntervalMs) {
    lateGapCount += 1;
  }
  const runDurationMs = playbackCompletedAtMonotonicMs - playbackStartedAtMonotonicMs;
  const expectedMinimumSampleCount = Math.floor(runDurationMs / thresholds.expectedIntervalMs);

  return {
    deviceBootChangeCount,
    deviceClockRegressionCount,
    deviceSequenceDiscontinuityCount,
    deviceSequenceMissingSampleCount,
    expectedMinimumSampleCount,
    firstSampleOffsetMs:
      firstValidSampleMs === undefined
        ? runDurationMs
        : firstValidSampleMs - playbackStartedAtMonotonicMs,
    lastSampleOffsetMs:
      validSampleCount === 0 ? runDurationMs : playbackCompletedAtMonotonicMs - previousSampleMs,
    lateGapCount,
    maximumObservedGapMs,
    missingSampleCount: Math.max(0, expectedMinimumSampleCount - validSampleCount),
    outsideRunSampleCount,
    outOfOrderSampleCount,
    sampleCount: samples.length,
    validSampleCount,
  };
}

/**
 * Stores both snapshots plus the independently derived delta. Keeping all
 * three is intentionally redundant: a later schema migration can recalculate
 * the delta, while an operator can still see the exact values that produced a
 * release-blocking counter change.
 */
function calculateCounterDeltas(
  before: Record<string, number>,
  after: Record<string, number>,
  requiredCounters: string[],
) {
  const counters = new Set([...Object.keys(before), ...Object.keys(after), ...requiredCounters]);
  const deltas: Record<string, number | null> = {};
  for (const counter of [...counters].sort()) {
    const beforeValue = before[counter];
    const afterValue = after[counter];
    /*
     * Missing is not zero. Setting null keeps the manifest JSON-exact while
     * preventing a schema change from manufacturing a plausible frame delta.
     */
    deltas[counter] =
      beforeValue === undefined || afterValue === undefined ? null : afterValue - beforeValue;
  }
  return deltas;
}
