import { DeterministicPcmProvider } from "./deterministic-pcm-provider.ts";
import { createTonePcm16LeRenderer } from "./deterministic-pcm-renderers.ts";

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
    this.#provider = new DeterministicPcmProvider({
      chunkBytes: options.chunkBytes,
      createRenderer: () => createTonePcm16LeRenderer(options),
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
