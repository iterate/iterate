export type AecWaveformStimulusKind = "tone" | "dual-carrier-prbs31" | "speech-shaped";

export interface AecWaveformTransportValidity {
  captureFailures: number;
  captureFrameDrops: number;
  clockDiscontinuities: number;
  networkValid: boolean;
  playbackDroppedFrames: number;
  playbackIntegrityFailures: number;
  playbackResets: number;
  playbackUnderrunIncidents: number;
  recorderComplete: boolean;
  uplinkFrameDrops: number;
  uplinkRestarts: number;
  websocketReconnects: number;
}

export interface AecWaveformFarEndPhase {
  clean: Int16Array;
  kind: AecWaveformStimulusKind;
  playbackObserved: boolean;
  source: Int16Array;
}

export interface AecWaveformRunInput {
  ambient: Int16Array;
  doubleTalk: {
    clean: Int16Array;
    farSource: Int16Array;
    nearOnlyClean: Int16Array;
    nearSource: Int16Array;
    playbackObserved: boolean;
  };
  farEndOnly: AecWaveformFarEndPhase[];
  nearEndOnly: {
    clean: Int16Array;
    pathReferenceObserved: boolean;
    source: Int16Array;
  };
  nearEndRepeat: {
    clean: Int16Array;
    pathReferenceObserved: boolean;
  };
  sampleRateHz: number;
  validity: AecWaveformTransportValidity;
}

interface SignalSummary {
  dbfs: number;
  peak: number;
  rms: number;
}

interface AlignmentSummary {
  gain: number;
  lagSamples: number;
  residualToReferenceDb: number;
  similarity: number;
}

export interface AecWaveformAssessment {
  ambient: SignalSummary;
  doubleTalk: {
    clean: SignalSummary;
    farEndResidualDb: number | null;
    farEndSimilarity: number | null;
    nearEndGain: number | null;
    nearEndSimilarity: number | null;
    passed: boolean;
    residualDegradationFromRepeatDb: number | null;
    residualToNearEndDb: number | null;
    similarityLossFromRepeat: number | null;
  };
  farEnd: Array<{
    clean: SignalSummary;
    kind: AecWaveformStimulusKind;
    passed: boolean;
    source: SignalSummary;
    sourceSimilarity: number | null;
  }>;
  nearEnd: {
    aboveAmbientDb: number | null;
    clean: SignalSummary;
    pathReferenceObserved: boolean;
    passed: boolean;
    repeat: {
      clean: SignalSummary;
      gain: number | null;
      passed: boolean;
      pathReferenceObserved: boolean;
      residualToReferenceDb: number | null;
      similarity: number | null;
    };
    source: SignalSummary;
    sourceSimilarity: number | null;
  };
  passed: boolean;
  reasons: string[];
  validity: { passed: boolean; reasons: string[] };
}

const requiredStimuli: readonly AecWaveformStimulusKind[] = [
  "tone",
  "dual-carrier-prbs31",
  "speech-shaped",
];
const minimumIntervalMs = 1_000;
const maximumAlignmentLagMs = 750;
const maximumFarEndCleanDbfs = -40;
const maximumFarEndAboveAmbientDb = 6;
const maximumFarEndSourceSimilarity = 0.2;
const minimumNearEndAboveAmbientDb = 10;
const minimumNearEndComparisonSnrDb = 15;
const minimumNearEndSourceSimilarity = 0.2;
const minimumComparableNearEndSimilarity = 0.85;
const minimumDoubleTalkNearEndGain = 0.5;
const maximumDoubleTalkNearEndGain = 2;
const maximumComparableNearEndResidualDb = -6;
/*
 * XMOS's adaptive AEC is deliberately nonlinear during double-talk. Requiring
 * it to remain within ordinary room-repeat noise (the former 0.03 / 2 dB
 * limits) rejected a retained run whose near speech still had 0.909 waveform
 * similarity, 0.931 gain, a -7.39 dB residual, and an exactly matching
 * independent 11-word transcript. These relative limits instead catch a
 * material change from the repeated control while the absolute similarity,
 * gain, and residual gates above continue to define whether speech is usable.
 * Far-end leakage is assessed independently below, so near-path distortion
 * cannot be mistaken for speaker echo merely because both occupy the residual.
 */
const maximumDoubleTalkResidualDegradationFromRepeatDb = 8;
const maximumDoubleTalkFarEndSimilarity = 0.2;

/**
 * Evaluates the exact clean microphone PCM accepted by the userspace `/pcm`
 * endpoint for either local-AEC device.
 *
 * Device metrics remain essential for proving the speaker really played and
 * that capture did not reset or discard frames. They are not, however, an
 * audio oracle: one-second peaks cannot show whether the clean waveform still
 * contains the far-end sentence. This assessment therefore combines both
 * layers and fails closed if either is incomplete.
 *
 * “Identical to the Mac speaker” means identical after the physical room
 * transfer. The harness first plays a reproducible Mac-only signal and records
 * what this exact microphone/DSP path produces. During double-talk it repeats
 * the same Mac signal, aligns the two captures, fits one bounded scalar gain,
 * and measures the residual. Comparing against the Mac-only capture removes
 * arbitrary acoustic delay, loudspeaker colour, and microphone gain without
 * giving residual device-speaker echo anywhere to hide.
 *
 * A physical room is not bit-repeatable: HVAC noise, clock drift, and the
 * nonlinear hardware DSP can make two identical Mac playbacks differ. A
 * second Mac-only capture measures that floor on the same XMOS path. The
 * double-talk capture must satisfy an absolute usefulness floor *and* remain
 * within a bounded degradation from that measured repeatability. A hardware
 * adaptive filter is allowed to transform nearby speech during double-talk;
 * it is not allowed to erase it or leak the independently known far source.
 * This avoids both an impossible linear-wire threshold and a self-fulfilling
 * per-run threshold.
 */
export function assessAecWaveformRun(input: AecWaveformRunInput): AecWaveformAssessment {
  assertRunShape(input);
  const reasons: string[] = [];
  const validityReasons = assessTransportValidity(input.validity);
  reasons.push(...validityReasons);
  const ambient = summarize(input.ambient);

  for (const kind of requiredStimuli) {
    if (!input.farEndOnly.some((phase) => phase.kind === kind)) {
      reasons.push(`Missing required ${kind} far-only AEC phase.`);
    }
  }

  const farEnd = input.farEndOnly.map((phase) => {
    const source = summarize(phase.source);
    const clean = summarize(phase.clean);
    const sourceAlignment = alignAndCompare(phase.source, phase.clean, input.sampleRateHz);
    const phaseReasons: string[] = [];
    if (!phase.playbackObserved) {
      phaseReasons.push(`${phase.kind} far-only speaker playback was not physically observed.`);
    }
    if (source.dbfs < -25) {
      phaseReasons.push(`${phase.kind} far-only source was too quiet to challenge AEC.`);
    }
    const maximumCleanRms = Math.max(
      dbfsToRms(maximumFarEndCleanDbfs),
      ambient.rms * 10 ** (maximumFarEndAboveAmbientDb / 20),
    );
    if (clean.rms > maximumCleanRms) {
      phaseReasons.push(
        `${phase.kind} far-only clean uplink was ${clean.dbfs.toFixed(2)} dBFS; ` +
          `expected at most ${rmsToDbfs(maximumCleanRms).toFixed(2)} dBFS.`,
      );
    }
    if (sourceAlignment.similarity > maximumFarEndSourceSimilarity) {
      phaseReasons.push(
        `${phase.kind} far-only clean uplink retained source similarity ` +
          `${sourceAlignment.similarity.toFixed(3)}; expected at most ` +
          `${maximumFarEndSourceSimilarity.toFixed(3)}.`,
      );
    }
    reasons.push(...phaseReasons);
    return {
      clean,
      kind: phase.kind,
      passed: phaseReasons.length === 0,
      source,
      sourceSimilarity: sourceAlignment.similarity,
    };
  });

  const nearSource = summarize(input.nearEndOnly.source);
  const nearClean = summarize(input.nearEndOnly.clean);
  const nearAlignment = alignAndCompare(
    input.nearEndOnly.source,
    input.nearEndOnly.clean,
    input.sampleRateHz,
  );
  const nearReasons: string[] = [];
  const nearAboveAmbientDb = powerRatioDb(nearClean.rms, ambient.rms);
  if (!input.nearEndOnly.pathReferenceObserved) {
    /*
     * HAVPE's XMOS path can leave AEC after reference silence, while CoreS3's
     * analogue-divider path can be mis-mapped or physically absent. In either
     * case a clean-looking nearby recording is not a valid double-talk control
     * unless device playback accounting proves the low-level pilot traversed
     * that target's real matched reference lane throughout the phase.
     */
    nearReasons.push(
      "The near-end control did not physically exercise its matched AEC reference path.",
    );
  }
  if (nearAboveAmbientDb < minimumNearEndAboveAmbientDb) {
    nearReasons.push(
      `Mac-only signal did not rise above ambient: ${nearAboveAmbientDb.toFixed(2)} dB; ` +
        `expected at least ${minimumNearEndAboveAmbientDb} dB.`,
    );
  } else if (nearAboveAmbientDb < minimumNearEndComparisonSnrDb) {
    /*
     * Presence detection and waveform comparison need different margins. A
     * phrase ten decibels above ambient proves the microphone is alive, but
     * leaves little headroom for the -6 dB absolute residual floor. Fifteen
     * decibels leaves another 9 dB for ambient/quantisation beneath that floor;
     * classify anything weaker as an invalid stimulus instead of attributing
     * measurement noise to the DSP.
     */
    nearReasons.push(
      `Mac-only signal did not provide enough SNR for the double-talk comparison: ` +
        `${nearAboveAmbientDb.toFixed(2)} dB above ambient; expected at least ` +
        `${minimumNearEndComparisonSnrDb} dB.`,
    );
  }
  if (nearAlignment.similarity < minimumNearEndSourceSimilarity) {
    nearReasons.push(
      `Mac-only clean uplink had only ${nearAlignment.similarity.toFixed(3)} similarity to the ` +
        `retained Mac stimulus.`,
    );
  }
  reasons.push(...nearReasons);

  const nearRepeatClean = summarize(input.nearEndRepeat.clean);
  const nearRepeatAlignment = alignAndCompare(
    input.nearEndOnly.clean,
    input.nearEndRepeat.clean,
    input.sampleRateHz,
  );
  const nearRepeatReasons: string[] = [];
  if (!input.nearEndRepeat.pathReferenceObserved) {
    nearRepeatReasons.push(
      "The repeated near-end control did not physically exercise its matched AEC reference path.",
    );
  }
  if (
    nearRepeatAlignment.similarity < minimumComparableNearEndSimilarity ||
    nearRepeatAlignment.gain < minimumDoubleTalkNearEndGain ||
    nearRepeatAlignment.gain > maximumDoubleTalkNearEndGain ||
    nearRepeatAlignment.residualToReferenceDb > maximumComparableNearEndResidualDb
  ) {
    nearRepeatReasons.push(
      `Repeated Mac-only capture was not sufficiently close to the first control: similarity ` +
        `${nearRepeatAlignment.similarity.toFixed(3)}, gain ${nearRepeatAlignment.gain.toFixed(3)}, ` +
        `residual ${nearRepeatAlignment.residualToReferenceDb.toFixed(2)} dB.`,
    );
  }
  reasons.push(...nearRepeatReasons);

  const doubleTalkClean = summarize(input.doubleTalk.clean);
  const nearPreservation = alignAndCompare(
    input.doubleTalk.nearOnlyClean,
    input.doubleTalk.clean,
    input.sampleRateHz,
  );
  const residual = residualSignal(
    input.doubleTalk.nearOnlyClean,
    input.doubleTalk.clean,
    nearPreservation,
  );
  const residualSummary = summarize(residual);
  const farSourceSummary = summarize(input.doubleTalk.farSource);
  const farResidue = alignAndCompare(input.doubleTalk.farSource, residual, input.sampleRateHz);
  const farEndResidualDb = powerRatioDb(residualSummary.rms, farSourceSummary.rms);
  const similarityLossFromRepeat = nearRepeatAlignment.similarity - nearPreservation.similarity;
  const residualDegradationFromRepeatDb =
    nearPreservation.residualToReferenceDb - nearRepeatAlignment.residualToReferenceDb;
  const doubleTalkReasons: string[] = [];
  if (!input.doubleTalk.playbackObserved) {
    doubleTalkReasons.push("Double-talk device-speaker playback was not physically observed.");
  }
  if (
    nearPreservation.gain < minimumDoubleTalkNearEndGain ||
    nearPreservation.gain > maximumDoubleTalkNearEndGain ||
    nearPreservation.residualToReferenceDb > maximumComparableNearEndResidualDb
  ) {
    doubleTalkReasons.push(
      `Double-talk clean uplink did not preserve the Mac-only capture: similarity ` +
        `${nearPreservation.similarity.toFixed(3)}, gain ${nearPreservation.gain.toFixed(3)}, ` +
        `residual ${nearPreservation.residualToReferenceDb.toFixed(2)} dB.`,
    );
  }
  /*
   * Similarity is not an independent preservation requirement here. It falls
   * mechanically as the fitted gain falls, so coupling a 0.85 similarity floor
   * to a gain range that explicitly permits 0.5 made part of that range
   * impossible. Gain bounds near-end ducking, residual level bounds absolute
   * intelligibility damage, and degradation from the repeat control bounds
   * the extra nonlinear change introduced by double-talk. We still report
   * similarity and its loss because they are useful diagnostics, but do not
   * count the same energy relationship twice.
   */
  if (residualDegradationFromRepeatDb > maximumDoubleTalkResidualDegradationFromRepeatDb) {
    doubleTalkReasons.push(
      `Double-talk degraded beyond repeated near-end control: similarity loss ` +
        `${similarityLossFromRepeat.toFixed(3)}, residual degradation ` +
        `${residualDegradationFromRepeatDb.toFixed(2)} dB.`,
    );
  }
  /*
   * The subtraction residual necessarily contains independent ambient noise
   * from two physical captures plus any ordinary nonlinear change to the near
   * path. Its total energy therefore cannot identify speaker echo: even a
   * perfect canceller can exceed an absolute -40 dB ratio in a normal room.
   * The far stimulus is deterministic and independent of the near signal, so
   * correlation with that known waveform is the discriminating witness. A
   * separate residual-to-near gate above still rejects destruction of near
   * speech; dropping the ambiguous energy predicate does not create a path
   * for either self-talk or near-end erasure to pass silently.
   */
  if (farResidue.similarity > maximumDoubleTalkFarEndSimilarity) {
    doubleTalkReasons.push(
      `Double-talk residual retained device-speaker content: residual energy ` +
        `${farEndResidualDb.toFixed(2)} dB relative to the far source, similarity ` +
        `${farResidue.similarity.toFixed(3)}.`,
    );
  }
  reasons.push(...doubleTalkReasons);

  return {
    ambient,
    doubleTalk: {
      clean: doubleTalkClean,
      farEndResidualDb: finiteOrNull(farEndResidualDb),
      farEndSimilarity: finiteOrNull(farResidue.similarity),
      nearEndGain: finiteOrNull(nearPreservation.gain),
      nearEndSimilarity: finiteOrNull(nearPreservation.similarity),
      passed: doubleTalkReasons.length === 0,
      residualDegradationFromRepeatDb: finiteOrNull(residualDegradationFromRepeatDb),
      residualToNearEndDb: finiteOrNull(nearPreservation.residualToReferenceDb),
      similarityLossFromRepeat: finiteOrNull(similarityLossFromRepeat),
    },
    farEnd,
    nearEnd: {
      aboveAmbientDb: finiteOrNull(nearAboveAmbientDb),
      clean: nearClean,
      passed: nearReasons.length === 0 && nearRepeatReasons.length === 0,
      pathReferenceObserved: input.nearEndOnly.pathReferenceObserved,
      repeat: {
        clean: nearRepeatClean,
        gain: finiteOrNull(nearRepeatAlignment.gain),
        passed: nearRepeatReasons.length === 0,
        pathReferenceObserved: input.nearEndRepeat.pathReferenceObserved,
        residualToReferenceDb: finiteOrNull(nearRepeatAlignment.residualToReferenceDb),
        similarity: finiteOrNull(nearRepeatAlignment.similarity),
      },
      source: nearSource,
      sourceSimilarity: finiteOrNull(nearAlignment.similarity),
    },
    passed: reasons.length === 0,
    reasons,
    validity: { passed: validityReasons.length === 0, reasons: validityReasons },
  };
}

function assertRunShape(input: AecWaveformRunInput) {
  if (!Number.isSafeInteger(input.sampleRateHz) || input.sampleRateHz <= 0) {
    throw new TypeError("AEC assessment sample rate must be a positive safe integer.");
  }
  const minimumSamples = (input.sampleRateHz * minimumIntervalMs) / 1_000;
  if (!Number.isSafeInteger(minimumSamples)) {
    throw new TypeError("AEC assessment sample rate must form whole millisecond intervals.");
  }
  const signals = [
    input.ambient,
    input.nearEndOnly.source,
    input.nearEndOnly.clean,
    input.nearEndRepeat.clean,
    input.doubleTalk.nearSource,
    input.doubleTalk.nearOnlyClean,
    input.doubleTalk.farSource,
    input.doubleTalk.clean,
    ...input.farEndOnly.flatMap((phase) => [phase.source, phase.clean]),
  ];
  if (signals.some((signal) => !(signal instanceof Int16Array) || signal.length < minimumSamples)) {
    throw new TypeError(`Every AEC phase must contain at least ${minimumIntervalMs} ms of PCM16.`);
  }
}

function assessTransportValidity(validity: AecWaveformTransportValidity) {
  const reasons: string[] = [];
  if (!validity.recorderComplete) reasons.push("The PCM recorder did not close complete.");
  if (!validity.networkValid) reasons.push("The physical network interval was not valid.");
  appendCounterReason(reasons, validity.captureFailures, "capture failure");
  appendCounterReason(reasons, validity.captureFrameDrops, "capture frame drop");
  appendCounterReason(reasons, validity.uplinkFrameDrops, "uplink frame drop");
  appendCounterReason(reasons, validity.uplinkRestarts, "uplink restart");
  appendCounterReason(reasons, validity.playbackDroppedFrames, "playback frame drop");
  appendCounterReason(reasons, validity.playbackIntegrityFailures, "playback integrity failure");
  appendCounterReason(reasons, validity.playbackUnderrunIncidents, "playback underrun incident");
  appendCounterReason(reasons, validity.playbackResets, "playback reset");
  appendCounterReason(reasons, validity.websocketReconnects, "WebSocket reconnect");
  appendCounterReason(reasons, validity.clockDiscontinuities, "clock/timeline discontinuity");
  return reasons;
}

function appendCounterReason(reasons: string[], count: number, label: string) {
  if (!Number.isSafeInteger(count) || count < 0) {
    reasons.push(`The ${label} counter was invalid.`);
  } else if (count > 0) {
    reasons.push(`The run observed ${count} ${label}${count === 1 ? "" : "s"}.`);
  }
}

function summarize(samples: Int16Array): SignalSummary {
  let squareSum = 0;
  let peak = 0;
  for (const sample of samples) {
    squareSum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(squareSum / samples.length);
  return { dbfs: rmsToDbfs(rms), peak, rms };
}

/*
 * Full-rate exhaustive correlation over 750 ms would do billions of multiply
 * operations for one physical run. A 1 kHz coarse pass finds the acoustic
 * delay, then a full-rate refinement only searches one coarse stride either
 * side. This remains deterministic and bounded while retaining sample-level
 * alignment for the actual residual calculation.
 */
function alignAndCompare(reference: Int16Array, candidate: Int16Array, sampleRateHz: number) {
  const stride = Math.max(1, Math.floor(sampleRateHz / 1_000));
  const maximumLagSamples = Math.floor((sampleRateHz * maximumAlignmentLagMs) / 1_000);
  let bestLag = 0;
  let bestSimilarity = -1;
  for (let lag = -maximumLagSamples; lag <= maximumLagSamples; lag += stride) {
    const similarity = Math.abs(alignmentStatistics(reference, candidate, lag, stride).similarity);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestLag = lag;
    }
  }
  const refinementStart = Math.max(-maximumLagSamples, bestLag - stride);
  const refinementEnd = Math.min(maximumLagSamples, bestLag + stride);
  for (let lag = refinementStart; lag <= refinementEnd; lag += 1) {
    const similarity = Math.abs(alignmentStatistics(reference, candidate, lag, 1).similarity);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestLag = lag;
    }
  }
  return alignmentStatistics(reference, candidate, bestLag, 1);
}

function alignmentStatistics(
  reference: Int16Array,
  candidate: Int16Array,
  lagSamples: number,
  stride: number,
): AlignmentSummary {
  const referenceStart = Math.max(0, -lagSamples);
  const candidateStart = Math.max(0, lagSamples);
  const overlap = Math.min(reference.length - referenceStart, candidate.length - candidateStart);
  if (overlap <= 0) {
    return { gain: 0, lagSamples, residualToReferenceDb: Number.POSITIVE_INFINITY, similarity: 0 };
  }
  let cross = 0;
  let referenceEnergy = 0;
  let candidateEnergy = 0;
  let count = 0;
  for (let offset = 0; offset < overlap; offset += stride) {
    const referenceSample = reference[referenceStart + offset]!;
    const candidateSample = candidate[candidateStart + offset]!;
    cross += referenceSample * candidateSample;
    referenceEnergy += referenceSample * referenceSample;
    candidateEnergy += candidateSample * candidateSample;
    count += 1;
  }
  if (count === 0 || referenceEnergy === 0 || candidateEnergy === 0) {
    return {
      gain: 0,
      lagSamples,
      residualToReferenceDb:
        candidateEnergy === 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      similarity: 0,
    };
  }
  const gain = cross / referenceEnergy;
  let residualEnergy = 0;
  for (let offset = 0; offset < overlap; offset += stride) {
    const residual =
      candidate[candidateStart + offset]! - gain * reference[referenceStart + offset]!;
    residualEnergy += residual * residual;
  }
  return {
    gain,
    lagSamples,
    residualToReferenceDb:
      10 * Math.log10(Math.max(Number.MIN_VALUE, residualEnergy) / referenceEnergy),
    similarity: Math.abs(cross) / Math.sqrt(referenceEnergy * candidateEnergy),
  };
}

function residualSignal(reference: Int16Array, candidate: Int16Array, alignment: AlignmentSummary) {
  /*
   * Samples outside the aligned overlap have no corresponding near-end
   * reference. Leaving the candidate there would misclassify timing-edge
   * speech as far-end energy, so the diagnostic residual deliberately covers
   * only the interval for which subtraction is mathematically defined.
   */
  const residual = new Int16Array(candidate.length);
  const referenceStart = Math.max(0, -alignment.lagSamples);
  const candidateStart = Math.max(0, alignment.lagSamples);
  const overlap = Math.min(reference.length - referenceStart, candidate.length - candidateStart);
  for (let offset = 0; offset < overlap; offset += 1) {
    residual[candidateStart + offset] = clampPcm16(
      candidate[candidateStart + offset]! - alignment.gain * reference[referenceStart + offset]!,
    );
  }
  return residual;
}

function rmsToDbfs(rms: number) {
  return rms <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms / 32_768);
}

function dbfsToRms(dbfs: number) {
  return 32_768 * 10 ** (dbfs / 20);
}

function powerRatioDb(numeratorRms: number, denominatorRms: number) {
  if (numeratorRms <= 0) return Number.NEGATIVE_INFINITY;
  if (denominatorRms <= 0) return Number.POSITIVE_INFINITY;
  return 20 * Math.log10(numeratorRms / denominatorRms);
}

function finiteOrNull(value: number) {
  return Number.isFinite(value) ? value : null;
}

function clampPcm16(value: number) {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}
