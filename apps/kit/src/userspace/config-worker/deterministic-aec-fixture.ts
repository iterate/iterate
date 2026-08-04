export type DeterministicAecResponseRole =
  | "double-talk-dual-carrier-prbs31"
  | "far-dual-carrier-prbs31"
  | "far-speech-shaped"
  | "far-tone"
  | "near-path-pilot"
  | "near-repeat-path-pilot";

export interface DeterministicAecPcmRenderer {
  render(sampleCount: number): Uint8Array;
}

export const DETERMINISTIC_AEC_DURATION_MS = 6_000;
export const DETERMINISTIC_AEC_SAMPLE_RATE_HZ = 16_000;
export const DETERMINISTIC_AEC_FAR_PRBS_RUN_ID = "iterate-kit-production-aec-far-v1";
export const DETERMINISTIC_AEC_DOUBLE_TALK_PRBS_RUN_ID = "iterate-kit-production-aec-double-v1";

/*
 * This response order is an experiment protocol, not a playlist. The host
 * knows the exact source for every response without sending a second control
 * message over the realtime lane, and the provider refuses an extra response
 * instead of silently wrapping to a plausible-looking stimulus. The two
 * low-level pilots keep XMOS on its matched AEC path during the Mac-only
 * controls; comparing those controls with double-talk would otherwise compare
 * two different DSP modes and blame the room difference on echo cancellation.
 */
const responseRoles: readonly DeterministicAecResponseRole[] = Object.freeze([
  "far-tone",
  "far-dual-carrier-prbs31",
  "far-speech-shaped",
  "near-path-pilot",
  "near-repeat-path-pilot",
  "double-talk-dual-carrier-prbs31",
]);

/*
 * These are the SHA-256-derived PRBS31 seeds for the public run IDs above.
 * Workerd's realtime render loop must remain synchronous and allocation
 * bounded, so it cannot derive them through asynchronous Web Crypto while a
 * frame is due. The cross-layer unit test independently derives and renders
 * the same challenges with the host oracle, making a stale or mistyped seed a
 * red test rather than a subtly different acoustic experiment.
 */
const farPrbsSeeds: readonly [number, number] = [0x28e1_e18b, 0x7cf6_1fe7];
const doubleTalkPrbsSeeds: readonly [number, number] = [0x068f_856a, 0x6290_882d];

const quietAmplitude = Object.freeze({
  matchedPathPilot: 64,
  prbsCarrier: 2_250,
  speechShaped: 2_250,
  tone: 4_500,
});

export function deterministicAecResponseRole(responseIndex: number): DeterministicAecResponseRole {
  if (!Number.isSafeInteger(responseIndex) || responseIndex < 0) {
    throw new Error(`Unmodelled deterministic AEC response index ${responseIndex}.`);
  }
  const role = responseRoles[responseIndex];
  if (role === undefined) {
    throw new Error(`Unmodelled deterministic AEC response index ${responseIndex}.`);
  }
  return role;
}

/**
 * Creates the exact source used by the deployed physical AEC experiment.
 *
 * This deliberately lives beside the config worker rather than in the
 * firmware. The same provider seam is used by Grok, so every generated frame
 * still crosses userspace pacing, the public network, the device WebSocket,
 * the speaker, the room, local AEC, and the microphone uplink. The fixture
 * removes provider variability without creating a firmware-only fast path
 * which could pass while production audio is broken.
 */
export function createDeterministicAecRenderer(responseIndex: number): DeterministicAecPcmRenderer {
  const role = deterministicAecResponseRole(responseIndex);
  switch (role) {
    case "far-tone":
      return createToneRenderer(997, quietAmplitude.tone);
    case "far-dual-carrier-prbs31":
      return createPrbs31Renderer(farPrbsSeeds);
    case "far-speech-shaped":
      return createSpeechShapedRenderer(0x5a_17_20_26);
    case "near-path-pilot":
    case "near-repeat-path-pilot":
      return createToneRenderer(431, quietAmplitude.matchedPathPilot);
    case "double-talk-dual-carrier-prbs31":
      return createPrbs31Renderer(doubleTalkPrbsSeeds);
  }
}

function createToneRenderer(frequencyHz: number, amplitude: number): DeterministicAecPcmRenderer {
  let sampleOffset = 0;
  const radiansPerSample = (2 * Math.PI * frequencyHz) / DETERMINISTIC_AEC_SAMPLE_RATE_HZ;
  return {
    render(sampleCount) {
      assertSampleCount(sampleCount);
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = Math.round(
          Math.sin((sampleOffset + index) * radiansPerSample) * amplitude,
        );
      }
      sampleOffset += sampleCount;
      return encodePcm16Le(samples);
    },
  };
}

function createPrbs31Renderer(
  initialStates: readonly [number, number],
): DeterministicAecPcmRenderer {
  const states: [number, number] = [initialStates[0], initialStates[1]];
  const chipShapes = createPrbs31ChipShapes();
  let sampleWithinChip = 0;
  return {
    render(sampleCount) {
      assertSampleCount(sampleCount);
      const samples = new Int16Array(sampleCount);
      let outputOffset = 0;
      while (outputOffset < samples.length) {
        const shapeIndex =
          (prbs31Sign(states[0]) > 0 ? 2 : 0) | (prbs31Sign(states[1]) > 0 ? 1 : 0);
        const shape = chipShapes[shapeIndex]!;
        const copied = Math.min(shape.length - sampleWithinChip, samples.length - outputOffset);
        samples.set(shape.subarray(sampleWithinChip, sampleWithinChip + copied), outputOffset);
        outputOffset += copied;
        sampleWithinChip += copied;
        if (sampleWithinChip === shape.length) {
          sampleWithinChip = 0;
          states[0] = advancePrbs31(states[0]);
          states[1] = advancePrbs31(states[1]);
        }
      }
      return encodePcm16Le(samples);
    },
  };
}

function createPrbs31ChipShapes(): readonly Int16Array[] {
  const chipSamples = 16;
  const shapes: Int16Array[] = [];
  for (const carrier0Sign of [-1, 1]) {
    for (const carrier1Sign of [-1, 1]) {
      const shape = new Int16Array(chipSamples);
      for (let sample = 0; sample < chipSamples; sample += 1) {
        shape[sample] = Math.round(
          quietAmplitude.prbsCarrier *
            (carrier0Sign * Math.sin((2 * Math.PI * sample) / chipSamples) +
              carrier1Sign * Math.sin((4 * Math.PI * sample) / chipSamples)),
        );
      }
      shapes.push(shape);
    }
  }
  return shapes;
}

function createSpeechShapedRenderer(seed: number): DeterministicAecPcmRenderer {
  let randomState = seed >>> 0;
  let slowComponent = 0;
  let bandLimited = 0;
  let sampleOffset = 0;
  const highPassCoefficient = Math.exp((-2 * Math.PI * 120) / DETERMINISTIC_AEC_SAMPLE_RATE_HZ);
  const lowPassCoefficient = Math.exp((-2 * Math.PI * 3_600) / DETERMINISTIC_AEC_SAMPLE_RATE_HZ);
  return {
    render(sampleCount) {
      assertSampleCount(sampleCount);
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        const white = randomState / 0x8000_0000 - 1;
        slowComponent = highPassCoefficient * slowComponent + (1 - highPassCoefficient) * white;
        const highPassed = white - slowComponent;
        bandLimited = lowPassCoefficient * bandLimited + (1 - lowPassCoefficient) * highPassed;
        const timeSeconds = (sampleOffset + index) / DETERMINISTIC_AEC_SAMPLE_RATE_HZ;
        const envelope =
          0.32 +
          0.2 * (1 + Math.sin(2 * Math.PI * 3.1 * timeSeconds)) +
          0.12 * (1 + Math.sin(2 * Math.PI * 5.3 * timeSeconds + 0.7));
        samples[index] = clampPcm16(
          Math.round(bandLimited * envelope * quietAmplitude.speechShaped * 3.6),
        );
      }
      sampleOffset += sampleCount;
      return encodePcm16Le(samples);
    },
  };
}

function assertSampleCount(sampleCount: number): void {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || sampleCount > 1_000_000) {
    throw new Error("A deterministic AEC render must contain 1 through 1000000 samples.");
  }
}

function encodePcm16Le(samples: Int16Array): Uint8Array {
  const encoded = new Uint8Array(samples.byteLength);
  const view = new DataView(encoded.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, samples[index]!, true);
  }
  return encoded;
}

function prbs31Sign(state: number): number {
  return (state >>> 30) & 1 ? 1 : -1;
}

function advancePrbs31(state: number): number {
  const feedback = ((state >>> 30) ^ (state >>> 27)) & 1;
  return ((state << 1) & 0x7fff_ffff) | feedback;
}

function clampPcm16(sample: number): number {
  return Math.max(-32_768, Math.min(32_767, sample));
}
