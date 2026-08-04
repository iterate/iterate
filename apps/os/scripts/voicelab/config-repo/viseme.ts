/**
 * Acoustic viseme classification for assistant reply PCM: a TypeScript port of
 * the HeadAudio audio front-end and Gaussian-prototype classifier, plus a
 * change-track builder that turns per-hop classifications into sparse discrete
 * viseme events a device can play out alongside the paced reply audio.
 *
 * Algorithm, constants, and the trained model come from met4citizen/HeadAudio
 * (MIT, Copyright (c) 2025 Mika Suominen) — full license text in
 * HEAD_AUDIO_LICENSE.txt next to this file. Cross-checked against the
 * stackchan C port (face_viseme.c), which established float32 parity with the
 * upstream JavaScript Processor to 1e-4 and contributed the margin-based
 * confidence and the VAD/vote smoothing discipline.
 *
 * Pipeline, per 16 kHz mono s16le sample: pre-emphasis (alpha 0.97) → 32-tap
 * Hamming-windowed sinc FIR (upstream's polyphase phase 0 — at a 1:1 rate the
 * downsampler always selects phase 0) → 512-sample ring. Every 256-sample hop
 * (the first once 512 samples arrived): Hamming window → radix-2 FFT → power
 * spectrum / N → 40 speaker-warped mel bands → log10 → DCT-II rows 1-12 →
 * lifter (L=22) → tanh squash → Mahalanobis distance against 39 Gaussian
 * prototypes, silence prototypes 1.2x more sensitive, margin-based confidence
 * from the best-to-second-best distance gap.
 *
 * Deterministic throughout; the per-sample hot path allocates nothing. This
 * module is bundled into a dynamic worker whose module graph is closed, so it
 * must only import from its own directory.
 */
import { visemeModelBytes } from "./viseme-model.generated.ts";

/**
 * The firmware viseme id space, mirroring the device enum in
 * apps/kit/firmware/components/avatar/include/iterate/kit/avatar/face_pose.h
 * (FACE_VISEME_AA … FACE_VISEME_SIL). These ids are also the model's own
 * viseme indices (byte 7 of each prototype record), so no remapping happens
 * anywhere in this module. FACE_VISEME_NONE (255) never goes on the wire.
 */
export const firmwareVisemes = {
  AA: 0,
  E: 1,
  I: 2,
  O: 3,
  U: 4,
  PP: 5,
  SS: 6,
  TH: 7,
  DD: 8,
  FF: 9,
  KK: 10,
  NN: 11,
  RR: 12,
  CH: 13,
  SIL: 14,
} as const;

/** A firmware viseme id (0-14; 14 = silence). */
export type FirmwareVisemeId = (typeof firmwareVisemes)[keyof typeof firmwareVisemes];

/** Sample rate the classifier (and the model) is defined at. */
export const visemeSampleRateHz = 16000;

/** Samples per classification hop: one classification every 16 ms. */
export const visemeHopSamples = 256;

/** Number of MFCC features per vector (and per prototype mean). */
export const visemeFeatureCount = 12;

/** Byte length of one Gaussian prototype record in the model binary. */
export const visemeModelRecordBytes = 368;

const visemeCount = 15;
const fftSamples = 512;
const melBands = 40;
const preemphasisAlpha = 0.97;
const firTaps = 32;
const lifterParameter = 22;
const pcmScale = 1 / 32768;
// Upstream divides silence-prototype distances by silSensitivity=1.2 so quiet,
// ambiguous frames prefer silence over hallucinated speech shapes.
const silenceSensitivity = 1.2;

/** One parsed Gaussian prototype from the HeadAudio model binary. */
export interface VisemePrototype {
  /** IPA phoneme label decoded from the record's big-endian codepoint pair. */
  phoneme: string;
  /** Firmware viseme id this prototype votes for. */
  viseme: FirmwareVisemeId;
  /** Twelve feature means. */
  mean: Float32Array;
  /** Seventy-eight packed lower-triangular inverse covariance values. */
  inverseCovarianceLower: Float32Array;
}

/**
 * Parses and validates a HeadAudio model binary (368-byte records: bytes 0-3 a
 * big-endian IPA codepoint pair, byte 7 the viseme id, bytes 8-55 twelve
 * little-endian float32 means, bytes 56-367 seventy-eight float32 packed
 * lower-triangular inverse covariance values), mirroring the C firmware's
 * face_viseme_model_valid checks.
 */
export function parseVisemeModel(bytes: Uint8Array): VisemePrototype[] {
  if (bytes.byteLength === 0 || bytes.byteLength % visemeModelRecordBytes !== 0) {
    throw new Error(
      `A viseme model must be a non-empty multiple of ${visemeModelRecordBytes} bytes, got ${bytes.byteLength}.`,
    );
  }
  const recordCount = bytes.byteLength / visemeModelRecordBytes;
  if (recordCount > 255) {
    throw new Error(`A viseme model holds at most 255 prototypes, got ${recordCount}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const covarianceFloats = (visemeFeatureCount * (visemeFeatureCount + 1)) / 2;
  const prototypes: VisemePrototype[] = [];
  for (let record = 0; record < recordCount; record += 1) {
    const offset = record * visemeModelRecordBytes;
    const packedPhoneme = view.getUint32(offset, false);
    const firstCodepoint = packedPhoneme >>> 16;
    const secondCodepoint = packedPhoneme & 0xffff;
    const viseme = bytes[offset + 7];
    if (viseme >= visemeCount) {
      throw new Error(`Prototype ${record} has out-of-range viseme id ${viseme}.`);
    }
    const mean = new Float32Array(visemeFeatureCount);
    for (let index = 0; index < visemeFeatureCount; index += 1) {
      mean[index] = view.getFloat32(offset + 8 + 4 * index, true);
      if (!Number.isFinite(mean[index])) {
        throw new Error(`Prototype ${record} has a non-finite mean value.`);
      }
    }
    const inverseCovarianceLower = new Float32Array(covarianceFloats);
    for (let index = 0; index < covarianceFloats; index += 1) {
      inverseCovarianceLower[index] = view.getFloat32(offset + 56 + 4 * index, true);
      if (!Number.isFinite(inverseCovarianceLower[index])) {
        throw new Error(`Prototype ${record} has a non-finite inverse covariance value.`);
      }
    }
    prototypes.push({
      phoneme:
        String.fromCodePoint(firstCodepoint) +
        (secondCodepoint === 0 ? "" : String.fromCodePoint(secondCodepoint)),
      viseme: viseme as FirmwareVisemeId,
      mean,
      inverseCovarianceLower,
    });
  }
  return prototypes;
}

/** Hamming window over the FFT block (upstream MFCC._buildWindowHamming). */
function buildHammingWindow(): Float32Array {
  const window = new Float32Array(fftSamples);
  for (let index = 0; index < fftSamples; index += 1) {
    window[index] = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (fftSamples - 1));
  }
  return window;
}

/**
 * Anti-aliasing FIR: upstream designPolyphaseFilter's phase 0 — a 32-tap
 * Hamming-windowed sinc at 0.45 of Nyquist. At native 16 kHz the polyphase
 * accumulator lands on phase 0 for every sample, so the whole downsampler
 * reduces to this one filter.
 */
function buildFirTaps(): Float32Array {
  const taps = new Float32Array(firTaps);
  const mid = (firTaps - 1) / 2;
  const cutoff = 0.45;
  for (let index = 0; index < firTaps; index += 1) {
    const x = index - mid; // never 0 for an even tap count
    taps[index] = Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    taps[index] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (firTaps - 1));
  }
  return taps;
}

/** Interleaved cos/sin twiddle table for the radix-2 FFT (upstream MFCC._buildCosSin). */
function buildFftCosSin(): Float32Array {
  const table = new Float32Array(2 * fftSamples);
  const theta = (-2 * Math.PI) / fftSamples;
  for (let index = 0; index < fftSamples; index += 1) {
    table[2 * index] = Math.cos(theta * index);
    table[2 * index + 1] = Math.sin(theta * index);
  }
  return table;
}

/** Bit-reversal permutation for the 512-point FFT (upstream MFCC._buildBitrev). */
function buildFftBitrev(): Uint16Array {
  const bitrev = new Uint16Array(fftSamples);
  const bits = Math.log2(fftSamples);
  for (let index = 0; index < fftSamples; index += 1) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      reversed = (reversed << 1) | ((index >> bit) & 1);
    }
    bitrev[index] = reversed;
  }
  return bitrev;
}

/**
 * DCT-II rows 1-12 (c0 is skipped), flattened row-major (upstream
 * MFCC._buildDCTMatrix rows [1..12]).
 */
function buildDctMatrix(): Float32Array {
  const matrix = new Float32Array(visemeFeatureCount * melBands);
  const scale = Math.sqrt(2 / melBands);
  for (let coefficient = 0; coefficient < visemeFeatureCount; coefficient += 1) {
    for (let band = 0; band < melBands; band += 1) {
      matrix[coefficient * melBands + band] =
        scale * Math.cos((Math.PI * (coefficient + 1) * (band + 0.5)) / melBands);
    }
  }
  return matrix;
}

/** Cepstral lifter weights, c0 skipped (upstream MFCC._buildLifter, L=22). */
function buildLifterWeights(): Float32Array {
  const weights = new Float32Array(visemeFeatureCount);
  for (let index = 1; index <= visemeFeatureCount; index += 1) {
    weights[index - 1] = 1 + (lifterParameter / 2) * Math.sin((Math.PI * index) / lifterParameter);
  }
  return weights;
}

const hammingWindow = buildHammingWindow();
const lowpassFirTaps = buildFirTaps();
const fftCosSin = buildFftCosSin();
const fftBitrev = buildFftBitrev();
const dctMatrix = buildDctMatrix();
const lifterWeights = buildLifterWeights();

/**
 * Triangular mel filter bank edges as FFT bin indices, warped for the
 * speaker's mean fundamental frequency (upstream MFCC._buildMelFilterbank; 30
 * Hz to 7800 Hz, warp clamped to [0.6, 1.8] around the 150 Hz reference).
 * Edges are clamped below Nyquist as in the C port so a warp above 1 cannot
 * index past the power spectrum.
 */
function buildMelBinEdges(speakerMeanHz: number): Uint16Array {
  const warp = Math.min(Math.max(speakerMeanHz / 150, 0.6), 1.8);
  const melLow = 2595 * Math.log10(1 + 30 / 700);
  const melHigh = 2595 * Math.log10(1 + 7800 / 700);
  const edges = new Uint16Array(melBands + 2);
  for (let index = 0; index < melBands + 2; index += 1) {
    const mel = melLow + ((melHigh - melLow) / (melBands + 1)) * index;
    const warped = melLow + (mel - melLow) * warp;
    // fround matches upstream, which stores the mel points in a Float32Array
    // before converting them to bins.
    const frequency = Math.fround(700 * (Math.pow(10, warped / 2595) - 1));
    const bin = Math.floor((frequency / visemeSampleRateHz) * fftSamples);
    edges[index] = Math.min(bin, fftSamples / 2 - 1);
  }
  return edges;
}

/**
 * Streaming front-end state (pre-emphasis memory, FIR ring, FFT sample ring)
 * plus scratch buffers reused across hops so classification allocates
 * nothing. Shared by the classifier and the test-facing single-block feature
 * extractor so both run byte-for-byte the same pipeline.
 */
interface FrontEndState {
  preemphasisPrevious: number;
  firRing: Float32Array;
  firWrite: number;
  sampleRing: Float32Array;
  sampleWrite: number;
  /** Interleaved complex spectrum; the low 256 floats are reused for the power spectrum. */
  spectrum: Float32Array;
  melEnergies: Float32Array;
  features: Float32Array;
  difference: Float32Array;
}

function createFrontEndState(): FrontEndState {
  return {
    preemphasisPrevious: 0,
    firRing: new Float32Array(firTaps),
    firWrite: 0,
    sampleRing: new Float32Array(fftSamples),
    sampleWrite: 0,
    spectrum: new Float32Array(2 * fftSamples),
    melEnergies: new Float32Array(melBands),
    features: new Float32Array(visemeFeatureCount),
    difference: new Float32Array(visemeFeatureCount),
  };
}

/** Runs one s16le sample through pre-emphasis and the FIR into the sample ring. */
function pushSampleThroughFrontEnd(state: FrontEndState, sample: number): void {
  const original = sample * pcmScale;
  const emphasised = original - preemphasisAlpha * state.preemphasisPrevious;
  state.preemphasisPrevious = original;
  const { firRing } = state;
  firRing[state.firWrite] = emphasised;
  state.firWrite = (state.firWrite + 1) % firTaps;
  let filtered = 0;
  for (let tap = 0; tap < firTaps; tap += 1) {
    filtered += firRing[(state.firWrite + tap) % firTaps] * lowpassFirTaps[tap];
  }
  state.sampleRing[state.sampleWrite] = filtered;
  state.sampleWrite = (state.sampleWrite + 1) & (fftSamples - 1);
}

/**
 * Extracts the 12-feature vector (tanh-squashed liftered MFCCs) from the
 * current 512-sample ring into state.features.
 */
function extractFeatureVector(state: FrontEndState, melBinEdges: Uint16Array): void {
  const { spectrum, sampleRing, sampleWrite } = state;

  // Load the ring oldest-first, bit-reversed, with the Hamming window applied.
  for (let index = 0; index < fftSamples; index += 1) {
    const destination = fftBitrev[index];
    spectrum[2 * destination] =
      sampleRing[(sampleWrite + index) & (fftSamples - 1)] * hammingWindow[index];
    spectrum[2 * destination + 1] = 0;
  }

  // Iterative radix-2 Cooley-Tukey FFT (upstream MFCC._hammingAndFFT).
  for (let half = 1; half < fftSamples; half <<= 1) {
    const step = half << 1;
    const delta = fftSamples / step;
    for (let offset = 0; offset < half; offset += 1) {
      const twiddleBase = 2 * (offset * delta);
      const twiddleReal = fftCosSin[twiddleBase];
      const twiddleImaginary = fftCosSin[twiddleBase + 1];
      for (let index = offset; index < fftSamples; index += step) {
        const first = index << 1;
        const second = (index + half) << 1;
        const firstReal = spectrum[first];
        const firstImaginary = spectrum[first + 1];
        const secondReal = spectrum[second];
        const secondImaginary = spectrum[second + 1];
        const valueReal = secondReal * twiddleReal - secondImaginary * twiddleImaginary;
        const valueImaginary = secondReal * twiddleImaginary + secondImaginary * twiddleReal;
        spectrum[first] = firstReal + valueReal;
        spectrum[first + 1] = firstImaginary + valueImaginary;
        spectrum[second] = firstReal - valueReal;
        spectrum[second + 1] = firstImaginary - valueImaginary;
      }
    }
  }

  // Power spectrum, normalized by N, written over the low half of `spectrum`
  // (safe: power bin k only reads complex bins 2k and 2k+1, always ahead of k).
  for (let bin = 0; bin < fftSamples / 2; bin += 1) {
    const real = spectrum[2 * bin];
    const imaginary = spectrum[2 * bin + 1];
    spectrum[bin] = (real * real + imaginary * imaginary) / fftSamples;
  }

  // Triangular mel filters over the power spectrum.
  const { melEnergies } = state;
  for (let band = 0; band < melBands; band += 1) {
    const left = melBinEdges[band];
    const centre = melBinEdges[band + 1];
    const right = melBinEdges[band + 2];
    let sum = 0;
    for (let bin = left; bin < centre; bin += 1) {
      sum += (spectrum[bin] * (bin - left)) / (centre - left);
    }
    for (let bin = centre; bin < right; bin += 1) {
      sum += (spectrum[bin] * (right - bin)) / (right - centre);
    }
    melEnergies[band] = Math.log10(sum + 1e-10);
  }

  // DCT + lifter + tanh squash into the feature vector.
  const { features } = state;
  for (let coefficient = 0; coefficient < visemeFeatureCount; coefficient += 1) {
    let sum = 0;
    for (let band = 0; band < melBands; band += 1) {
      sum += dctMatrix[coefficient * melBands + band] * melEnergies[band];
    }
    features[coefficient] = Math.tanh(sum * lifterWeights[coefficient]);
  }
}

/** One classified 256-sample analysis hop. */
export interface VisemeHopClassification {
  /** Firmware viseme id of the best prototype (0-14; 14 = silence). */
  viseme: FirmwareVisemeId;
  /**
   * Margin-based confidence, an integer in [0, 255]: the best-to-second-best
   * Mahalanobis distance gap relative to the second-best distance.
   */
  confidence: number;
  /**
   * Mean absolute s16le amplitude over the samples since the previous hop —
   * the level the change track's two-threshold VAD compares against.
   */
  level: number;
  /** Samples consumed since creation/reset when this hop completed. */
  playoutSamples: number;
}

/**
 * Creates a streaming acoustic viseme classifier. Push 16 kHz mono s16le PCM
 * in arbitrary chunk sizes; `onHop` fires once per 256-sample hop (the first
 * once the 512-sample analysis window has filled) with the raw, unsmoothed
 * classification. Output is a pure function of the samples pushed since the
 * last reset — chunk boundaries never affect it. Call `reset` at an assistant
 * answer boundary to restart the playout clock and all signal state.
 */
export function createAcousticVisemeClassifier(speakerMeanHz = 150) {
  const prototypes = parseVisemeModel(visemeModelBytes());
  const melBinEdges = buildMelBinEdges(speakerMeanHz);
  let frontEnd = createFrontEndState();
  let sampleCount = 0;
  let totalSamples = 0;
  let samplesSinceFeature = 0;
  let hopAbsoluteSum = 0;
  let hopSampleCount = 0;
  let hopIndex = 0;

  return {
    /** Feeds PCM through the pipeline, firing `onHop` for each completed hop. */
    push(samples: Int16Array, onHop: (hop: VisemeHopClassification) => void): void {
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        pushSampleThroughFrontEnd(frontEnd, sample);
        if (sampleCount < fftSamples) {
          sampleCount += 1;
        }
        totalSamples += 1;
        samplesSinceFeature += 1;
        hopAbsoluteSum += sample < 0 ? -sample : sample;
        hopSampleCount += 1;

        if (
          sampleCount === fftSamples &&
          samplesSinceFeature >= (hopIndex === 0 ? fftSamples : visemeHopSamples)
        ) {
          extractFeatureVector(frontEnd, melBinEdges);

          // Mahalanobis distance against every prototype.
          const { features, difference } = frontEnd;
          let bestDistance = Infinity;
          let secondDistance = Infinity;
          let bestPrototype = 0;
          for (let prototype = 0; prototype < prototypes.length; prototype += 1) {
            const record = prototypes[prototype];
            const { mean, inverseCovarianceLower } = record;
            for (let feature = 0; feature < visemeFeatureCount; feature += 1) {
              difference[feature] = features[feature] - mean[feature];
            }
            let distance = 0;
            let covarianceIndex = 0;
            for (let row = 0; row < visemeFeatureCount; row += 1) {
              const rowDifference = difference[row];
              for (let column = 0; column < row; column += 1) {
                distance +=
                  2 * inverseCovarianceLower[covarianceIndex] * rowDifference * difference[column];
                covarianceIndex += 1;
              }
              distance += inverseCovarianceLower[covarianceIndex] * rowDifference * rowDifference;
              covarianceIndex += 1;
            }
            if (record.viseme === firmwareVisemes.SIL) {
              distance /= silenceSensitivity;
            }
            // <= matches upstream: on a tie the later prototype wins.
            if (distance <= bestDistance) {
              secondDistance = bestDistance;
              bestDistance = distance;
              bestPrototype = prototype;
            } else if (distance < secondDistance) {
              secondDistance = distance;
            }
          }
          const margin = Number.isFinite(secondDistance)
            ? (secondDistance - bestDistance) / (Math.abs(secondDistance) + 1e-6)
            : 0;
          const confidence = Math.round(Math.min(Math.max(margin, 0), 1) * 255);

          const level = Math.floor(hopAbsoluteSum / hopSampleCount);
          hopIndex += 1;
          onHop({
            viseme: prototypes[bestPrototype].viseme,
            confidence,
            level,
            playoutSamples: totalSamples,
          });
          hopAbsoluteSum = 0;
          hopSampleCount = 0;
          samplesSinceFeature = 0;
        }
      }
    },

    /** Restores the exact initial state; the next push starts a fresh answer. */
    reset(): void {
      frontEnd = createFrontEndState();
      sampleCount = 0;
      totalSamples = 0;
      samplesSinceFeature = 0;
      hopAbsoluteSum = 0;
      hopSampleCount = 0;
      hopIndex = 0;
    },
  };
}

/**
 * Computes the 12-feature vector for exactly one 512-sample block through a
 * fresh front-end — the parity hook mirroring the C port's
 * face_viseme_test_extract_features, used to prove golden-feature equivalence
 * with upstream HeadAudio.
 */
export function computeVisemeFeatureVector(samples: Int16Array, speakerMeanHz = 150): Float32Array {
  if (samples.length !== fftSamples) {
    throw new Error(
      `Feature extraction needs exactly ${fftSamples} samples, got ${samples.length}.`,
    );
  }
  const state = createFrontEndState();
  for (let index = 0; index < samples.length; index += 1) {
    pushSampleThroughFrontEnd(state, samples[index]);
  }
  extractFeatureVector(state, buildMelBinEdges(speakerMeanHz));
  return state.features.slice();
}

/** One discrete viseme change; in effect until the next event's offset. */
export interface VisemeChangeEvent {
  /** Sample offset (16 kHz) relative to the current answer's first sample. */
  playoutSamples: number;
  /** Firmware viseme id; SIL (14) closes the mouth. */
  viseme: FirmwareVisemeId;
  /** Confidence 0-255 of the classification behind this event; 0 for SIL. */
  confidence: number;
}

/** Tuning knobs for the change track; defaults mirror FACE_VISEME_DEFAULT_CONFIG. */
export interface VisemeChangeTrackOptions {
  /** VAD opens at or above this mean-absolute s16le level. */
  vadOpenLevel?: number;
  /** VAD counts a hop at or below this level as quiet. */
  vadCloseLevel?: number;
  /** Consecutive quiet hops before the VAD releases to silence. */
  vadReleaseHops?: number;
  /** Majority-vote ring size in hops (1-6). */
  voteWindow?: number;
  /** Minimum time between emitted events (except the final flush). */
  minimumHoldMs?: number;
}

/**
 * Creates a viseme change-track builder — the C driver's smoothing discipline
 * (face_viseme.c update_pose) adapted for discrete output. Feed it every hop
 * classification in order; each call returns the change event that hop
 * produced, if any. Call `end` when the answer's PCM finishes so the track
 * always closes with SIL, and `reset` at an answer boundary.
 */
export function createVisemeChangeTrack(options: VisemeChangeTrackOptions = {}) {
  const {
    vadOpenLevel = 36,
    vadCloseLevel = 18,
    vadReleaseHops = 4,
    voteWindow = 4,
    minimumHoldMs = 80,
  } = options;
  if (vadOpenLevel <= vadCloseLevel) {
    throw new Error("The VAD open level must be above the close level.");
  }
  if (voteWindow < 1 || voteWindow > 6) {
    throw new Error("The vote window must hold 1 to 6 hops.");
  }
  const minimumHoldSamples = Math.round((minimumHoldMs / 1000) * visemeSampleRateHz);

  const voteRing = new Uint8Array(voteWindow);
  const voteCounts = new Uint8Array(visemeCount);
  // Last raw confidence seen per viseme, so an event can carry the confidence
  // of the classification it came from even when the vote lags the raw hop.
  const lastConfidence = new Uint8Array(visemeCount);
  let voteWrite = 0;
  let vadActive = false;
  let quietHops = 0;
  let lastEmitted: FirmwareVisemeId = firmwareVisemes.SIL;
  let lastEmitOffset = Number.MIN_SAFE_INTEGER;
  let ended = false;

  function initialize(): void {
    voteRing.fill(firmwareVisemes.SIL);
    lastConfidence.fill(0);
    voteWrite = 0;
    vadActive = false;
    quietHops = 0;
    lastEmitted = firmwareVisemes.SIL;
    lastEmitOffset = Number.MIN_SAFE_INTEGER;
    ended = false;
  }
  initialize();

  function emit(playoutSamples: number, viseme: FirmwareVisemeId): VisemeChangeEvent {
    lastEmitted = viseme;
    lastEmitOffset = playoutSamples;
    return {
      playoutSamples,
      viseme,
      confidence: viseme === firmwareVisemes.SIL ? 0 : lastConfidence[viseme],
    };
  }

  return {
    /** Consumes one hop; returns the event this hop emitted, if any. */
    pushHop(hop: VisemeHopClassification): VisemeChangeEvent | undefined {
      if (ended) {
        throw new Error("The viseme change track already ended; reset it first.");
      }
      lastConfidence[hop.viseme] = hop.confidence;

      if (vadActive) {
        if (hop.level <= vadCloseLevel) {
          quietHops += 1;
          // Release hold: a plosive gap or breath pause must stay quiet for
          // several hops before the mouth closes, or every stop consonant
          // would flicker the track shut.
          if (quietHops >= vadReleaseHops) {
            vadActive = false;
            voteRing.fill(firmwareVisemes.SIL);
            voteWrite = 0;
          }
        } else {
          quietHops = 0;
        }
      } else if (hop.level >= vadOpenLevel) {
        vadActive = true;
        quietHops = 0;
        // Prime the ring on onset so the first audible hop wins immediately
        // instead of losing the vote to the silence still filling the ring.
        voteRing.fill(hop.viseme);
        voteWrite = 0;
      }

      let smoothed: FirmwareVisemeId = firmwareVisemes.SIL;
      if (vadActive) {
        voteRing[voteWrite] = hop.viseme;
        voteWrite = (voteWrite + 1) % voteWindow;
        voteCounts.fill(0);
        for (let index = 0; index < voteWindow; index += 1) {
          voteCounts[voteRing[index]] += 1;
        }
        // >= matches the C port: on a tied vote the higher viseme id wins.
        let maximum = 0;
        for (let viseme = 0; viseme < visemeCount; viseme += 1) {
          if (voteCounts[viseme] >= maximum) {
            maximum = voteCounts[viseme];
            smoothed = viseme as FirmwareVisemeId;
          }
        }
      }

      if (smoothed === lastEmitted) {
        return undefined;
      }
      // Minimum hold: the vote ring already suppresses single-hop flicker, but
      // alternating two-hop runs would still emit at ~30 Hz without a floor on
      // event spacing. A suppressed change simply retries on later hops.
      if (hop.playoutSamples - lastEmitOffset < minimumHoldSamples) {
        return undefined;
      }
      return emit(hop.playoutSamples, smoothed);
    },

    /** Ends the track at the given offset, forcing a final SIL if needed. */
    end(playoutSamples: number): VisemeChangeEvent | undefined {
      if (ended) {
        return undefined;
      }
      ended = true;
      if (lastEmitted === firmwareVisemes.SIL) {
        return undefined;
      }
      return emit(Math.max(playoutSamples, lastEmitOffset), firmwareVisemes.SIL);
    },

    /** Restores the exact initial state for the next answer. */
    reset(): void {
      initialize();
    },
  };
}

/**
 * The whole pipeline behind one call: feeds reply PCM in, returns the sparse
 * viseme change events out, with playout offsets relative to the current
 * assistant answer. Call `end` when the answer's audio is complete (it returns
 * the closing SIL event when one is due) and `reset` at every answer boundary.
 */
export function createVisemeTracker() {
  const classifier = createAcousticVisemeClassifier();
  const track = createVisemeChangeTrack();
  let playoutSamples = 0;

  return {
    /** Consumes an answer PCM chunk; returns the change events it produced. */
    push(samples: Int16Array): VisemeChangeEvent[] {
      playoutSamples += samples.length;
      const events: VisemeChangeEvent[] = [];
      classifier.push(samples, (hop) => {
        const event = track.pushHop(hop);
        if (event !== undefined) {
          events.push(event);
        }
      });
      return events;
    },

    /** Ends the answer, returning the closing SIL event if one is due. */
    end(): VisemeChangeEvent | undefined {
      return track.end(playoutSamples);
    },

    /** Starts the next answer: playout clock and all state back to zero. */
    reset(): void {
      classifier.reset();
      track.reset();
      playoutSamples = 0;
    },
  };
}
