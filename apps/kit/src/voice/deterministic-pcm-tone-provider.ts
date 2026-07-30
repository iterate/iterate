import { WebSocketPair } from "captun";
import { z } from "zod";
import { nextPcmFrameDeadline } from "./pcm-frame-pacer.ts";

const ProviderControl = z.looseObject({
  type: z.string(),
});

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
  readonly #options: DeterministicPcmToneProviderOptions;
  readonly #sockets = new Set<WebSocket>();
  readonly #streams = new Set<AbortController>();
  #disposed = false;

  constructor(options: DeterministicPcmToneProviderOptions) {
    const sampleCount = (options.sampleRateHz * options.durationMs) / 1_000;
    if (
      !Number.isSafeInteger(options.sampleRateHz) ||
      options.sampleRateHz <= 0 ||
      !Number.isSafeInteger(options.durationMs) ||
      options.durationMs <= 0 ||
      !Number.isSafeInteger(sampleCount) ||
      sampleCount > 10_000_000
    ) {
      throw new Error("The tone duration must produce a bounded whole number of samples.");
    }
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
    if (
      !Number.isSafeInteger(options.chunkBytes) ||
      options.chunkBytes <= 0 ||
      options.chunkBytes % 2 !== 0 ||
      options.chunkBytes > 64 * 1_024
    ) {
      throw new Error("Provider chunks must contain a bounded whole number of PCM16 samples.");
    }
    this.#options = options;
  }

  async connect() {
    if (this.#disposed) {
      throw new Error("The deterministic PCM provider has been disposed.");
    }
    const pair = new WebSocketPair();
    const proxySocket = pair[0];
    const fixtureSocket = pair[1];
    proxySocket.accept();
    fixtureSocket.accept();
    this.#sockets.add(proxySocket);
    this.#sockets.add(fixtureSocket);
    let responseStarted = false;
    let activeStream: AbortController | undefined;

    fixtureSocket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch {
        fixtureSocket.close(4002, "Malformed provider control.");
        return;
      }
      const control = ProviderControl.safeParse(decoded);
      if (!control.success) {
        fixtureSocket.close(4002, "Malformed provider control.");
        return;
      }
      if (control.data.type === "response.cancel") {
        activeStream?.abort();
        activeStream = undefined;
        responseStarted = false;
        return;
      }
      if (control.data.type !== "response.create" || responseStarted) {
        return;
      }
      responseStarted = true;
      activeStream = new AbortController();
      this.#streams.add(activeStream);
      const stream = activeStream;
      void this.#streamTone(fixtureSocket, stream.signal)
        .catch(() => {
          if (!stream.signal.aborted) {
            fixtureSocket.close(1011, "Deterministic provider stream failed.");
          }
        })
        .finally(() => {
          this.#streams.delete(stream);
          if (activeStream === stream) activeStream = undefined;
        });
    });
    return proxySocket;
  }

  async #streamTone(socket: WebSocket, signal: AbortSignal) {
    socket.send(JSON.stringify({ type: "response.created" }));
    const sampleCount = (this.#options.sampleRateHz * this.#options.durationMs) / 1_000;
    const samplesPerChunk = this.#options.chunkBytes / 2;
    let nextChunkDeadline = 0;
    let sampleOffset = 0;
    while (sampleOffset < sampleCount) {
      if (signal.aborted) throw signal.reason;
      const renderedSamples = Math.min(
        samplesPerChunk,
        sampleCount - sampleOffset,
      );
      socket.send(this.#renderPcm16Le(sampleOffset, renderedSamples));
      sampleOffset += renderedSamples;
      if (sampleOffset === sampleCount) break;
      /*
       * A ten-minute source must not become a ten-minute proxy backlog. Pace
       * each bounded chunk on an absolute clock, but reset after a whole-chunk
       * scheduler stall instead of firing catch-up bursts. The proxy still
       * performs its production 640-byte rechunking, so deliberately odd
       * provider boundaries remain covered without allocating the response.
       */
      nextChunkDeadline = nextPcmFrameDeadline(
        nextChunkDeadline,
        performance.now(),
        (renderedSamples * 1_000) / this.#options.sampleRateHz,
      );
      await waitForDeadline(nextChunkDeadline, signal);
    }
    if (signal.aborted) throw signal.reason;
    socket.send(JSON.stringify({ type: "response.done" }));
  }

  #renderPcm16Le(sampleOffset: number, sampleCount: number) {
    const pcm = new Uint8Array(sampleCount * 2);
    const view = new DataView(pcm.buffer);
    const radiansPerSample =
      (2 * Math.PI * this.#options.frequencyHz) / this.#options.sampleRateHz;
    for (let relativeIndex = 0; relativeIndex < sampleCount; relativeIndex += 1) {
      const sample = Math.round(
        Math.sin((sampleOffset + relativeIndex) * radiansPerSample) *
          this.#options.amplitude,
      );
      /*
       * The device contract is explicitly PCM16LE. DataView avoids inheriting
       * the host CPU's byte order, which would make a passing simulator on one
       * computer become noise or near-silence on another.
       */
      view.setInt16(relativeIndex * 2, sample, true);
    }
    return pcm;
  }

  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const stream of this.#streams) stream.abort();
    this.#streams.clear();
    for (const socket of this.#sockets) {
      socket.close(1000, "Deterministic PCM provider stopped.");
    }
    this.#sockets.clear();
  }
}

function waitForDeadline(deadline: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finished, Math.max(0, deadline - performance.now()));
    function finished() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
