import type {
  PlaybackEnduranceDeviceIdentity,
  PlaybackEnduranceFirmwareIdentity,
  PlaybackEnduranceLoadProfile,
  PlaybackEnduranceRunObservation,
  PlaybackEnduranceThresholds,
} from "./playback-endurance-types.ts";

const sha256Pattern = /^[0-9a-f]{64}$/;

/**
 * Rejects malformed harness configuration before touching a physical device.
 *
 * A zero tolerance or NaN threshold can make every comparison vacuously pass.
 * Configuration errors are therefore exceptions, while valid observations
 * that exceed a threshold become ordinary failed run manifests.
 */
export function assertPlaybackEnduranceConfiguration(
  loadProfiles: PlaybackEnduranceLoadProfile[],
  thresholds: PlaybackEnduranceThresholds,
) {
  if (loadProfiles.length === 0) {
    throw new Error(
      "Invalid playback endurance configuration: at least one load profile is required.",
    );
  }
  const profileIds = new Set<string>();
  for (const profile of loadProfiles) {
    requireNonemptyString("load profile id", profile.id, "configuration");
    if (profileIds.has(profile.id)) {
      throw new Error(
        `Invalid playback endurance configuration: duplicate load profile id ${profile.id}.`,
      );
    }
    profileIds.add(profile.id);
    if (profile.kind === "loaded") {
      /*
       * CPU time is cumulative across workers. Retaining the declared worker
       * count lets the judge reject physically impossible measurements rather
       * than accepting any sufficiently large number as proof of load.
       */
      requirePositiveSafeInteger(
        `${profile.id} concurrentWorkerCount`,
        profile.requested.concurrentWorkerCount,
        "configuration",
      );
      requirePositiveFinite(
        `${profile.id} targetCpuPermille`,
        profile.requested.targetCpuPermille,
        "configuration",
      );
      if (profile.requested.targetCpuPermille > 1_000) {
        throw new Error(
          `Invalid playback endurance configuration: ${profile.id} ` +
            "targetCpuPermille must not exceed 1000.",
        );
      }
      requireNonemptyString(`${profile.id} workUnit`, profile.requested.workUnit, "configuration");
      requirePositiveFinite(
        `${profile.id} workUnitsPerSecond`,
        profile.requested.workUnitsPerSecond,
        "configuration",
      );
    }
  }

  for (const [name, value] of Object.entries(thresholds.acoustic)) {
    requireNonnegativeFinite(`acoustic.${name}`, value, "configuration");
  }
  if (thresholds.acousticWatermark) {
    if (thresholds.acousticWatermark.specVersion !== 1) {
      throw new Error(
        "Invalid playback endurance configuration: " +
          "acousticWatermark.specVersion must equal 1.",
      );
    }
    for (const [name, value] of Object.entries(thresholds.acousticWatermark)) {
      if (name === "specVersion") continue;
      requireNonnegativeFinite(`acousticWatermark.${name}`, value, "configuration");
    }
  }
  requirePositiveFinite(
    "acousticPolicy.expectedToneFrequencyHz",
    thresholds.acousticPolicy.expectedToneFrequencyHz,
    "configuration",
  );
  requirePositiveFinite(
    "acousticPolicy.expectedWindowDurationMs",
    thresholds.acousticPolicy.expectedWindowDurationMs,
    "configuration",
  );
  requireNonnegativeFinite(
    "acousticPolicy.maximumAbsoluteRelativeClockDriftPpm",
    thresholds.acousticPolicy.maximumAbsoluteRelativeClockDriftPpm,
    "configuration",
  );
  requirePositiveSafeInteger(
    "acousticPolicy.relativeClockDriftRequiredAtOrAboveDurationMs",
    thresholds.acousticPolicy.relativeClockDriftRequiredAtOrAboveDurationMs,
    "configuration",
  );
  for (const [name, value] of Object.entries(thresholds.counterMaximumDeltas)) {
    requireNonemptyString("counter maximum name", name, "configuration");
    requireNonnegativeSafeInteger(`counterMaximumDeltas.${name}`, value, "configuration");
  }
  for (const [name, value] of Object.entries(thresholds.counterExpectedDeltas)) {
    requireNonemptyString("expected counter name", name, "configuration");
    requireNonnegativeSafeInteger(`counterExpectedDeltas.${name}`, value, "configuration");
  }
  requirePositiveFinite(
    "loadEvidence.minimumAppliedWorkUnits",
    thresholds.loadEvidence.minimumAppliedWorkUnits,
    "configuration",
  );
  requirePositiveFinite(
    "loadEvidence.minimumBackgroundCoreCpuPermille",
    thresholds.loadEvidence.minimumBackgroundCoreCpuPermille,
    "configuration",
  );
  requirePositiveFinite(
    "loadEvidence.minimumCpuTimeMs",
    thresholds.loadEvidence.minimumCpuTimeMs,
    "configuration",
  );
  requireFraction(
    "loadEvidence.minimumRequestedCpuFraction",
    thresholds.loadEvidence.minimumRequestedCpuFraction,
  );
  requireFraction(
    "loadEvidence.minimumRequestedWorkFraction",
    thresholds.loadEvidence.minimumRequestedWorkFraction,
  );
  requireNonnegativeSafeInteger(
    "loadEvidence.maximumAudioDeadlineMisses",
    thresholds.loadEvidence.maximumAudioDeadlineMisses,
    "configuration",
  );
  requireNonnegativeFinite(
    "loadEvidence.maximumAudioServiceLatencyMs",
    thresholds.loadEvidence.maximumAudioServiceLatencyMs,
    "configuration",
  );
  requirePositiveFinite(
    "loadEvidence.maximumAudioOwnerCoreCpuPermille",
    thresholds.loadEvidence.maximumAudioOwnerCoreCpuPermille,
    "configuration",
  );
  if (thresholds.loadEvidence.maximumAudioOwnerCoreCpuPermille > 1_000) {
    throw new Error(
      "Invalid playback endurance configuration: " +
        "loadEvidence.maximumAudioOwnerCoreCpuPermille must not exceed 1000.",
    );
  }
  requireNonnegativeFinite(
    "maximumRunDurationErrorMs",
    thresholds.maximumRunDurationErrorMs,
    "configuration",
  );
  validateMetricThresholds(thresholds);
  requirePositiveFinite(
    "metricsCadence.expectedIntervalMs",
    thresholds.metricsCadence.expectedIntervalMs,
    "configuration",
  );
  requirePositiveFinite(
    "metricsCadence.maximumIntervalMs",
    thresholds.metricsCadence.maximumIntervalMs,
    "configuration",
  );
  if (thresholds.metricsCadence.maximumIntervalMs < thresholds.metricsCadence.expectedIntervalMs) {
    throw new Error(
      "Invalid playback endurance configuration: maximum metrics interval " +
        "must be at least the expected interval.",
    );
  }
  requirePositiveSafeInteger("pcmFrameDurationMs", thresholds.pcmFrameDurationMs, "configuration");
}

export function assertPlaybackEnduranceInspection(
  device: PlaybackEnduranceDeviceIdentity,
  firmware: PlaybackEnduranceFirmwareIdentity,
) {
  requireNonemptyString("device family", device.family, "inspection");
  requireNonemptyString("stable device id", device.stableId, "inspection");
  if (firmware.algorithm !== "sha256" || !sha256Pattern.test(firmware.value)) {
    throw new Error(
      "Invalid playback endurance inspection: firmware must have a lowercase SHA-256 hash.",
    );
  }
}

/**
 * Makes "persistence-ready" a hard boundary invariant.
 *
 * JSON silently converts NaN and Infinity to null, while fractional cumulative
 * counters make exact frame conservation meaningless. Throwing here prevents
 * malformed adapter data from becoming a plausible-looking failed manifest.
 */
export function assertPlaybackEnduranceObservation(observation: PlaybackEnduranceRunObservation) {
  requireTimestamp("playbackStartedAtMonotonicMs", observation.playbackStartedAtMonotonicMs);
  requireTimestamp("playbackCompletedAtMonotonicMs", observation.playbackCompletedAtMonotonicMs);
  if (observation.playbackCompletedAtMonotonicMs < observation.playbackStartedAtMonotonicMs) {
    invalidObservation(
      "playbackCompletedAtMonotonicMs must not precede playbackStartedAtMonotonicMs",
    );
  }
  const startedAtMs = Date.parse(observation.startedAtIso);
  const completedAtMs = Date.parse(observation.completedAtIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    invalidObservation("startedAtIso and completedAtIso must be valid ISO timestamps");
  }
  if (completedAtMs < startedAtMs) {
    invalidObservation("completedAtIso must not precede startedAtIso");
  }

  validateCounterSnapshot("before", observation.countersBefore);
  validateCounterSnapshot("after", observation.countersAfter);
  validateArtifact(observation);
  validateAcousticAnalysis(observation);
  validateLoadEvidence(observation);
  for (const [index, sample] of observation.metricSamples.entries()) {
    requireTimestamp(`metricSamples[${index}].capturedAtMonotonicMs`, sample.capturedAtMonotonicMs);
    requireNonemptyString(
      `metricSamples[${index}].deviceBootId`,
      sample.deviceBootId,
      "observation",
    );
    requireTimestamp(
      `metricSamples[${index}].deviceProducedAtMonotonicMs`,
      sample.deviceProducedAtMonotonicMs,
    );
    requireNonnegativeSafeInteger(
      `metricSamples[${index}].deviceSequence`,
      sample.deviceSequence,
      "observation",
    );
    for (const [name, value] of Object.entries(sample.values)) {
      requireNonemptyString(`metricSamples[${index}] metric name`, name, "observation");
      if (typeof value === "number" && !Number.isFinite(value)) {
        invalidObservation(`metricSamples[${index}].values.${name} must be finite`);
      }
      if (typeof value === "string" && value.length === 0) {
        invalidObservation(`metricSamples[${index}].values.${name} must not be empty`);
      }
    }
  }
}

function validateMetricThresholds(thresholds: PlaybackEnduranceThresholds) {
  for (const [name, value] of Object.entries(thresholds.metricMaximumValues)) {
    requireNonemptyString("metric maximum name", name, "configuration");
    requireFinite(`metricMaximumValues.${name}`, value, "configuration");
  }
  for (const [name, value] of Object.entries(thresholds.metricMinimumValues)) {
    requireNonemptyString("metric minimum name", name, "configuration");
    requireFinite(`metricMinimumValues.${name}`, value, "configuration");
    const maximum = thresholds.metricMaximumValues[name];
    if (maximum !== undefined && value > maximum) {
      throw new Error(
        `Invalid playback endurance configuration: metric ${name} minimum ` +
          `${value} exceeds maximum ${maximum}.`,
      );
    }
  }
}

function validateCounterSnapshot(position: "after" | "before", counters: Record<string, number>) {
  for (const [name, value] of Object.entries(counters)) {
    requireNonemptyString(`counter ${position} name`, name, "observation");
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidObservation(`counter ${name} ${position} value must be a nonnegative safe integer`);
    }
  }
}

function validateArtifact(observation: PlaybackEnduranceRunObservation) {
  const artifact = observation.acoustic.artifact;
  requireNonnegativeSafeInteger("acoustic.artifact.byteLength", artifact.byteLength, "observation");
  if (artifact.byteLength % 2 !== 0) {
    invalidObservation("acoustic.artifact.byteLength must contain whole PCM16 samples");
  }
  requirePositiveSafeInteger(
    "acoustic.artifact.sampleRateHz",
    artifact.sampleRateHz,
    "observation",
  );
  requireNonemptyString("acoustic.artifact.path", artifact.path, "observation");
  if (artifact.format !== "pcm-s16le-mono") {
    invalidObservation("acoustic.artifact.format must be pcm-s16le-mono");
  }
  if (
    !sha256Pattern.test(artifact.sha256) ||
    !sha256Pattern.test(artifact.hashVerification.computedSha256)
  ) {
    invalidObservation("acoustic artifact hashes must be lowercase SHA-256 values");
  }
  if (typeof artifact.hashVerification.matched !== "boolean") {
    invalidObservation("acoustic artifact hash matched evidence must be boolean");
  }
  const relativeClockDriftPpm = observation.acoustic.relativeClockDriftPpm;
  if (relativeClockDriftPpm !== "unavailable" && !Number.isFinite(relativeClockDriftPpm)) {
    invalidObservation("acoustic.relativeClockDriftPpm must be finite or unavailable");
  }
}

function validateAcousticAnalysis(observation: PlaybackEnduranceRunObservation) {
  const analysis = observation.acoustic.analysis;
  /*
   * These are analyzer outputs, not arbitrary floating-point diagnostics.
   * Counts must remain exact JSON integers, while magnitudes and durations
   * cannot be negative. A merely finite check would let a broken adapter
   * report `gapCount: -1`, making degraded audio look better than perfect.
   */
  const counts = {
    activeWindowCount: analysis.activeWindowCount,
    gapCount: analysis.gapCount,
    phaseDiscontinuityCount: analysis.phaseDiscontinuityCount,
  };
  for (const [name, value] of Object.entries(counts)) {
    requireNonnegativeSafeInteger(`acoustic.analysis.${name}`, value, "observation");
  }
  requirePositiveSafeInteger(
    "acoustic.analysis.sampleRateHz",
    analysis.sampleRateHz,
    "observation",
  );

  const nonnegativeNumbers = {
    amplitudeCoefficientOfVariation: analysis.amplitudeCoefficientOfVariation,
    amplitudeStepP99Decibels: analysis.amplitudeStepP99Decibels,
    expectedDurationMs: analysis.expectedDurationMs,
    longestInternalGapMs: analysis.longestInternalGapMs,
    maximumAmplitudeStepDecibels: analysis.maximumAmplitudeStepDecibels,
    maximumPhaseStepErrorRadians: analysis.maximumPhaseStepErrorRadians,
    medianToneAmplitude: analysis.medianToneAmplitude,
    missingToneMs: analysis.missingToneMs,
    observedSpanMs: analysis.observedSpanMs,
    phaseDiscontinuityThresholdRadians: analysis.phaseDiscontinuityThresholdRadians,
    phaseStepSpanMs: analysis.phaseStepSpanMs,
    totalDurationMs: analysis.totalDurationMs,
  };
  for (const [name, value] of Object.entries(nonnegativeNumbers)) {
    requireNonnegativeFinite(`acoustic.analysis.${name}`, value, "observation");
  }
  for (const [name, value] of Object.entries({
    toneFrequencyHz: analysis.toneFrequencyHz,
    windowDurationMs: analysis.windowDurationMs,
    windowStepMs: analysis.windowStepMs,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      invalidObservation(`acoustic.analysis.${name} must be finite and positive`);
    }
  }
  requireFinite(
    "acoustic.analysis.medianPhaseStepRadians",
    analysis.medianPhaseStepRadians,
    "observation",
  );
  if (
    !Number.isFinite(analysis.toneWindowRatio) ||
    analysis.toneWindowRatio < 0 ||
    analysis.toneWindowRatio > 1
  ) {
    invalidObservation("acoustic.analysis.toneWindowRatio must be finite and between 0 and 1");
  }
  for (const [name, value] of [
    ["observedStartMs", analysis.observedStartMs],
    ["observedEndMs", analysis.observedEndMs],
  ]) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    ) {
      invalidObservation(`acoustic.analysis.${name} must be finite and nonnegative when present`);
    }
  }
  if (
    analysis.observedStartMs !== undefined &&
    analysis.observedEndMs !== undefined &&
    analysis.observedEndMs < analysis.observedStartMs
  ) {
    invalidObservation("acoustic.analysis.observedEndMs must not precede observedStartMs");
  }
}

function validateLoadEvidence(observation: PlaybackEnduranceRunObservation) {
  const evidence = observation.loadEvidence;
  requireNonnegativeSafeInteger(
    "loadEvidence.appliedWorkUnits",
    evidence.appliedWorkUnits,
    "observation",
  );
  requireNonnegativeSafeInteger(
    "loadEvidence.audioDeadlineMisses",
    evidence.audioDeadlineMisses,
    "observation",
  );
  requireNonnegativeFinite(
    "loadEvidence.audioOwnerCoreCpuPermille",
    evidence.audioOwnerCoreCpuPermille,
    "observation",
  );
  requireNonnegativeFinite(
    "loadEvidence.backgroundCoreCpuPermille",
    evidence.backgroundCoreCpuPermille,
    "observation",
  );
  if (evidence.audioOwnerCoreCpuPermille > 1_000) {
    invalidObservation("loadEvidence.audioOwnerCoreCpuPermille must not exceed 1000");
  }
  if (evidence.backgroundCoreCpuPermille > 1_000) {
    invalidObservation("loadEvidence.backgroundCoreCpuPermille must not exceed 1000");
  }
  requireNonnegativeFinite("loadEvidence.cpuTimeMs", evidence.cpuTimeMs, "observation");
  requireNonnegativeFinite(
    "loadEvidence.maximumAudioServiceLatencyMs",
    evidence.maximumAudioServiceLatencyMs,
    "observation",
  );
}

function requireTimestamp(name: string, value: number) {
  requireNonnegativeSafeInteger(name, value, "observation");
}

function requireFraction(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `Invalid playback endurance configuration: ${name} must be greater than 0 and at most 1.`,
    );
  }
}

function requireNonemptyString(
  name: string,
  value: string,
  source: "configuration" | "inspection" | "observation",
) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid playback endurance ${source}: ${name} must not be empty.`);
  }
}

function requireFinite(name: string, value: number, source: "configuration" | "observation") {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid playback endurance ${source}: ${name} must be finite.`);
  }
}

function requireNonnegativeFinite(
  name: string,
  value: number,
  source: "configuration" | "observation",
) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid playback endurance ${source}: ${name} must be finite and nonnegative.`,
    );
  }
}

function requirePositiveFinite(name: string, value: number, source: "configuration") {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid playback endurance ${source}: ${name} must be finite and positive.`);
  }
}

function requireNonnegativeSafeInteger(
  name: string,
  value: number,
  source: "configuration" | "observation",
) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid playback endurance ${source}: ${name} must be a nonnegative safe integer.`,
    );
  }
}

function requirePositiveSafeInteger(
  name: string,
  value: number,
  source: "configuration" | "observation",
) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Invalid playback endurance ${source}: ${name} must be a positive safe integer.`,
    );
  }
}

function invalidObservation(reason: string): never {
  throw new Error(`Invalid playback endurance observation: ${reason}.`);
}
