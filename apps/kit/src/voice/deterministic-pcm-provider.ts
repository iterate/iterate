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

export interface DeterministicPcmSourcePause {
  /** Exact sample boundary after which the source stops producing bytes. */
  afterSamples: number;
  /** Bounded wall-clock outage before the same source generation resumes. */
  durationMs: number;
}

export interface DeterministicPcmResponsePlan {
  durationMs: number;
  renderer: DeterministicPcm16LeRenderer;
  sourcePauses?: readonly DeterministicPcmSourcePause[];
}

export interface DeterministicPcmProviderOptions {
  chunkBytes: number;
  createRenderer?(responseIndex: number): DeterministicPcm16LeRenderer;
  createResponse?(responseIndex: number): DeterministicPcmResponsePlan;
  durationMs?: number;
  responseIndexScope?: "connection" | "provider";
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
  #providerResponseIndex = 0;

  constructor(options: DeterministicPcmProviderOptions) {
    if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
      throw new Error("The deterministic PCM provider requires a positive whole sample rate.");
    }
    if (
      !Number.isSafeInteger(options.chunkBytes) ||
      options.chunkBytes <= 0 ||
      options.chunkBytes % Int16Array.BYTES_PER_ELEMENT !== 0 ||
      options.chunkBytes > 64 * 1_024
    ) {
      throw new Error("Provider chunks must contain a bounded whole number of PCM16 samples.");
    }
    const fixedResponse =
      typeof options.createRenderer === "function" && options.durationMs !== undefined;
    const plannedResponse = typeof options.createResponse === "function";
    if (fixedResponse === plannedResponse) {
      throw new Error(
        "The deterministic PCM provider requires exactly one fixed or per-response plan.",
      );
    }
    if (fixedResponse) {
      validateDuration(options.durationMs!, options.sampleRateHz);
    }
    if (
      options.responseIndexScope !== undefined &&
      options.responseIndexScope !== "connection" &&
      options.responseIndexScope !== "provider"
    ) {
      throw new Error("The deterministic PCM response index scope is invalid.");
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
    const forgetSocket = (event: Event) => this.#sockets.delete(event.currentTarget as WebSocket);
    proxySocket.addEventListener("close", forgetSocket, { once: true });
    fixtureSocket.addEventListener("close", forgetSocket, { once: true });
    let responseStarted = false;
    let responseIndex = 0;
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
      const currentResponseIndex =
        this.#options.responseIndexScope === "provider"
          ? this.#providerResponseIndex++
          : responseIndex++;
      void this.#streamPcm(fixtureSocket, stream.signal, currentResponseIndex, () => {
        if (activeStream !== stream) return;
        activeStream = undefined;
        responseStarted = false;
      })
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

  /**
   * Ends every current upstream generation without disposing fixture identity.
   *
   * The release matrix must prove reconnect behavior while preserving its
   * provider-wide response index. Reconstructing the provider would reset that
   * index and could silently replay phase zero under a later phase label.
   */
  retireConnections(reason = "Deterministic provider generation retired.") {
    if (this.#disposed) throw new Error("The deterministic PCM provider has been disposed.");
    for (const stream of this.#streams) stream.abort(new Error(reason));
    this.#streams.clear();
    for (const socket of this.#sockets) socket.close(1000, reason);
    this.#sockets.clear();
  }

  async #streamPcm(
    socket: WebSocket,
    signal: AbortSignal,
    responseIndex: number,
    beforeResponseDone: () => void,
  ) {
    const response = this.#options.createResponse
      ? this.#options.createResponse(responseIndex)
      : {
          durationMs: this.#options.durationMs!,
          renderer: this.#options.createRenderer!(responseIndex),
        };
    validateDuration(response.durationMs, this.#options.sampleRateHz);
    const sourcePauses = validateSourcePauses(
      response.sourcePauses ?? [],
      response.durationMs,
      this.#options.sampleRateHz,
    );
    const renderer = response.renderer;
    if (!renderer || typeof renderer.render !== "function") {
      throw new Error("The deterministic PCM renderer factory returned no renderer.");
    }
    socket.send(JSON.stringify({ type: "response.created" }));
    const sampleCount = (this.#options.sampleRateHz * response.durationMs) / 1_000;
    const samplesPerChunk = this.#options.chunkBytes / Int16Array.BYTES_PER_ELEMENT;
    let nextChunkDeadline = 0;
    let nextPauseIndex = 0;
    let sampleOffset = 0;
    while (sampleOffset < sampleCount) {
      if (signal.aborted) throw signal.reason;
      const nextPause = sourcePauses[nextPauseIndex];
      const samplesBeforePause = nextPause
        ? nextPause.afterSamples - sampleOffset
        : Number.POSITIVE_INFINITY;
      const renderedSamples = Math.min(
        samplesPerChunk,
        sampleCount - sampleOffset,
        samplesBeforePause,
      );
      if (renderedSamples <= 0) {
        if (!nextPause || sampleOffset !== nextPause.afterSamples) {
          throw new Error("The PCM source pause plan did not advance monotonically.");
        }
        /*
         * This is deliberately a source outage, not queued silence. Reset the
         * absolute pacer afterward so recovery resumes at realtime cadence and
         * never emits an old-audio catch-up burst.
         */
        await waitForDuration(nextPause.durationMs, signal);
        nextPauseIndex += 1;
        nextChunkDeadline = 0;
        continue;
      }
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
    /*
     * response.done is a media boundary, not a connection boundary. Release
     * the response latch before publishing that ordered terminal event so a
     * test controller may synchronously request the next phase from its
     * response.done listener. The callback checks stream ownership; a stale
     * cancelled stream therefore cannot unlock a newer replacement response.
     */
    beforeResponseDone();
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

function validateSourcePauses(
  pauses: readonly DeterministicPcmSourcePause[],
  durationMs: number,
  sampleRateHz: number,
) {
  const sampleCount = (sampleRateHz * durationMs) / 1_000;
  let previousAfterSamples = 0;
  return pauses.map((pause) => {
    if (
      !Number.isSafeInteger(pause.afterSamples) ||
      pause.afterSamples <= previousAfterSamples ||
      pause.afterSamples >= sampleCount ||
      !Number.isSafeInteger(pause.durationMs) ||
      pause.durationMs <= 0 ||
      pause.durationMs > 5_000
    ) {
      throw new Error(
        "PCM source pauses must be ordered interior sample boundaries with durations up to 5000 ms.",
      );
    }
    previousAfterSamples = pause.afterSamples;
    return Object.freeze({ ...pause });
  });
}

function validateDuration(durationMs: number, sampleRateHz: number) {
  const sampleCount = (sampleRateHz * durationMs) / 1_000;
  /*
   * Ten minutes is the release matrix's longest single phase. Keeping this
   * bound on each response prevents malformed evidence metadata from turning
   * a physical rig into an unbounded socket stream while still permitting the
   * stability phase without special transport code.
   */
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount > 10_000_000
  ) {
    throw new Error("The PCM duration must produce a bounded whole number of samples.");
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

function waitForDuration(durationMs: number, signal: AbortSignal) {
  return waitForDeadline(performance.now() + durationMs, signal);
}
