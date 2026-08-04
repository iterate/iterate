import {
  DualCarrierPrbs31Renderer,
  type DualCarrierPrbs31Challenge,
} from "../device/acoustic-prbs31-challenge.ts";
import type { DeterministicPcm16LeRenderer } from "./deterministic-pcm-provider.ts";

/** Streams an already-hashed PCM16LE fixture exactly once. */
export function createBufferPcm16LeRenderer(source: Uint8Array): DeterministicPcm16LeRenderer {
  if (source.byteLength === 0 || source.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Buffered PCM16 fixture must contain a non-empty whole number of samples.");
  }
  let byteOffset = 0;
  return {
    render(sampleCount) {
      const byteCount = sampleCount * Int16Array.BYTES_PER_ELEMENT;
      if (
        !Number.isSafeInteger(sampleCount) ||
        sampleCount <= 0 ||
        byteOffset + byteCount > source.byteLength
      ) {
        throw new Error("Buffered PCM16 fixture was exhausted before its declared duration.");
      }
      const bytes = source.slice(byteOffset, byteOffset + byteCount);
      byteOffset += byteCount;
      return bytes;
    },
  };
}

/**
 * A bounded stationary spectrum which exposes frequency-selective echo leaks.
 *
 * `amplitude` is the maximum sum of the individual carrier amplitudes, not an
 * amplitude per carrier. That interpretation keeps adding a diagnostic band
 * from silently making a reviewed physical profile louder or clipped.
 */
export function createMultiTonePcm16LeRenderer(options: {
  amplitude: number;
  frequenciesHz: readonly number[];
  sampleRateHz: number;
}): DeterministicPcm16LeRenderer {
  assertPcm16Amplitude(options.amplitude);
  if (options.frequenciesHz.length < 2) {
    throw new Error("Multi-tone PCM requires at least two frequencies.");
  }
  for (const frequencyHz of options.frequenciesHz) {
    assertFrequencyBelowNyquist(frequencyHz, options.sampleRateHz, "Multi-tone");
  }
  if (new Set(options.frequenciesHz).size !== options.frequenciesHz.length) {
    throw new Error("Multi-tone PCM frequencies must be distinct.");
  }

  const carrierAmplitude = options.amplitude / options.frequenciesHz.length;
  const radiansPerSample = options.frequenciesHz.map(
    (frequencyHz) => (2 * Math.PI * frequencyHz) / options.sampleRateHz,
  );
  let sampleOffset = 0;
  return {
    render(sampleCount) {
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        let sample = 0;
        for (const radians of radiansPerSample) {
          sample += Math.sin((sampleOffset + index) * radians) * carrierAmplitude;
        }
        samples[index] = Math.round(sample);
      }
      sampleOffset += sampleCount;
      return encodePcm16Le(samples);
    },
  };
}

/**
 * A repeating linear-frequency sweep with continuous phase at each wrap.
 *
 * Resetting phase at provider chunks would manufacture broadband transients;
 * resetting it at the sweep boundary would conflate an intentional frequency
 * path change with an impulse. Only frequency wraps. Phase remains continuous
 * for the renderer lifetime, so retained options plus sample count completely
 * describe the source irrespective of WebSocket framing.
 */
export function createChirpPcm16LeRenderer(options: {
  amplitude: number;
  endFrequencyHz: number;
  sampleRateHz: number;
  startFrequencyHz: number;
  sweepDurationSamples: number;
}): DeterministicPcm16LeRenderer {
  assertPcm16Amplitude(options.amplitude);
  assertFrequencyBelowNyquist(options.startFrequencyHz, options.sampleRateHz, "Chirp start");
  assertFrequencyBelowNyquist(options.endFrequencyHz, options.sampleRateHz, "Chirp end");
  if (options.endFrequencyHz <= options.startFrequencyHz) {
    throw new Error("Chirp end frequency must exceed its start frequency.");
  }
  if (!Number.isSafeInteger(options.sweepDurationSamples) || options.sweepDurationSamples < 2) {
    throw new Error("Chirp sweep duration must contain at least two whole samples.");
  }

  let phaseRadians = 0;
  let sweepSampleOffset = 0;
  const frequencyStepHz =
    (options.endFrequencyHz - options.startFrequencyHz) / (options.sweepDurationSamples - 1);
  return {
    render(sampleCount) {
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = Math.round(Math.sin(phaseRadians) * options.amplitude);
        const frequencyHz = options.startFrequencyHz + sweepSampleOffset * frequencyStepHz;
        phaseRadians += (2 * Math.PI * frequencyHz) / options.sampleRateHz;
        phaseRadians %= 2 * Math.PI;
        sweepSampleOffset += 1;
        if (sweepSampleOffset === options.sweepDurationSamples) sweepSampleOffset = 0;
      }
      return encodePcm16Le(samples);
    },
  };
}

/** A sparse alternating impulse train for tail and reconvergence measurement. */
export function createImpulseTrainPcm16LeRenderer(options: {
  amplitude: number;
  periodSamples: number;
}): DeterministicPcm16LeRenderer {
  assertPcm16Amplitude(options.amplitude);
  if (!Number.isSafeInteger(options.periodSamples) || options.periodSamples < 2) {
    throw new Error("Impulse period must contain at least two whole samples.");
  }
  let sampleOffset = 0;
  return {
    render(sampleCount) {
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        const absoluteSample = sampleOffset + index;
        if (absoluteSample % options.periodSamples === 0) {
          const impulseIndex = absoluteSample / options.periodSamples;
          samples[index] = impulseIndex % 2 === 0 ? options.amplitude : -options.amplitude;
        }
      }
      sampleOffset += sampleCount;
      return encodePcm16Le(samples);
    },
  };
}

export function createTonePcm16LeRenderer(options: {
  amplitude: number;
  frequencyHz: number;
  sampleRateHz: number;
}): DeterministicPcm16LeRenderer {
  assertFrequencyBelowNyquist(options.frequencyHz, options.sampleRateHz, "Tone");
  assertPcm16Amplitude(options.amplitude);
  let sampleOffset = 0;
  const radiansPerSample = (2 * Math.PI * options.frequencyHz) / options.sampleRateHz;
  return {
    render(sampleCount) {
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = Math.round(
          Math.sin((sampleOffset + index) * radiansPerSample) * options.amplitude,
        );
      }
      sampleOffset += sampleCount;
      return encodePcm16Le(samples);
    },
  };
}

export function createPrbs31Pcm16LeRenderer(
  challenge: DualCarrierPrbs31Challenge,
  options: { outputGain?: number } = {},
): DeterministicPcm16LeRenderer {
  const renderer = new DualCarrierPrbs31Renderer(challenge);
  const outputGain = options.outputGain ?? 1;
  if (!Number.isFinite(outputGain) || outputGain <= 0 || outputGain > 1) {
    throw new Error("PRBS output gain must be greater than zero and no greater than one.");
  }
  return {
    render(sampleCount) {
      const samples = renderer.render(sampleCount);
      if (outputGain < 1) {
        /*
         * The challenge is a versioned, self-authenticating description of
         * the diagnostic signal. Changing its carrierAmplitude to make a
         * room test quieter invalidates that identity and, in production-like
         * sequencing, tears down the provider before the next response can
         * start. Acoustic playback level belongs at this final transducer
         * boundary instead: attenuation preserves the PRBS sequence, phase,
         * commitment, and analyser contract while bounding what leaves the
         * speaker. Gain is deliberately attenuation-only so this helper can
         * never turn a reviewed fixture into a clipped or unexpectedly loud
         * physical stimulus.
         */
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = Math.round(samples[index]! * outputGain);
        }
      }
      return encodePcm16Le(samples);
    },
  };
}

/**
 * Deterministic, bounded broadband material for challenging an echo canceller.
 *
 * A pure tone can hide a filter which works only at one frequency, while raw
 * white noise spends most of its energy outside the useful voice band. This
 * source high-passes a reproducible LCG stream to remove DC, low-passes it to
 * roughly the speech band, and applies a slow syllabic envelope. It is not a
 * speech synthesizer; it is a stable wide-spectrum regression fixture which
 * retains its filter and random state across arbitrary WebSocket chunks.
 */
export function createSpeechShapedPcm16LeRenderer(options: {
  amplitude: number;
  sampleRateHz: number;
  seed: number;
}): DeterministicPcm16LeRenderer {
  assertPcm16Amplitude(options.amplitude);
  if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz < 8_000) {
    throw new Error("Speech-shaped PCM requires a sample rate of at least 8 kHz.");
  }
  if (!Number.isSafeInteger(options.seed)) {
    throw new Error("Speech-shaped PCM requires a safe-integer seed.");
  }

  let randomState = options.seed >>> 0;
  let slowComponent = 0;
  let bandLimited = 0;
  let sampleOffset = 0;
  const highPassCoefficient = Math.exp((-2 * Math.PI * 120) / options.sampleRateHz);
  const lowPassCoefficient = Math.exp((-2 * Math.PI * 3_600) / options.sampleRateHz);
  return {
    render(sampleCount) {
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        const white = randomState / 0x8000_0000 - 1;
        slowComponent = highPassCoefficient * slowComponent + (1 - highPassCoefficient) * white;
        const highPassed = white - slowComponent;
        bandLimited = lowPassCoefficient * bandLimited + (1 - lowPassCoefficient) * highPassed;
        const timeSeconds = (sampleOffset + index) / options.sampleRateHz;
        const envelope =
          0.32 +
          0.2 * (1 + Math.sin(2 * Math.PI * 3.1 * timeSeconds)) +
          0.12 * (1 + Math.sin(2 * Math.PI * 5.3 * timeSeconds + 0.7));
        samples[index] = clampPcm16(Math.round(bandLimited * envelope * options.amplitude * 3.6));
      }
      sampleOffset += sampleCount;
      return encodePcm16Le(samples);
    },
  };
}

export function renderPcm16Le(
  renderer: DeterministicPcm16LeRenderer,
  sampleCount: number,
  chunkSamples = 997,
) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new Error("PCM rendering requires a positive whole number of samples.");
  }
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples <= 0) {
    throw new Error("PCM rendering requires a positive whole chunk size.");
  }
  const bytes = new Uint8Array(sampleCount * Int16Array.BYTES_PER_ELEMENT);
  for (let sampleOffset = 0; sampleOffset < sampleCount; sampleOffset += chunkSamples) {
    const renderedSamples = Math.min(chunkSamples, sampleCount - sampleOffset);
    const chunk = renderer.render(renderedSamples);
    if (chunk.byteLength !== renderedSamples * Int16Array.BYTES_PER_ELEMENT) {
      throw new Error("The PCM renderer returned the wrong byte count.");
    }
    bytes.set(chunk, sampleOffset * Int16Array.BYTES_PER_ELEMENT);
  }
  return bytes;
}

export function encodePcm16Le(samples: Int16Array) {
  const encoded = new Uint8Array(samples.byteLength);
  const view = new DataView(encoded.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, samples[index]!, true);
  }
  return encoded;
}

function assertPcm16Amplitude(amplitude: number) {
  if (!Number.isSafeInteger(amplitude) || amplitude <= 0 || amplitude > 32_767) {
    throw new Error("The PCM16 amplitude must be from 1 through 32767.");
  }
}

function assertFrequencyBelowNyquist(frequencyHz: number, sampleRateHz: number, label: string) {
  if (
    !Number.isSafeInteger(sampleRateHz) ||
    sampleRateHz <= 0 ||
    !Number.isFinite(frequencyHz) ||
    frequencyHz <= 0 ||
    frequencyHz >= sampleRateHz / 2
  ) {
    throw new Error(`${label} frequency must be below the PCM Nyquist frequency.`);
  }
}

function clampPcm16(sample: number) {
  return Math.max(-32_768, Math.min(32_767, sample));
}
