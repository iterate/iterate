import { WebSocketPair } from "captun";
import { z } from "zod";
import { nextPcmFrameDeadline } from "./pcm-frame-pacer.ts";

const ProviderControl = z.looseObject({
  type: z.string(),
});

export interface DeterministicPcm16LeRenderer {
  /**
   * Returns exactly `sampleCount` mono PCM16LE samples.
   *
   * Renderers are stateful on purpose. Provider message boundaries are not
   * media boundaries, so a run-keyed diagnostic signal must carry its phase
   * and source identity through every inconvenient WebSocket chunk.
   */
  render(sampleCount: number): Uint8Array;
}

export interface DeterministicPcmProviderOptions {
  chunkBytes: number;
  createRenderer(): DeterministicPcm16LeRenderer;
  durationMs: number;
  sampleRateHz: number;
}

/**
 * Streams one bounded deterministic PCM source through the provider contract.
 *
 * The transport/pacing owner is independent of the signal generator so tone,
 * PRBS, speech fixtures, and future delay probes cannot each grow subtly
 * different WebSocket loops. Only one provider chunk exists at a time; even a
 * ten-minute proof therefore retains constant audio memory and exercises the
 * same incremental proxy reassembly as a real voice provider.
 */
export class DeterministicPcmProvider implements Disposable {
  readonly #options: DeterministicPcmProviderOptions;
  readonly #sockets = new Set<WebSocket>();
  readonly #streams = new Set<AbortController>();
  #disposed = false;

  constructor(options: DeterministicPcmProviderOptions) {
    const sampleCount = (options.sampleRateHz * options.durationMs) / 1_000;
    if (
      !Number.isSafeInteger(options.sampleRateHz) ||
      options.sampleRateHz <= 0 ||
      !Number.isSafeInteger(options.durationMs) ||
      options.durationMs <= 0 ||
      !Number.isSafeInteger(sampleCount) ||
      sampleCount > 10_000_000
    ) {
      throw new Error("The PCM duration must produce a bounded whole number of samples.");
    }
    if (
      !Number.isSafeInteger(options.chunkBytes) ||
      options.chunkBytes <= 0 ||
      options.chunkBytes % Int16Array.BYTES_PER_ELEMENT !== 0 ||
      options.chunkBytes > 64 * 1_024
    ) {
      throw new Error("Provider chunks must contain a bounded whole number of PCM16 samples.");
    }
    if (typeof options.createRenderer !== "function") {
      throw new Error("The deterministic PCM provider requires a renderer factory.");
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
      void this.#streamPcm(fixtureSocket, stream.signal)
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

  async #streamPcm(socket: WebSocket, signal: AbortSignal) {
    const renderer = this.#options.createRenderer();
    if (!renderer || typeof renderer.render !== "function") {
      throw new Error("The deterministic PCM renderer factory returned no renderer.");
    }
    socket.send(JSON.stringify({ type: "response.created" }));
    const sampleCount = (this.#options.sampleRateHz * this.#options.durationMs) / 1_000;
    const samplesPerChunk = this.#options.chunkBytes / Int16Array.BYTES_PER_ELEMENT;
    let nextChunkDeadline = 0;
    let sampleOffset = 0;
    while (sampleOffset < sampleCount) {
      if (signal.aborted) throw signal.reason;
      const renderedSamples = Math.min(samplesPerChunk, sampleCount - sampleOffset);
      const pcm = renderer.render(renderedSamples);
      if (
        !(pcm instanceof Uint8Array) ||
        pcm.byteLength !== renderedSamples * Int16Array.BYTES_PER_ELEMENT
      ) {
        throw new Error("The deterministic PCM renderer returned the wrong byte count.");
      }
      socket.send(pcm);
      sampleOffset += renderedSamples;
      if (sampleOffset === sampleCount) break;
      /*
       * Absolute media deadlines prevent ordinary timer lateness from growing
       * into response-long drift. A whole-chunk scheduler stall resets one
       * interval ahead instead of emitting a catch-up burst that would merely
       * move the backlog into the proxy or device.
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
