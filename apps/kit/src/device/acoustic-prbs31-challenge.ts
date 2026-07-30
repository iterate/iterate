import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const prbs31StateMask = 0x7fff_ffff;
const carrierCount = 2;
const defaultAnchorChipCount = 63;
const defaultMaximumClockDriftPpm = 1_000;
const defaultMaximumLeadingSilenceMs = 2_000;
const defaultMinimumAcquisitionCorrelation = 0.6;
const defaultMinimumCarrierAmplitude = 128;
const defaultMinimumSoftCorrelation = 0.8;
const physicalAnchorScoreTieTolerance = 1e-9;
const timelineAnchorIntervalChips = 1_000;
const timelineOffsetSearchChips = 64;
const softCorrelationHistogramBins = 2_001;
const defaultArtifactReadChunkBytes = 64 * 1_024;
const amplitudeEnvelopeBlockChips = 20;
const amplitudeEnvelopeWindowBlocks = 5;

export interface DualCarrierPrbs31Challenge {
  carrierAmplitude: number;
  carrierFrequenciesHz: readonly [1_000, 2_000];
  chipSamples: 16;
  frameChips: 20;
  kind: "dual-carrier-prbs31";
  runId: string;
  sampleRateHz: 16_000;
  seedCommitmentSha256: string;
  specVersion: 1;
}

export interface DualCarrierPrbs31Anchor {
  captureSampleIndex: number;
  carrier0Correlation: number;
  carrier1Correlation: number;
  carriersAgreed: boolean;
  expectedChipIndex: number;
  offsetChips: number;
}

export interface DualCarrierPrbs31Analysis {
  acquired: boolean;
  anchors: DualCarrierPrbs31Anchor[];
  carrierAgreement: boolean;
  confidentChipRatio: number;
  decodedSeedMatchesExpected: boolean;
  duplicatedChipCount: number;
  expectedDurationMs: number;
  expectedSeedCommitment: string;
  fittedClockDriftPpm: number;
  longestUncertainRunChips: number;
  maximumAdjacentAmplitudeStepDecibels: number;
  maximumAbsoluteTimelineOffsetChipsAfterBaseline: number;
  maximumShortTermAmplitudeRangeDecibels: number;
  minimumSoftCorrelationByCarrier: readonly [number, number];
  p01SoftCorrelationByCarrier: readonly [number, number];
  sampleRateHz: number;
  skippedChipCount: number;
  specVersion: 1;
  amplitudeEnvelopeBlockMs: 20;
  shortTermAmplitudeWindowMs: 100;
  timelineDiscontinuityCount: number;
}

export interface DualCarrierPrbs31ArtifactAnalysis extends DualCarrierPrbs31Analysis {
  artifactByteLength: number;
  artifactSha256: string;
  maximumBufferedAudioBytes: number;
}

export interface DualCarrierPrbs31Pcm16SourceIdentity {
  byteLength: number;
  maximumBufferedAudioBytes: number;
  sha256: string;
}

export interface DualCarrierPrbs31Assessment {
  passed: boolean;
  reasons: string[];
}

/**
 * Versioned release limits for the physical watermark oracle.
 *
 * These are data rather than hidden constants so every retained manifest says
 * which continuity contract produced its verdict. Thresholds describe only
 * tunable magnitudes; run identity, acquisition, and carrier agreement remain
 * mandatory properties of spec version 1 and cannot be disabled by callers.
 */
export interface DualCarrierPrbs31Thresholds {
  maximumAbsoluteClockDriftPpm: number;
  maximumAbsoluteTimelineOffsetChipsAfterBaseline: number;
  maximumAdjacentAmplitudeStepDecibels: number;
  maximumDuplicatedChipCount: number;
  maximumLongestUncertainRunChips: number;
  maximumShortTermAmplitudeRangeDecibels: number;
  maximumSkippedChipCount: number;
  maximumTimelineDiscontinuityCount: number;
  specVersion: 1;
}

export const dualCarrierPrbs31DefaultThresholds: Readonly<DualCarrierPrbs31Thresholds> =
  Object.freeze({
    maximumAbsoluteClockDriftPpm: 500,
    maximumAbsoluteTimelineOffsetChipsAfterBaseline: 0,
    maximumAdjacentAmplitudeStepDecibels: 2,
    maximumDuplicatedChipCount: 0,
    maximumLongestUncertainRunChips: 0,
    maximumShortTermAmplitudeRangeDecibels: 2,
    maximumSkippedChipCount: 0,
    maximumTimelineDiscontinuityCount: 0,
    specVersion: 1,
  });

interface ComplexProjection {
  amplitude: number;
  imaginary: number;
  real: number;
}

interface AnchorCorrelation {
  carrierCorrelations: [number, number];
  carrierPhases: readonly [
    { imaginary: number; real: number },
    { imaginary: number; real: number },
  ];
  minimumAmplitude: number;
  score: number;
  startSample: number;
}

interface Pcm16SampleSource {
  length: number;
  sampleAt(index: number): number;
}

/**
 * Constructs the versioned physical challenge retained in the run request.
 *
 * The PRBS seeds are deliberately derived, not transported as mutable runtime
 * knobs. A host adapter can therefore echo one compact commitment while the
 * acceptance core independently reconstructs both exact carrier sequences
 * from the run ID.
 */
export function createDualCarrierPrbs31Challenge(options: {
  runId: string;
}): DualCarrierPrbs31Challenge {
  if (!options.runId.trim()) {
    throw new Error("The acoustic PRBS31 challenge requires a non-empty run ID.");
  }
  const seeds = deriveCarrierSeeds(options.runId);
  const seedBytes = new Uint8Array(8);
  const seedView = new DataView(seedBytes.buffer);
  seedView.setUint32(0, seeds[0], true);
  seedView.setUint32(4, seeds[1], true);
  const seedCommitmentSha256 = createHash("sha256")
    .update("itx-kit-acoustic-prbs31/v1\0seed-commitment\0")
    .update(options.runId)
    .update("\0")
    .update(seedBytes)
    .digest("hex");
  return Object.freeze({
    carrierAmplitude: 9_175,
    carrierFrequenciesHz: Object.freeze([1_000, 2_000]) as readonly [1_000, 2_000],
    chipSamples: 16,
    frameChips: 20,
    kind: "dual-carrier-prbs31",
    runId: options.runId,
    sampleRateHz: 16_000,
    seedCommitmentSha256,
    specVersion: 1,
  });
}

/**
 * Renders a bounded fixture while preserving the stateful provider shape.
 *
 * Production streaming uses the same renderer a chunk at a time. This helper
 * intentionally accepts an odd chunk size so tests can prove that WebSocket
 * boundaries do not restart either LFSR.
 */
export function renderDualCarrierPrbs31Pcm16(options: {
  challenge: DualCarrierPrbs31Challenge;
  chunkSamples: number;
  durationMs: number;
}) {
  assertChallenge(options.challenge);
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0) {
    throw new Error("The PRBS31 render duration must be a positive whole millisecond.");
  }
  if (!Number.isSafeInteger(options.chunkSamples) || options.chunkSamples <= 0) {
    throw new Error("The PRBS31 renderer chunk must contain a positive number of samples.");
  }
  const sampleCount = options.durationMs * options.challenge.chipSamples;
  if (!Number.isSafeInteger(sampleCount) || sampleCount > 10_000_000) {
    throw new Error("The PRBS31 render must contain a bounded whole number of samples.");
  }
  const renderer = new DualCarrierPrbs31Renderer(options.challenge);
  const rendered = new Int16Array(sampleCount);
  for (let offset = 0; offset < rendered.length; offset += options.chunkSamples) {
    rendered.set(renderer.render(Math.min(options.chunkSamples, rendered.length - offset)), offset);
  }
  return rendered;
}

/**
 * Commits to the exact little-endian provider stream without retaining it.
 *
 * The acoustic capture can only implicate the device when the host can prove
 * what it offered to the PCM transport. A ten-minute source is 19.2 MB, so
 * generating the entire fixture merely to hash it would make the harness
 * unlike the bounded streaming path it is meant to judge. This walks the same
 * stateful renderer in fixed chunks and records the largest encoding buffer
 * the operation required.
 */
export function computeDualCarrierPrbs31Pcm16SourceIdentity(options: {
  challenge: DualCarrierPrbs31Challenge;
  durationMs: number;
}): DualCarrierPrbs31Pcm16SourceIdentity {
  assertChallenge(options.challenge);
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0) {
    throw new Error("The PRBS31 source duration must be a positive whole millisecond.");
  }
  const sampleCount = options.durationMs * options.challenge.chipSamples;
  if (!Number.isSafeInteger(sampleCount) || sampleCount > 10_000_000) {
    throw new Error("The PRBS31 source must contain a bounded whole number of samples.");
  }

  const renderer = new DualCarrierPrbs31Renderer(options.challenge);
  const hash = createHash("sha256");
  const maximumChunkSamples = Math.min(4_096, sampleCount);
  let byteLength = 0;
  let maximumBufferedAudioBytes = 0;
  for (let offset = 0; offset < sampleCount; offset += maximumChunkSamples) {
    const samples = renderer.render(Math.min(maximumChunkSamples, sampleCount - offset));
    const encoded = Buffer.allocUnsafe(samples.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      encoded.writeInt16LE(samples[index]!, index * Int16Array.BYTES_PER_ELEMENT);
    }
    hash.update(encoded);
    byteLength += encoded.byteLength;
    maximumBufferedAudioBytes = Math.max(maximumBufferedAudioBytes, encoded.byteLength);
  }
  return {
    byteLength,
    maximumBufferedAudioBytes,
    sha256: hash.digest("hex"),
  };
}

/**
 * Incremental four-shape renderer for the provider lane.
 *
 * Each one-millisecond carrier contains an integer number of cycles and is
 * therefore exactly zero at both chip edges. Sign changes encode identity
 * without creating a click, and precomputing the four possible signed sums
 * keeps the hot streaming loop free of trigonometry and allocation beyond the
 * caller-requested output chunk.
 */
export class DualCarrierPrbs31Renderer {
  readonly #chipShapes: readonly Int16Array[];
  readonly #states: [number, number];
  #sampleWithinChip = 0;

  constructor(challenge: DualCarrierPrbs31Challenge) {
    assertChallenge(challenge);
    this.#states = deriveCarrierSeeds(challenge.runId);
    this.#chipShapes = createChipShapes(challenge);
  }

  render(sampleCount: number) {
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
      throw new Error("The PRBS31 render chunk must contain a positive number of samples.");
    }
    const samples = new Int16Array(sampleCount);
    let outputOffset = 0;
    while (outputOffset < samples.length) {
      const signIndex =
        (prbs31Sign(this.#states[0]) > 0 ? 2 : 0) | (prbs31Sign(this.#states[1]) > 0 ? 1 : 0);
      const shape = this.#chipShapes[signIndex]!;
      const copied = Math.min(shape.length - this.#sampleWithinChip, samples.length - outputOffset);
      samples.set(
        shape.subarray(this.#sampleWithinChip, this.#sampleWithinChip + copied),
        outputOffset,
      );
      outputOffset += copied;
      this.#sampleWithinChip += copied;
      if (this.#sampleWithinChip === shape.length) {
        this.#sampleWithinChip = 0;
        this.#states[0] = advancePrbs31(this.#states[0]);
        this.#states[1] = advancePrbs31(this.#states[1]);
      }
    }
    return samples;
  }
}

/**
 * Acquires and judges the logical code embedded in a physical PCM capture.
 *
 * The detector fits exactly one affine device-to-capture clock from the start
 * and end anchors. It never continuously retimes the signal: doing so would
 * make a skipped frame look like harmless clock drift. Signed carrier
 * projections then judge every one-millisecond chip, while bounded one-second
 * anchors search logical offsets and expose timeline steps.
 */
export function analyzeDualCarrierPrbs31Pcm16(options: {
  challenge: DualCarrierPrbs31Challenge;
  expectedDurationMs: number;
  maximumLeadingSilenceMs?: number;
  sampleRateHz: number;
  samples: Int16Array;
}): DualCarrierPrbs31Analysis {
  if (!(options.samples instanceof Int16Array) || options.samples.length === 0) {
    throw new Error("The PRBS31 analyzer requires captured PCM16 samples.");
  }
  return analyzeDualCarrierPrbs31Source({
    ...options,
    samples: {
      length: options.samples.length,
      sampleAt(index) {
        return options.samples[index]!;
      },
    },
  });
}

/**
 * Recomputes evidence from one retained PCM descriptor with bounded storage.
 *
 * Neither an adapter-provided hash nor its analyzer JSON is accepted as an
 * input. The same open descriptor is hashed and sampled, and its identity,
 * length, and timestamps are checked again before returning. This makes the
 * artifact itself—not a claim about a path—the acceptance authority.
 */
export function analyzeDualCarrierPrbs31Pcm16Artifact(options: {
  artifactPath: string;
  challenge: DualCarrierPrbs31Challenge;
  expectedDurationMs: number;
  maximumLeadingSilenceMs?: number;
  readChunkBytes?: number;
  sampleRateHz: number;
}): DualCarrierPrbs31ArtifactAnalysis {
  if (!options.artifactPath.trim() || options.artifactPath.includes("\0")) {
    throw new Error("The PRBS31 artifact path must be non-empty.");
  }
  const readChunkBytes = options.readChunkBytes ?? defaultArtifactReadChunkBytes;
  if (!Number.isSafeInteger(readChunkBytes) || readChunkBytes <= 0 || readChunkBytes % 2 !== 0) {
    throw new Error("The PRBS31 artifact buffer must contain whole PCM16 samples.");
  }
  const descriptor = openSync(options.artifactPath, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error("The PRBS31 artifact must be a retained regular file.");
    }
    if (before.size === 0 || before.size % 2 !== 0) {
      throw new Error("The PRBS31 artifact must contain whole PCM16 samples.");
    }
    const readBuffer = Buffer.allocUnsafe(readChunkBytes);
    const hash = createHash("sha256");
    for (let position = 0; position < before.size; ) {
      const bytesRead = readSync(
        descriptor,
        readBuffer,
        0,
        Math.min(readBuffer.byteLength, before.size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("The PRBS31 artifact ended before its reported file size.");
      }
      hash.update(readBuffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const analysis = analyzeDualCarrierPrbs31Source({
      challenge: options.challenge,
      expectedDurationMs: options.expectedDurationMs,
      maximumLeadingSilenceMs: options.maximumLeadingSilenceMs,
      sampleRateHz: options.sampleRateHz,
      samples: new BufferedPcm16ArtifactSource({
        artifactBytes: before.size,
        descriptor,
        readBuffer,
      }),
    });
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("The PRBS31 artifact changed while it was being verified.");
    }
    return {
      ...analysis,
      artifactByteLength: before.size,
      artifactSha256: hash.digest("hex"),
      maximumBufferedAudioBytes: readBuffer.byteLength,
    };
  } finally {
    closeSync(descriptor);
  }
}

function analyzeDualCarrierPrbs31Source(options: {
  challenge: DualCarrierPrbs31Challenge;
  expectedDurationMs: number;
  maximumLeadingSilenceMs?: number;
  sampleRateHz: number;
  samples: Pcm16SampleSource;
}): DualCarrierPrbs31Analysis {
  assertChallenge(options.challenge);
  if (!Number.isSafeInteger(options.expectedDurationMs) || options.expectedDurationMs <= 0) {
    throw new Error("The PRBS31 expected duration must be a positive whole millisecond.");
  }
  if (
    !Number.isSafeInteger(options.sampleRateHz) ||
    options.sampleRateHz <= 0 ||
    options.sampleRateHz % 1_000 !== 0
  ) {
    throw new Error("The PRBS31 capture rate must contain a whole number of samples per chip.");
  }
  if (options.samples.length === 0) {
    throw new Error("The PRBS31 analyzer requires captured PCM16 samples.");
  }
  const expectedChipCount = options.expectedDurationMs;
  const anchorChipCount = Math.min(defaultAnchorChipCount, expectedChipCount);
  if (anchorChipCount < 31) {
    throw new Error("The PRBS31 capture must contain at least 31 one-millisecond chips.");
  }
  const nominalChipSamples = options.sampleRateHz / 1_000;
  const signs = createCarrierSigns(
    options.challenge.runId,
    expectedChipCount + 2 * timelineOffsetSearchChips,
  );
  const maximumLeadingSamples =
    ((options.maximumLeadingSilenceMs ?? defaultMaximumLeadingSilenceMs) * options.sampleRateHz) /
    1_000;
  const expectedCaptureSamples = expectedChipCount * nominalChipSamples;
  const excessSamples = Math.max(0, options.samples.length - expectedCaptureSamples);
  const startSearchEnd = Math.min(
    options.samples.length - anchorChipCount * nominalChipSamples,
    Math.max(
      nominalChipSamples * 100,
      Math.min(maximumLeadingSamples, excessSamples + nominalChipSamples * 100),
    ),
  );
  const startAnchor = findBestPhysicalAnchor({
    anchorChipCount,
    captureSearchEnd: Math.max(0, startSearchEnd),
    captureSearchStart: 0,
    chipSamples: nominalChipSamples,
    expectedChipIndex: 0,
    sampleRateHz: options.sampleRateHz,
    samples: options.samples,
    signs,
  });
  const endExpectedChipIndex = Math.max(0, expectedChipCount - anchorChipCount);
  const nominalEndStart = startAnchor.startSample + endExpectedChipIndex * nominalChipSamples;
  const driftSearchSamples = Math.ceil(
    (expectedCaptureSamples * defaultMaximumClockDriftPpm) / 1_000_000,
  );
  const endSearchRadius = Math.max(nominalChipSamples * 4, driftSearchSamples + excessSamples);
  const endAnchor = findBestPhysicalAnchor({
    anchorChipCount,
    captureSearchEnd: Math.min(
      options.samples.length - anchorChipCount * nominalChipSamples,
      nominalEndStart + endSearchRadius,
    ),
    captureSearchStart: Math.max(0, nominalEndStart - endSearchRadius),
    chipSamples: nominalChipSamples,
    expectedChipIndex: endExpectedChipIndex,
    sampleRateHz: options.sampleRateHz,
    samples: options.samples,
    signs,
  });
  const acquired =
    startAnchor.carrierCorrelations.every(
      (correlation) => correlation >= defaultMinimumAcquisitionCorrelation,
    ) &&
    endAnchor.carrierCorrelations.every(
      (correlation) => correlation >= defaultMinimumAcquisitionCorrelation,
    ) &&
    startAnchor.minimumAmplitude >= defaultMinimumCarrierAmplitude &&
    endAnchor.minimumAmplitude >= defaultMinimumCarrierAmplitude;
  const fittedChipSamples =
    endExpectedChipIndex === 0
      ? nominalChipSamples
      : (endAnchor.startSample - startAnchor.startSample) / endExpectedChipIndex;
  const fittedClockDriftPpm = (fittedChipSamples / nominalChipSamples - 1) * 1_000_000;
  const softHistograms = [
    new Uint32Array(softCorrelationHistogramBins),
    new Uint32Array(softCorrelationHistogramBins),
  ] as const;
  const minimumSoft: [number, number] = [1, 1];
  const amplitudeEnvelopeWindow = new Float64Array(amplitudeEnvelopeWindowBlocks);
  let amplitudeBlockEnergy = 0;
  let completedAmplitudeBlockCount = 0;
  let maximumAdjacentAmplitudeStepDecibels = 0;
  let maximumShortTermAmplitudeRangeDecibels = 0;
  let previousAmplitudeBlock: number | undefined;
  let confidentChipCount = 0;
  let longestUncertainRunChips = 0;
  let currentUncertainRunChips = 0;
  for (let chipIndex = 0; chipIndex < expectedChipCount; chipIndex += 1) {
    const captureStart = startAnchor.startSample + chipIndex * fittedChipSamples;
    const projections = projectBothCarriers(options.samples, captureStart, fittedChipSamples);
    let confident = acquired;
    for (let carrier = 0; carrier < carrierCount; carrier += 1) {
      const projection = projections[carrier]!;
      const phase = startAnchor.carrierPhases[carrier]!;
      const magnitude = Math.hypot(projection.real, projection.imaginary);
      amplitudeBlockEnergy += projection.amplitude ** 2;
      const signedCorrelation =
        magnitude === 0
          ? -1
          : signs[carrier]![chipIndex]! *
            ((projection.real * phase.real + projection.imaginary * phase.imaginary) / magnitude);
      minimumSoft[carrier] = Math.min(minimumSoft[carrier]!, signedCorrelation);
      softHistograms[carrier]![softCorrelationHistogramIndex(signedCorrelation)] += 1;
      if (
        projection.amplitude < defaultMinimumCarrierAmplitude ||
        signedCorrelation < defaultMinimumSoftCorrelation
      ) {
        confident = false;
      }
    }
    if (confident) {
      confidentChipCount += 1;
      currentUncertainRunChips = 0;
    } else {
      currentUncertainRunChips += 1;
      longestUncertainRunChips = Math.max(longestUncertainRunChips, currentUncertainRunChips);
    }
    const completedChipCount = chipIndex + 1;
    if (completedChipCount % amplitudeEnvelopeBlockChips === 0) {
      /*
       * Reflections convolve neighbouring PRBS signs and make individual chip
       * projections move even at constant speaker gain. RMS energy across
       * both independent carriers and a full 20 ms audio frame removes that
       * code-dependent motion while retaining the slower common-mode pumping
       * a listener perceives as jiggle.
       */
      const blockAmplitude = Math.sqrt(
        amplitudeBlockEnergy / (amplitudeEnvelopeBlockChips * carrierCount),
      );
      amplitudeBlockEnergy = 0;
      if (previousAmplitudeBlock !== undefined) {
        const lowerAmplitude = Math.min(previousAmplitudeBlock, blockAmplitude);
        const upperAmplitude = Math.max(previousAmplitudeBlock, blockAmplitude);
        const stepDecibels =
          lowerAmplitude <= 0
            ? /*
               * JSON serializes Infinity as null, which would corrupt the
               * retained numerical reason for a failed proof. MAX_VALUE is
               * still unambiguously above every valid threshold while remaining
               * finite and round-trippable in the manifest.
               */
              Number.MAX_VALUE
            : 20 * Math.log10(upperAmplitude / lowerAmplitude);
        maximumAdjacentAmplitudeStepDecibels = Math.max(
          maximumAdjacentAmplitudeStepDecibels,
          stepDecibels,
        );
      }
      previousAmplitudeBlock = blockAmplitude;
      amplitudeEnvelopeWindow[completedAmplitudeBlockCount % amplitudeEnvelopeWindowBlocks] =
        blockAmplitude;
      completedAmplitudeBlockCount += 1;
      if (completedAmplitudeBlockCount >= amplitudeEnvelopeWindowBlocks) {
        let minimumAmplitude = Number.POSITIVE_INFINITY;
        let maximumAmplitude = 0;
        for (const amplitude of amplitudeEnvelopeWindow) {
          minimumAmplitude = Math.min(minimumAmplitude, amplitude);
          maximumAmplitude = Math.max(maximumAmplitude, amplitude);
        }
        const rangeDecibels =
          minimumAmplitude <= 0
            ? Number.MAX_VALUE
            : 20 * Math.log10(maximumAmplitude / minimumAmplitude);
        maximumShortTermAmplitudeRangeDecibels = Math.max(
          maximumShortTermAmplitudeRangeDecibels,
          rangeDecibels,
        );
      }
    }
  }

  const timelineAnchors = collectTimelineAnchors({
    anchorChipCount,
    expectedChipCount,
    fittedChipSamples,
    sampleRateHz: options.sampleRateHz,
    samples: options.samples,
    signs,
    startSample: startAnchor.startSample,
  });
  let carrierAgreement = acquired;
  let timelineDiscontinuityCount = 0;
  let duplicatedChipCount = 0;
  let skippedChipCount = 0;
  let maximumAbsoluteTimelineOffsetChipsAfterBaseline = 0;
  const baselineOffset = timelineAnchors[0]?.offsetChips ?? 0;
  let previousOffset = baselineOffset;
  for (const anchor of timelineAnchors) {
    carrierAgreement &&=
      anchor.carriersAgreed &&
      anchor.carrier0Correlation >= defaultMinimumAcquisitionCorrelation &&
      anchor.carrier1Correlation >= defaultMinimumAcquisitionCorrelation;
    const offsetAfterBaseline = anchor.offsetChips - baselineOffset;
    maximumAbsoluteTimelineOffsetChipsAfterBaseline = Math.max(
      maximumAbsoluteTimelineOffsetChipsAfterBaseline,
      Math.abs(offsetAfterBaseline),
    );
    const delta = anchor.offsetChips - previousOffset;
    if (delta !== 0) {
      timelineDiscontinuityCount += 1;
      if (delta > 0) skippedChipCount += delta;
      else duplicatedChipCount += -delta;
    }
    previousOffset = anchor.offsetChips;
  }
  const p01Soft = [
    histogramPercentile(softHistograms[0], 0.01),
    histogramPercentile(softHistograms[1], 0.01),
  ] as const;
  const confidentChipRatio = confidentChipCount / expectedChipCount;
  const decodedSeedMatchesExpected =
    acquired &&
    confidentChipCount === expectedChipCount &&
    timelineDiscontinuityCount === 0 &&
    maximumAbsoluteTimelineOffsetChipsAfterBaseline === 0;

  return {
    acquired,
    anchors: timelineAnchors,
    carrierAgreement,
    confidentChipRatio,
    decodedSeedMatchesExpected,
    duplicatedChipCount,
    expectedDurationMs: options.expectedDurationMs,
    expectedSeedCommitment: options.challenge.seedCommitmentSha256,
    fittedClockDriftPpm,
    longestUncertainRunChips,
    maximumAdjacentAmplitudeStepDecibels,
    maximumAbsoluteTimelineOffsetChipsAfterBaseline,
    maximumShortTermAmplitudeRangeDecibels,
    minimumSoftCorrelationByCarrier: minimumSoft,
    p01SoftCorrelationByCarrier: p01Soft,
    sampleRateHz: options.sampleRateHz,
    skippedChipCount,
    specVersion: 1,
    amplitudeEnvelopeBlockMs: 20,
    shortTermAmplitudeWindowMs: 100,
    timelineDiscontinuityCount,
  };
}

export function assessDualCarrierPrbs31Analysis(
  analysis: DualCarrierPrbs31Analysis,
  thresholds: Readonly<DualCarrierPrbs31Thresholds> = dualCarrierPrbs31DefaultThresholds,
): DualCarrierPrbs31Assessment {
  assertDualCarrierPrbs31Thresholds(thresholds);
  const reasons: string[] = [];
  if (!analysis.acquired) reasons.push("the run-keyed acoustic code was not acquired");
  if (!analysis.decodedSeedMatchesExpected) {
    reasons.push("the decoded acoustic code did not match the expected run seed");
  }
  if (!analysis.carrierAgreement) {
    reasons.push("the two acoustic watermark carriers did not agree");
  }
  if (
    !Number.isFinite(analysis.fittedClockDriftPpm) ||
    Math.abs(analysis.fittedClockDriftPpm) > thresholds.maximumAbsoluteClockDriftPpm
  ) {
    reasons.push(
      `the acoustic capture clock drift ${analysis.fittedClockDriftPpm}ppm exceeds ` +
        `${thresholds.maximumAbsoluteClockDriftPpm}ppm`,
    );
  }
  if (analysis.longestUncertainRunChips > thresholds.maximumLongestUncertainRunChips) {
    reasons.push(
      `the acoustic watermark contained ${analysis.longestUncertainRunChips}ms ` +
        `of consecutive uncertain chips, exceeding ` +
        `${thresholds.maximumLongestUncertainRunChips}ms`,
    );
  }
  if (
    !Number.isFinite(analysis.maximumAdjacentAmplitudeStepDecibels) ||
    analysis.maximumAdjacentAmplitudeStepDecibels > thresholds.maximumAdjacentAmplitudeStepDecibels
  ) {
    reasons.push(
      `the acoustic amplitude envelope stepped ` +
        `${analysis.maximumAdjacentAmplitudeStepDecibels}dB between ` +
        `${analysis.amplitudeEnvelopeBlockMs}ms blocks, exceeding ` +
        `${thresholds.maximumAdjacentAmplitudeStepDecibels}dB`,
    );
  }
  if (
    !Number.isFinite(analysis.maximumShortTermAmplitudeRangeDecibels) ||
    analysis.maximumShortTermAmplitudeRangeDecibels >
      thresholds.maximumShortTermAmplitudeRangeDecibels
  ) {
    reasons.push(
      `the acoustic amplitude envelope varied ` +
        `${analysis.maximumShortTermAmplitudeRangeDecibels}dB within ` +
        `${analysis.shortTermAmplitudeWindowMs}ms, exceeding ` +
        `${thresholds.maximumShortTermAmplitudeRangeDecibels}dB`,
    );
  }
  if (analysis.timelineDiscontinuityCount > thresholds.maximumTimelineDiscontinuityCount) {
    reasons.push(
      `the acoustic watermark timeline changed offset ` +
        `${analysis.timelineDiscontinuityCount} times, exceeding ` +
        `${thresholds.maximumTimelineDiscontinuityCount}`,
    );
  }
  if (analysis.duplicatedChipCount > thresholds.maximumDuplicatedChipCount) {
    reasons.push(
      `the acoustic watermark duplicated ${analysis.duplicatedChipCount} chips, exceeding ` +
        `${thresholds.maximumDuplicatedChipCount}`,
    );
  }
  if (analysis.skippedChipCount > thresholds.maximumSkippedChipCount) {
    reasons.push(
      `the acoustic watermark skipped ${analysis.skippedChipCount} chips, exceeding ` +
        `${thresholds.maximumSkippedChipCount}`,
    );
  }
  if (
    analysis.maximumAbsoluteTimelineOffsetChipsAfterBaseline >
    thresholds.maximumAbsoluteTimelineOffsetChipsAfterBaseline
  ) {
    reasons.push(
      `the acoustic watermark reached a logical offset of ` +
        `${analysis.maximumAbsoluteTimelineOffsetChipsAfterBaseline} chips, exceeding ` +
        `${thresholds.maximumAbsoluteTimelineOffsetChipsAfterBaseline}`,
    );
  }
  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function assertDualCarrierPrbs31Thresholds(thresholds: Readonly<DualCarrierPrbs31Thresholds>) {
  if (thresholds.specVersion !== 1) {
    throw new Error("The acoustic PRBS31 threshold spec version must be 1.");
  }
  for (const [name, value] of Object.entries(thresholds)) {
    if (name === "specVersion") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`The acoustic PRBS31 threshold ${name} must be nonnegative and finite.`);
    }
  }
}

function collectTimelineAnchors(options: {
  anchorChipCount: number;
  expectedChipCount: number;
  fittedChipSamples: number;
  sampleRateHz: number;
  samples: Pcm16SampleSource;
  signs: readonly [Int8Array, Int8Array];
  startSample: number;
}) {
  const expectedIndices: number[] = [];
  for (
    let expectedChipIndex = 0;
    expectedChipIndex + options.anchorChipCount <= options.expectedChipCount;
    expectedChipIndex += timelineAnchorIntervalChips
  ) {
    expectedIndices.push(expectedChipIndex);
  }
  const finalIndex = options.expectedChipCount - options.anchorChipCount;
  if (expectedIndices.at(-1) !== finalIndex) expectedIndices.push(finalIndex);
  const anchors: DualCarrierPrbs31Anchor[] = [];
  for (const expectedChipIndex of expectedIndices) {
    const captureStart = options.startSample + expectedChipIndex * options.fittedChipSamples;
    const projections: [ComplexProjection[], ComplexProjection[]] = [[], []];
    for (let chipOffset = 0; chipOffset < options.anchorChipCount; chipOffset += 1) {
      const projected = projectBothCarriers(
        options.samples,
        captureStart + chipOffset * options.fittedChipSamples,
        options.fittedChipSamples,
      );
      projections[0].push(projected[0]);
      projections[1].push(projected[1]);
    }
    const bestByCarrier = [0, 1].map((carrier) =>
      findBestLogicalOffset({
        anchorChipCount: options.anchorChipCount,
        carrier,
        expectedChipIndex,
        projections: projections[carrier as 0 | 1],
        signs: options.signs[carrier as 0 | 1],
      }),
    );
    const agreed = bestByCarrier[0]!.offset === bestByCarrier[1]!.offset;
    const offset = agreed
      ? bestByCarrier[0]!.offset
      : Math.abs(bestByCarrier[0]!.correlation) >= Math.abs(bestByCarrier[1]!.correlation)
        ? bestByCarrier[0]!.offset
        : bestByCarrier[1]!.offset;
    anchors.push({
      captureSampleIndex: Math.round(captureStart),
      carrier0Correlation: bestByCarrier[0]!.correlation,
      carrier1Correlation: bestByCarrier[1]!.correlation,
      carriersAgreed: agreed,
      expectedChipIndex,
      /*
       * A disagreement is made observable through carrierAgreement. Retaining
       * the stronger carrier's offset keeps the raw anchor useful for
       * diagnosis without treating noise as a healthy consensus.
       */
      offsetChips: offset,
    });
  }
  return anchors;
}

function findBestLogicalOffset(options: {
  anchorChipCount: number;
  carrier: number;
  expectedChipIndex: number;
  projections: ComplexProjection[];
  signs: Int8Array;
}) {
  let best = { correlation: Number.NEGATIVE_INFINITY, offset: 0 };
  const minimumOffset = Math.max(-timelineOffsetSearchChips, -options.expectedChipIndex);
  const maximumOffset = Math.min(
    timelineOffsetSearchChips,
    options.signs.length - options.expectedChipIndex - options.anchorChipCount,
  );
  const magnitudeTotal = options.projections.reduce(
    (total, projection) => total + Math.hypot(projection.real, projection.imaginary),
    0,
  );
  for (let offset = minimumOffset; offset <= maximumOffset; offset += 1) {
    let real = 0;
    let imaginary = 0;
    for (let chip = 0; chip < options.anchorChipCount; chip += 1) {
      const sign = options.signs[options.expectedChipIndex + offset + chip]!;
      const projection = options.projections[chip]!;
      real += sign * projection.real;
      imaginary += sign * projection.imaginary;
    }
    const correlation = magnitudeTotal === 0 ? 0 : Math.hypot(real, imaginary) / magnitudeTotal;
    if (correlation > best.correlation) best = { correlation, offset };
  }
  return best;
}

function findBestPhysicalAnchor(options: {
  anchorChipCount: number;
  captureSearchEnd: number;
  captureSearchStart: number;
  chipSamples: number;
  expectedChipIndex: number;
  sampleRateHz: number;
  samples: Pcm16SampleSource;
  signs: readonly [Int8Array, Int8Array];
}) {
  const maximumStart =
    options.samples.length - Math.ceil(options.anchorChipCount * options.chipSamples);
  const searchStart = Math.max(0, Math.min(maximumStart, Math.floor(options.captureSearchStart)));
  const searchEnd = Math.max(
    searchStart,
    Math.min(maximumStart, Math.ceil(options.captureSearchEnd)),
  );
  const coarseStep = Math.max(1, Math.round(options.chipSamples));
  let best = correlatePhysicalAnchor(options, searchStart);
  for (let candidate = searchStart + coarseStep; candidate <= searchEnd; candidate += coarseStep) {
    const correlated = correlatePhysicalAnchor(options, candidate);
    if (correlated.score > best.score + physicalAnchorScoreTieTolerance) best = correlated;
  }
  /*
   * A bounded capture commonly ends on the final challenge sample. The coarse
   * grid is anchored at the lower search bound, so it does not necessarily
   * land on that upper boundary. Sampling the boundary explicitly prevents a
   * weaker interior PRBS correlation from winning merely because the exact
   * final anchor was never considered.
   */
  const searchEndCorrelation = correlatePhysicalAnchor(options, searchEnd);
  if (searchEndCorrelation.score > best.score + physicalAnchorScoreTieTolerance) {
    best = searchEndCorrelation;
  }
  const fineStart = Math.max(searchStart, Math.floor(best.startSample - coarseStep));
  const fineEnd = Math.min(searchEnd, Math.ceil(best.startSample + coarseStep));
  for (let candidate = fineStart; candidate <= fineEnd; candidate += 1) {
    const correlated = correlatePhysicalAnchor(options, candidate);
    /*
     * A one-sample shift of an integer-cycle chip merely rotates carrier
     * phase when the shared boundary sample is zero. Prefer the earliest
     * physically equivalent candidate: inventing a later start would force
     * the global clock fit to manufacture drift at an exact capture edge.
     */
    if (correlated.score > best.score + physicalAnchorScoreTieTolerance) {
      best = correlated;
    }
  }
  return best;
}

function correlatePhysicalAnchor(
  options: {
    anchorChipCount: number;
    chipSamples: number;
    expectedChipIndex: number;
    samples: Pcm16SampleSource;
    signs: readonly [Int8Array, Int8Array];
  },
  startSample: number,
): AnchorCorrelation {
  const sums = [
    { imaginary: 0, magnitude: 0, real: 0 },
    { imaginary: 0, magnitude: 0, real: 0 },
  ];
  for (let chipOffset = 0; chipOffset < options.anchorChipCount; chipOffset += 1) {
    const projections = projectBothCarriers(
      options.samples,
      startSample + chipOffset * options.chipSamples,
      options.chipSamples,
    );
    for (let carrier = 0; carrier < carrierCount; carrier += 1) {
      const sign = options.signs[carrier]![options.expectedChipIndex + chipOffset]!;
      const projection = projections[carrier]!;
      sums[carrier]!.real += sign * projection.real;
      sums[carrier]!.imaginary += sign * projection.imaginary;
      sums[carrier]!.magnitude += Math.hypot(projection.real, projection.imaginary);
    }
  }
  const correlations = sums.map((sum) =>
    sum.magnitude === 0 ? 0 : Math.hypot(sum.real, sum.imaginary) / sum.magnitude,
  ) as [number, number];
  const phases = sums.map((sum) => {
    const magnitude = Math.hypot(sum.real, sum.imaginary);
    return magnitude === 0
      ? { imaginary: 0, real: 1 }
      : { imaginary: sum.imaginary / magnitude, real: sum.real / magnitude };
  }) as [{ imaginary: number; real: number }, { imaginary: number; real: number }];
  const amplitudes = sums.map(
    (sum) => (2 * sum.magnitude) / options.anchorChipCount / options.chipSamples,
  );
  const minimumAmplitude = Math.min(...amplitudes);
  return {
    carrierCorrelations: correlations,
    carrierPhases: phases,
    minimumAmplitude,
    score:
      Math.min(...correlations) * Math.min(1, minimumAmplitude / defaultMinimumCarrierAmplitude),
    startSample,
  };
}

function projectBothCarriers(
  samples: Pcm16SampleSource,
  startSample: number,
  chipSamples: number,
): [ComplexProjection, ComplexProjection] {
  return [
    projectCarrier(samples, startSample, chipSamples, 1),
    projectCarrier(samples, startSample, chipSamples, 2),
  ];
}

function projectCarrier(
  samples: Pcm16SampleSource,
  startSample: number,
  chipSamples: number,
  cyclesPerChip: number,
): ComplexProjection {
  const firstSample = Math.max(0, Math.round(startSample));
  const lastSample = Math.min(samples.length, Math.round(startSample + chipSamples));
  const sampleCount = lastSample - firstSample;
  if (sampleCount <= 0) return { amplitude: 0, imaginary: 0, real: 0 };
  let real = 0;
  let imaginary = 0;
  for (let sampleIndex = firstSample; sampleIndex < lastSample; sampleIndex += 1) {
    const phase = (2 * Math.PI * cyclesPerChip * (sampleIndex - startSample)) / chipSamples;
    const sample = samples.sampleAt(sampleIndex);
    real += sample * Math.sin(phase);
    imaginary += sample * Math.cos(phase);
  }
  return {
    amplitude: (2 * Math.hypot(real, imaginary)) / sampleCount,
    imaginary,
    real,
  };
}

function createChipShapes(challenge: DualCarrierPrbs31Challenge) {
  const shapes: Int16Array[] = [];
  for (const carrier0Sign of [-1, 1]) {
    for (const carrier1Sign of [-1, 1]) {
      const shape = new Int16Array(challenge.chipSamples);
      for (let sample = 0; sample < challenge.chipSamples; sample += 1) {
        shape[sample] = Math.round(
          challenge.carrierAmplitude *
            (carrier0Sign * Math.sin((2 * Math.PI * sample) / challenge.chipSamples) +
              carrier1Sign * Math.sin((4 * Math.PI * sample) / challenge.chipSamples)),
        );
      }
      shapes.push(shape);
    }
  }
  return shapes;
}

function createCarrierSigns(runId: string, chipCount: number) {
  const states = deriveCarrierSeeds(runId);
  const signs = [new Int8Array(chipCount), new Int8Array(chipCount)] as const;
  for (let chip = 0; chip < chipCount; chip += 1) {
    for (let carrier = 0; carrier < carrierCount; carrier += 1) {
      signs[carrier]![chip] = prbs31Sign(states[carrier]!);
      states[carrier] = advancePrbs31(states[carrier]!);
    }
  }
  return signs;
}

function deriveCarrierSeeds(runId: string): [number, number] {
  return [0, 1].map((carrier) => {
    const digest = createHash("sha256")
      .update(`itx-kit-acoustic-prbs31/v1\0${runId}\0carrier-${carrier}`)
      .digest();
    const seed = digest.readUInt32LE(0) & prbs31StateMask;
    return seed === 0 ? 1 : seed;
  }) as [number, number];
}

function prbs31Sign(state: number) {
  return (state >>> 30) & 1 ? 1 : -1;
}

function advancePrbs31(state: number) {
  const feedback = ((state >>> 30) ^ (state >>> 27)) & 1;
  return ((state << 1) & prbs31StateMask) | feedback;
}

function softCorrelationHistogramIndex(value: number) {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(((clamped + 1) / 2) * (softCorrelationHistogramBins - 1));
}

function histogramPercentile(histogram: Uint32Array, fraction: number) {
  const count = histogram.reduce((total, bin) => total + bin, 0);
  if (count === 0) return -1;
  const rank = Math.max(1, Math.ceil(count * fraction));
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index]!;
    if (cumulative >= rank) {
      return (index / (histogram.length - 1)) * 2 - 1;
    }
  }
  return 1;
}

class BufferedPcm16ArtifactSource implements Pcm16SampleSource {
  readonly length: number;
  readonly #artifactBytes: number;
  readonly #descriptor: number;
  readonly #readBuffer: Buffer;
  #bufferByteLength = 0;
  #bufferStartByte = -1;

  constructor(options: { artifactBytes: number; descriptor: number; readBuffer: Buffer }) {
    this.#artifactBytes = options.artifactBytes;
    this.#descriptor = options.descriptor;
    this.#readBuffer = options.readBuffer;
    this.length = options.artifactBytes / Int16Array.BYTES_PER_ELEMENT;
  }

  sampleAt(index: number) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`The PRBS31 analyzer requested invalid sample ${index}.`);
    }
    const byteOffset = index * Int16Array.BYTES_PER_ELEMENT;
    if (
      byteOffset < this.#bufferStartByte ||
      byteOffset + Int16Array.BYTES_PER_ELEMENT > this.#bufferStartByte + this.#bufferByteLength
    ) {
      /*
       * Aligning refills to the fixed buffer boundary makes monotonically
       * increasing chip reads amortize to one positional read per 64 KiB,
       * while start/end anchor searches may safely revisit earlier regions
       * without allocating another cache.
       */
      this.#bufferStartByte =
        Math.floor(byteOffset / this.#readBuffer.byteLength) * this.#readBuffer.byteLength;
      const requestedBytes = Math.min(
        this.#readBuffer.byteLength,
        this.#artifactBytes - this.#bufferStartByte,
      );
      this.#bufferByteLength = 0;
      /*
       * POSIX permits a regular-file positional read to return fewer bytes
       * than requested without reaching EOF. Hashing already loops, and the
       * sample cache must do the same; otherwise bytes left by an earlier
       * refill in allocUnsafe storage could be mistaken for captured audio.
       */
      while (this.#bufferByteLength < requestedBytes) {
        const bytesRead = readSync(
          this.#descriptor,
          this.#readBuffer,
          this.#bufferByteLength,
          requestedBytes - this.#bufferByteLength,
          this.#bufferStartByte + this.#bufferByteLength,
        );
        if (bytesRead <= 0) {
          throw new Error("The PRBS31 artifact ended during bounded sample access.");
        }
        this.#bufferByteLength += bytesRead;
      }
    }
    return this.#readBuffer.readInt16LE(byteOffset - this.#bufferStartByte);
  }
}

function assertChallenge(challenge: DualCarrierPrbs31Challenge) {
  if (
    challenge.kind !== "dual-carrier-prbs31" ||
    challenge.specVersion !== 1 ||
    challenge.sampleRateHz !== 16_000 ||
    challenge.chipSamples !== 16 ||
    challenge.frameChips !== 20 ||
    challenge.carrierAmplitude !== 9_175 ||
    challenge.carrierFrequenciesHz[0] !== 1_000 ||
    challenge.carrierFrequenciesHz[1] !== 2_000 ||
    !challenge.runId?.trim() ||
    !/^[0-9a-f]{64}$/.test(challenge.seedCommitmentSha256)
  ) {
    throw new Error("The acoustic PRBS31 challenge does not match version 1.");
  }
  const expected = createDualCarrierPrbs31Challenge({ runId: challenge.runId });
  if (expected.seedCommitmentSha256 !== challenge.seedCommitmentSha256) {
    throw new Error("The acoustic PRBS31 seed commitment does not match its run ID.");
  }
}
