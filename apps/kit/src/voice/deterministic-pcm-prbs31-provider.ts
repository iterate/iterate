import {
  DualCarrierPrbs31Renderer,
  type DualCarrierPrbs31Challenge,
} from "../device/acoustic-prbs31-challenge.ts";
import { DeterministicPcmProvider } from "./deterministic-pcm-provider.ts";

export interface DeterministicPcmPrbs31ProviderOptions {
  challenge: DualCarrierPrbs31Challenge;
  chunkBytes: number;
  durationMs: number;
}

/**
 * Run-keyed acoustic source for locating loss in the physical playback path.
 *
 * Unlike a constant tone, each millisecond carries a deterministic logical
 * identity. The microphone artifact can therefore say whether the speaker
 * lost the beginning, middle, or end of the provider stream. WebSocket chunk
 * sizes remain an outer transport choice and never reset the two LFSRs.
 */
export class DeterministicPcmPrbs31Provider implements Disposable {
  readonly #provider: DeterministicPcmProvider;

  constructor(options: DeterministicPcmPrbs31ProviderOptions) {
    this.#provider = new DeterministicPcmProvider({
      chunkBytes: options.chunkBytes,
      createRenderer: () => {
        const renderer = new DualCarrierPrbs31Renderer(options.challenge);
        return {
          render(sampleCount: number) {
            return encodePcm16Le(renderer.render(sampleCount));
          },
        };
      },
      durationMs: options.durationMs,
      sampleRateHz: options.challenge.sampleRateHz,
    });
  }

  connect() {
    return this.#provider.connect();
  }

  [Symbol.dispose]() {
    this.#provider[Symbol.dispose]();
  }
}

function encodePcm16Le(samples: Int16Array) {
  const encoded = new Uint8Array(samples.byteLength);
  const view = new DataView(encoded.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, samples[index]!, true);
  }
  return encoded;
}
