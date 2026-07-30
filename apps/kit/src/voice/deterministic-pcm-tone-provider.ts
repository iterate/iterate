import { DeterministicPcmProvider } from "./deterministic-pcm-provider.ts";

export interface DeterministicPcmToneProviderOptions {
  amplitude: number;
  chunkBytes: number;
  durationMs: number;
  frequencyHz: number;
  sampleRateHz: number;
}

/**
 * A provider-side PCM fixture that speaks the same WebSocket contract used by
 * Grok, while producing audio whose duration, frequency, and amplitude are
 * independently knowable.
 *
 * This belongs at the provider seam rather than as a device capability or a
 * firmware-only diagnostic. Consequently a physical tone run still exercises
 * provider events, proxy buffering/pacing, the public tunnel, the ESP
 * WebSocket receiver, the bounded PCM lane, and speaker playback. A defect in
 * any of those layers remains visible, while provider synthesis is removed as
 * an uncontrolled variable.
 */
export class DeterministicPcmToneProvider implements Disposable {
  readonly #provider: DeterministicPcmProvider;

  constructor(options: DeterministicPcmToneProviderOptions) {
    if (
      !Number.isFinite(options.frequencyHz) ||
      options.frequencyHz <= 0 ||
      options.frequencyHz >= options.sampleRateHz / 2
    ) {
      throw new Error("The tone frequency must be below the PCM Nyquist frequency.");
    }
    if (
      !Number.isSafeInteger(options.amplitude) ||
      options.amplitude <= 0 ||
      options.amplitude > 32_767
    ) {
      throw new Error("The PCM16 tone amplitude must be from 1 through 32767.");
    }
    this.#provider = new DeterministicPcmProvider({
      chunkBytes: options.chunkBytes,
      createRenderer: () => {
        let sampleOffset = 0;
        const radiansPerSample = (2 * Math.PI * options.frequencyHz) / options.sampleRateHz;
        return {
          render(sampleCount: number) {
            const pcm = new Uint8Array(sampleCount * Int16Array.BYTES_PER_ELEMENT);
            const view = new DataView(pcm.buffer);
            for (let relativeIndex = 0; relativeIndex < sampleCount; relativeIndex += 1) {
              const sample = Math.round(
                Math.sin((sampleOffset + relativeIndex) * radiansPerSample) * options.amplitude,
              );
              /*
               * The device contract is explicitly PCM16LE. DataView avoids
               * inheriting the host CPU's byte order, which would make a
               * passing simulator on one computer become noise on another.
               */
              view.setInt16(relativeIndex * Int16Array.BYTES_PER_ELEMENT, sample, true);
            }
            sampleOffset += sampleCount;
            return pcm;
          },
        };
      },
      durationMs: options.durationMs,
      sampleRateHz: options.sampleRateHz,
    });
  }

  connect() {
    return this.#provider.connect();
  }

  [Symbol.dispose]() {
    this.#provider[Symbol.dispose]();
  }
}
