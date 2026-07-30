import { createWebSocketResponse, WebSocketPair } from "captun";
import { z } from "zod";
import { nextPcmFrameDeadline } from "./pcm-frame-pacer.ts";

export const ITERATE_KIT_PCM_SUBPROTOCOL = "iterate.kit.pcm.v1";
const projectBearerProtocolPrefix = "iterate-bearer.";
/*
 * This is a realtime jitter allowance, not a speech archive. Eight 20 ms
 * frames absorb ordinary scheduler/radio variation while capping application
 * backlog at 160 ms. A larger default used to retain ten seconds of audio,
 * which made network recovery audibly replay history. Crossing this bound
 * closes the generation so a reconnect can resume with current speech.
 */
const defaultMaximumDownlinkFrames = 8;
/*
 * Provider message boundaries are not device playout boundaries. In
 * particular, the physical endurance source delivers 1,000 bytes every
 * 31.25 ms while the device consumes 640 bytes every 20 ms. Starting on the
 * first complete frame makes the pacer repeatedly run dry even though average
 * rates are identical. Three complete frames are a 60 ms startup reservoir,
 * not a growing FIFO: the same eight-frame/160 ms hard cap still applies and
 * any post-start underrun destroys the generation instead of shifting speech.
 */
const defaultMinimumDownlinkStartupFrames = 3;
/*
 * Server-to-device binary messages of exactly frameBytes are PCM; the sole
 * zero-length message is an ordered end-of-response marker. Keeping the marker
 * on the PCM socket is what proves every preceding frame was enqueued before
 * the device decides whether a short prebuffer is complete.
 */
const pcmEndOfStream = new Uint8Array(0);
const applicationCloseCode = {
  backpressure: 4013,
  counterpartFailure: 4011,
  protocolError: 4002,
} as const;

const ProviderEvent = z.looseObject({
  type: z.string().min(1),
});

export interface ProviderVoiceEvent {
  raw: string;
  type: string;
}

export interface DevicePcmSocketClose {
  classification: "normal" | "unexpected";
  code: number;
  origin: "device" | "provider";
  reason: string;
  /*
   * Captun's standards-shaped server socket currently omits this browser-only
   * signal. Undefined is intentionally preserved instead of coercing absence
   * to false and inventing an unclean transport outcome.
   */
  wasClean?: boolean;
}

export type DevicePcmInputMode = "push-to-talk" | "server-vad";

export interface DevicePcmSessionDescriptor {
  id: string;
  inputMode: DevicePcmInputMode;
}

export interface DevicePcmProxyOptions {
  authenticate(projectId: string, bearerToken: string): boolean;
  connectProvider(session: DevicePcmSessionDescriptor): Promise<WebSocket>;
  frameBytes: number;
  frameDurationMs?: number;
  maximumBufferedBytes?: number;
  maximumDownlinkQueuedBytes?: number;
  maximumProviderMessageBytes?: number;
  minimumDownlinkStartupFrames?: number;
  onFailure?(reason: string): void;
  onProviderEvent?(event: ProviderVoiceEvent): void;
  onSessionReady?(session: DevicePcmSessionDescriptor): void;
  /*
   * Socket closes are lifecycle evidence, including normal closes, rather
   * than generic failures. Keeping their wire fields structured avoids
   * collapsing device loss and provider loss into the same reconnect log or
   * forcing durable diagnostics to parse human prose.
   */
  onSocketClose?(close: DevicePcmSocketClose): void;
  resolveSession?(request: Request, projectId: string): DevicePcmSessionDescriptor | undefined;
}

export function projectBearerSubprotocol(token: string) {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (
    projectBearerProtocolPrefix +
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
  );
}

export class DevicePcmProxy implements Disposable {
  readonly #options: DevicePcmProxyOptions;
  readonly #sessions = new Map<string, DevicePcmProxySession>();
  #disposed = false;

  constructor(options: DevicePcmProxyOptions) {
    if (
      !Number.isSafeInteger(options.frameBytes) ||
      options.frameBytes <= 0 ||
      options.frameBytes % 2 !== 0
    ) {
      throw new Error("PCM frame size must be a positive, even integer.");
    }
    if (
      options.frameDurationMs !== undefined &&
      (!Number.isSafeInteger(options.frameDurationMs) || options.frameDurationMs <= 0)
    ) {
      throw new Error("PCM frame duration must be a positive integer.");
    }
    if (
      options.maximumDownlinkQueuedBytes !== undefined &&
      (!Number.isSafeInteger(options.maximumDownlinkQueuedBytes) ||
        options.maximumDownlinkQueuedBytes < options.frameBytes)
    ) {
      throw new Error("PCM downlink queue must hold at least one complete frame.");
    }
    if (
      options.minimumDownlinkStartupFrames !== undefined &&
      (!Number.isSafeInteger(options.minimumDownlinkStartupFrames) ||
        options.minimumDownlinkStartupFrames <= 0)
    ) {
      throw new Error("PCM downlink startup must contain a positive whole number of frames.");
    }
    const maximumDownlinkQueuedBytes =
      options.maximumDownlinkQueuedBytes ?? options.frameBytes * defaultMaximumDownlinkFrames;
    if (
      options.minimumDownlinkStartupFrames !== undefined &&
      options.minimumDownlinkStartupFrames >
        Math.floor(maximumDownlinkQueuedBytes / options.frameBytes)
    ) {
      throw new Error("PCM downlink startup must fit inside the bounded downlink queue.");
    }
    this.#options = options;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#disposed) {
      return new Response("The PCM proxy is shutting down.", {
        status: 503,
      });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("This endpoint requires a WebSocket upgrade.", {
        headers: { upgrade: "websocket" },
        status: 426,
      });
    }

    const protocols = offeredProtocols(request);
    if (!protocols.includes(ITERATE_KIT_PCM_SUBPROTOCOL)) {
      return new Response(`This endpoint requires ${ITERATE_KIT_PCM_SUBPROTOCOL}.`, {
        status: 400,
      });
    }
    const projectId =
      request.headers.get("x-iterate-project-id") ??
      new URL(request.url).searchParams.get("projectId");
    const bearerToken = requestBearerToken(request, protocols);
    if (!projectId || !bearerToken || !this.#options.authenticate(projectId, bearerToken)) {
      return new Response("Invalid project bearer credentials.", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
      });
    }
    const descriptor = this.#options.resolveSession?.(request, projectId) ?? {
      id: projectId,
      inputMode: "server-vad" as const,
    };
    if (
      !descriptor ||
      descriptor.id.length === 0 ||
      (descriptor.inputMode !== "push-to-talk" && descriptor.inputMode !== "server-vad")
    ) {
      return new Response("Invalid PCM device session.", {
        status: 400,
      });
    }

    let provider: WebSocket;
    try {
      provider = await this.#options.connectProvider(descriptor);
    } catch {
      this.#options.onFailure?.("provider-connect-failed");
      return new Response("The voice provider is unavailable.", {
        status: 502,
      });
    }
    if (this.#disposed) {
      provider.close(1000, "The PCM proxy is shutting down.");
      return new Response("The PCM proxy is shutting down.", {
        status: 503,
      });
    }

    const pair = new WebSocketPair();
    const proxySocket = pair[0];
    const deviceSocket = pair[1];
    proxySocket.accept();
    const maximumDownlinkQueuedBytes =
      this.#options.maximumDownlinkQueuedBytes ??
      this.#options.frameBytes * defaultMaximumDownlinkFrames;
    const minimumDownlinkStartupFrames =
      this.#options.minimumDownlinkStartupFrames ??
      Math.min(
        defaultMinimumDownlinkStartupFrames,
        Math.floor(maximumDownlinkQueuedBytes / this.#options.frameBytes),
      );
    const session = new DevicePcmProxySession({
      device: proxySocket,
      frameBytes: this.#options.frameBytes,
      frameDurationMs: this.#options.frameDurationMs ?? 20,
      inputMode: descriptor.inputMode,
      maximumBufferedBytes: this.#options.maximumBufferedBytes ?? this.#options.frameBytes * 8,
      maximumProviderMessageBytes: this.#options.maximumProviderMessageBytes ?? 64 * 1024,
      maximumDownlinkQueuedBytes,
      minimumDownlinkStartupBytes: this.#options.frameBytes * minimumDownlinkStartupFrames,
      onClose: (closed) => {
        if (this.#sessions.get(descriptor.id) === closed) {
          this.#sessions.delete(descriptor.id);
        }
      },
      onFailure: this.#options.onFailure,
      onProviderEvent: this.#options.onProviderEvent,
      onSocketClose: this.#options.onSocketClose,
      provider,
    });
    this.#sessions.get(descriptor.id)?.[Symbol.dispose]();
    this.#sessions.set(descriptor.id, session);
    this.#options.onSessionReady?.(descriptor);
    return createWebSocketResponse(deviceSocket, {
      protocol: ITERATE_KIT_PCM_SUBPROTOCOL,
    });
  }

  inputStarted(sessionId: string) {
    return this.#sessions.get(sessionId)?.inputStarted() ?? Promise.resolve(false);
  }

  inputStopped(sessionId: string) {
    return this.#sessions.get(sessionId)?.inputStopped() ?? Promise.resolve(false);
  }

  requestTextResponse(sessionId: string, text: string) {
    return this.#sessions.get(sessionId)?.requestTextResponse(text) ?? Promise.resolve(false);
  }

  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of this.#sessions.values()) {
      session[Symbol.dispose]();
    }
    this.#sessions.clear();
  }
}

interface DevicePcmProxySessionOptions {
  device: WebSocket;
  frameBytes: number;
  frameDurationMs: number;
  inputMode: DevicePcmInputMode;
  maximumBufferedBytes: number;
  maximumDownlinkQueuedBytes: number;
  maximumProviderMessageBytes: number;
  minimumDownlinkStartupBytes: number;
  onClose(session: DevicePcmProxySession): void;
  onFailure?: DevicePcmProxyOptions["onFailure"];
  onProviderEvent?: DevicePcmProxyOptions["onProviderEvent"];
  onSocketClose?: DevicePcmProxyOptions["onSocketClose"];
  provider: WebSocket;
}

class DevicePcmProxySession implements Disposable {
  readonly #device: WebSocket;
  readonly #downlinkFrame: Uint8Array;
  readonly #downlinkQueue: Uint8Array;
  readonly #frameBytes: number;
  readonly #frameDurationMs: number;
  readonly #inputMode: DevicePcmInputMode;
  readonly #maximumBufferedBytes: number;
  readonly #maximumProviderMessageBytes: number;
  readonly #minimumDownlinkStartupBytes: number;
  readonly #onClose: DevicePcmProxySessionOptions["onClose"];
  readonly #onFailure: DevicePcmProxySessionOptions["onFailure"];
  readonly #onProviderEvent: DevicePcmProxySessionOptions["onProviderEvent"];
  readonly #onSocketClose: DevicePcmProxySessionOptions["onSocketClose"];
  readonly #provider: WebSocket;
  /*
   * Workers normally delivers binary WebSocket messages as ArrayBuffers, so
   * they are admitted synchronously into the real bounded queue. Blob support
   * is retained for browser-shaped test/host peers, but exactly one conversion
   * may be in flight per direction. A Promise chain is not a queue bound: every
   * `.then()` closure retains its event payload before application backpressure
   * runs, allowing arbitrary heap growth behind one slow Blob conversion.
   */
  #deviceBlobConversion: Promise<void> | undefined;
  #downlinkQueuedBytes = 0;
  #downlinkReadOffset = 0;
  #downlinkResponseDone = false;
  #downlinkStarted = false;
  #downlinkTimer: ReturnType<typeof setTimeout> | undefined;
  #downlinkWriteOffset = 0;
  #nextDownlinkAt = 0;
  #inputActive = false;
  #responseActive = false;
  #responseRequested = false;
  #suppressDownlink = false;
  #providerBlobConversion: Promise<void> | undefined;
  #closed = false;

  constructor(options: DevicePcmProxySessionOptions) {
    this.#device = options.device;
    this.#downlinkFrame = new Uint8Array(options.frameBytes);
    this.#downlinkQueue = new Uint8Array(options.maximumDownlinkQueuedBytes);
    this.#frameBytes = options.frameBytes;
    this.#frameDurationMs = options.frameDurationMs;
    this.#inputMode = options.inputMode;
    this.#maximumBufferedBytes = options.maximumBufferedBytes;
    this.#maximumProviderMessageBytes = options.maximumProviderMessageBytes;
    this.#minimumDownlinkStartupBytes = options.minimumDownlinkStartupBytes;
    this.#onClose = options.onClose;
    this.#onFailure = options.onFailure;
    this.#onProviderEvent = options.onProviderEvent;
    this.#onSocketClose = options.onSocketClose;
    this.#provider = options.provider;

    this.#device.addEventListener("message", (event) => {
      try {
        this.#acceptDeviceMessage(event.data);
      } catch {
        this.#fail("device-message-failed", applicationCloseCode.protocolError);
      }
    });
    this.#provider.addEventListener("message", (event) => {
      try {
        this.#acceptProviderMessage(event.data);
      } catch {
        this.#fail("provider-message-failed", applicationCloseCode.protocolError);
      }
    });
    this.#device.addEventListener(
      "close",
      (event) => this.#closeFrom(event, this.#provider, "device"),
      { once: true },
    );
    this.#provider.addEventListener(
      "close",
      (event) => this.#closeFrom(event, this.#device, "provider"),
      { once: true },
    );
    this.#provider.addEventListener(
      "error",
      () => this.#fail("provider-websocket-error", applicationCloseCode.counterpartFailure),
      { once: true },
    );
  }

  async inputStarted() {
    if (this.#closed || this.#inputMode !== "push-to-talk" || this.#inputActive) {
      return false;
    }
    this.#inputActive = true;
    this.#responseRequested = false;
    this.#suppressDownlink = true;
    this.#clearDownlinkQueue();
    if (this.#responseActive && !this.#sendProviderControl("response.cancel")) {
      return false;
    }
    return true;
  }

  async inputStopped() {
    if (this.#closed || this.#inputMode !== "push-to-talk" || !this.#inputActive) {
      return false;
    }
    this.#inputActive = false;
    const sendControls = (this.#deviceBlobConversion ?? Promise.resolve()).then(() => {
      if (this.#closed) return false;
      if (!this.#sendProviderControl("input_audio_buffer.commit")) {
        return false;
      }
      if (!this.#sendProviderControl("response.create")) {
        return false;
      }
      this.#responseRequested = true;
      return true;
    });
    return sendControls;
  }

  async requestTextResponse(text: string) {
    const prompt = text.trim();
    if (
      this.#closed ||
      this.#inputActive ||
      this.#responseActive ||
      this.#responseRequested ||
      prompt.length === 0 ||
      prompt.length > 4_096
    ) {
      return false;
    }

    this.#suppressDownlink = true;
    this.#clearDownlinkQueue();
    if (
      !this.#sendProviderEvent({
        item: {
          content: [{ text: prompt, type: "input_text" }],
          role: "user",
          type: "message",
        },
        type: "conversation.item.create",
      })
    ) {
      return false;
    }
    if (!this.#sendProviderControl("response.create")) {
      return false;
    }
    this.#responseRequested = true;
    return true;
  }

  #acceptDeviceMessage(data: unknown) {
    if (this.#closed) return;
    /*
     * Processing a later message before an earlier Blob finishes would corrupt
     * PCM order. Retaining it would reintroduce the hidden unbounded queue, so
     * overload has one deterministic outcome: close this generation and let
     * the device reconnect with fresh audio.
     */
    if (this.#deviceBlobConversion) {
      this.#fail("device-ingress-mailbox-overflow", applicationCloseCode.backpressure);
      return;
    }
    if (typeof data === "string") {
      this.#fail("text-on-pcm-uplink", applicationCloseCode.protocolError);
      return;
    }
    const bytes = synchronousBinaryBytes(data);
    if (bytes) {
      this.#relayDeviceBytes(bytes);
      return;
    }
    if (!(data instanceof Blob) || data.size !== this.#frameBytes) {
      this.#fail("invalid-pcm-uplink-frame-size", applicationCloseCode.protocolError);
      return;
    }
    let conversion: Promise<void>;
    conversion = data
      .arrayBuffer()
      .then(
        (buffer) => {
          if (!this.#closed) this.#relayDeviceBytes(new Uint8Array(buffer));
        },
        () => this.#fail("device-message-failed", applicationCloseCode.protocolError),
      )
      .finally(() => {
        if (this.#deviceBlobConversion === conversion) {
          this.#deviceBlobConversion = undefined;
        }
      });
    this.#deviceBlobConversion = conversion;
  }

  #relayDeviceBytes(bytes: Uint8Array) {
    if (!bytes || bytes.byteLength !== this.#frameBytes) {
      this.#fail("invalid-pcm-uplink-frame-size", applicationCloseCode.protocolError);
      return;
    }
    if (!this.#send(this.#provider, bytes)) {
      this.#fail("provider-egress-backpressure", applicationCloseCode.backpressure);
    }
  }

  #acceptProviderMessage(data: unknown) {
    if (this.#closed) return;
    if (this.#providerBlobConversion) {
      this.#fail("provider-ingress-mailbox-overflow", applicationCloseCode.backpressure);
      return;
    }
    if (typeof data === "string") {
      this.#relayProviderText(data);
      return;
    }
    const bytes = synchronousBinaryBytes(data);
    if (bytes) {
      this.#relayProviderBytes(bytes);
      return;
    }
    if (
      !(data instanceof Blob) ||
      data.size === 0 ||
      data.size > this.#maximumProviderMessageBytes ||
      data.size % 2 !== 0
    ) {
      this.#fail("invalid-provider-pcm-message", applicationCloseCode.protocolError);
      return;
    }
    let conversion: Promise<void>;
    conversion = data
      .arrayBuffer()
      .then(
        (buffer) => {
          if (!this.#closed) this.#relayProviderBytes(new Uint8Array(buffer));
        },
        () => this.#fail("provider-message-failed", applicationCloseCode.protocolError),
      )
      .finally(() => {
        if (this.#providerBlobConversion === conversion) {
          this.#providerBlobConversion = undefined;
        }
      });
    this.#providerBlobConversion = conversion;
  }

  #relayProviderText(data: string) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      this.#fail("malformed-provider-event", applicationCloseCode.protocolError);
      return;
    }
    const event = ProviderEvent.safeParse(decoded);
    if (!event.success) {
      this.#fail("malformed-provider-event", applicationCloseCode.protocolError);
      return;
    }
    this.#onProviderEvent?.({
      raw: data,
      type: event.data.type,
    });
    if (event.data.type === "response.created") {
      this.#responseActive = true;
      if (this.#inputMode === "push-to-talk") {
        if (this.#inputActive) {
          this.#sendProviderControl("response.cancel");
        } else if (this.#responseRequested) {
          this.#responseRequested = false;
          this.#suppressDownlink = false;
        }
      }
    }
    if (event.data.type === "response.done") {
      this.#responseActive = false;
      if (this.#suppressDownlink) {
        this.#clearDownlinkQueue();
      } else {
        this.#downlinkResponseDone = true;
        if (this.#downlinkQueuedBytes === 0 && this.#downlinkTimer !== undefined) {
          /*
           * While a response is open, an empty started queue keeps its next
           * deadline armed so source starvation becomes a visible underrun.
           * `response.done` changes that meaning: no further PCM is expected,
           * so cancel the probe and emit EOS now. Waiting for the old deadline
           * would manufacture a silent tail after a perfectly complete frame.
           */
          clearTimeout(this.#downlinkTimer);
          this.#downlinkTimer = undefined;
        }
        this.#scheduleDownlink();
      }
    }
  }

  #relayProviderBytes(bytes: Uint8Array) {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > this.#maximumProviderMessageBytes ||
      bytes.byteLength % 2 !== 0
    ) {
      this.#fail("invalid-provider-pcm-message", applicationCloseCode.protocolError);
      return;
    }
    if (this.#suppressDownlink) return;
    this.#relayProviderPcm(bytes);
  }

  #relayProviderPcm(bytes: Uint8Array) {
    if (bytes.byteLength > this.#downlinkQueue.byteLength - this.#downlinkQueuedBytes) {
      this.#fail("device-downlink-queue-overflow", applicationCloseCode.backpressure);
      return;
    }
    const firstCopyBytes = Math.min(
      bytes.byteLength,
      this.#downlinkQueue.byteLength - this.#downlinkWriteOffset,
    );
    this.#downlinkQueue.set(bytes.subarray(0, firstCopyBytes), this.#downlinkWriteOffset);
    if (firstCopyBytes < bytes.byteLength) {
      this.#downlinkQueue.set(bytes.subarray(firstCopyBytes), 0);
    }
    this.#downlinkWriteOffset =
      (this.#downlinkWriteOffset + bytes.byteLength) % this.#downlinkQueue.byteLength;
    this.#downlinkQueuedBytes += bytes.byteLength;
    this.#scheduleDownlink();
  }

  #scheduleDownlink() {
    if (this.#closed || this.#suppressDownlink || this.#downlinkTimer !== undefined) {
      return;
    }
    if (!this.#downlinkStarted) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#sendDownlinkEndOfStream();
        return;
      }
      /*
       * Do not arm a media clock from a single rechunked frame. Waiting for the
       * fixed startup watermark is the one permitted latency reservoir; after
       * this transition, every missed 20 ms deadline is a generation failure,
       * never permission to pause and later replay old samples.
       *
       * A short finite response is allowed to start below the watermark once
       * `response.done` proves no more source bytes exist. Its final descriptor
       * is zero-padded and followed by the ordered EOS marker.
       */
      if (
        this.#downlinkQueuedBytes < this.#minimumDownlinkStartupBytes &&
        !(this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0)
      ) {
        return;
      }
      this.#downlinkStarted = true;
      this.#nextDownlinkAt = performance.now();
    }
    const hasCompleteFrame = this.#downlinkQueuedBytes >= this.#frameBytes;
    const hasFinalPartialFrame = this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0;
    if (!hasCompleteFrame && !hasFinalPartialFrame) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#sendDownlinkEndOfStream();
        return;
      }
      /*
       * Keep the next playout deadline armed even when the queue is currently
       * short. A source packet may arrive before it, but if it does not, the
       * callback below classifies the exact first audible underrun instead of
       * silently waiting for late PCM and resuming on a shifted clock.
       */
    }
    const delay = Math.max(0, this.#nextDownlinkAt - performance.now());
    this.#downlinkTimer = setTimeout(() => {
      this.#downlinkTimer = undefined;
      this.#sendNextDownlinkFrame();
    }, delay);
  }

  #sendNextDownlinkFrame() {
    if (this.#closed || this.#suppressDownlink) {
      return;
    }
    const hasCompleteFrame = this.#downlinkQueuedBytes >= this.#frameBytes;
    const hasFinalPartialFrame = this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0;
    if (!hasCompleteFrame && !hasFinalPartialFrame) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#sendDownlinkEndOfStream();
      } else {
        this.#fail("provider-downlink-source-underrun", applicationCloseCode.backpressure);
      }
      return;
    }
    const copiedBytes = Math.min(this.#frameBytes, this.#downlinkQueuedBytes);
    this.#downlinkFrame.fill(0);
    const firstCopyBytes = Math.min(
      copiedBytes,
      this.#downlinkQueue.byteLength - this.#downlinkReadOffset,
    );
    this.#downlinkFrame.set(
      this.#downlinkQueue.subarray(
        this.#downlinkReadOffset,
        this.#downlinkReadOffset + firstCopyBytes,
      ),
      0,
    );
    if (firstCopyBytes < copiedBytes) {
      this.#downlinkFrame.set(
        this.#downlinkQueue.subarray(0, copiedBytes - firstCopyBytes),
        firstCopyBytes,
      );
    }
    this.#downlinkReadOffset =
      (this.#downlinkReadOffset + copiedBytes) % this.#downlinkQueue.byteLength;
    this.#downlinkQueuedBytes -= copiedBytes;
    if (!this.#send(this.#device, this.#downlinkFrame)) {
      this.#fail("device-egress-backpressure", applicationCloseCode.backpressure);
      return;
    }
    this.#nextDownlinkAt = nextPcmFrameDeadline(
      this.#nextDownlinkAt,
      performance.now(),
      this.#frameDurationMs,
    );
    if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
      if (!this.#sendDownlinkEndOfStream()) return;
    }
    this.#scheduleDownlink();
  }

  #sendDownlinkEndOfStream() {
    if (!this.#send(this.#device, pcmEndOfStream)) {
      this.#fail("device-egress-backpressure", applicationCloseCode.backpressure);
      return false;
    }
    this.#downlinkResponseDone = false;
    this.#downlinkStarted = false;
    this.#nextDownlinkAt = 0;
    return true;
  }

  #clearDownlinkQueue() {
    if (this.#downlinkTimer !== undefined) {
      clearTimeout(this.#downlinkTimer);
      this.#downlinkTimer = undefined;
    }
    this.#downlinkQueuedBytes = 0;
    this.#downlinkReadOffset = 0;
    this.#downlinkResponseDone = false;
    this.#downlinkStarted = false;
    this.#downlinkWriteOffset = 0;
    this.#nextDownlinkAt = 0;
  }

  #send(socket: WebSocket, data: string | ArrayBufferView) {
    if (
      typeof socket.bufferedAmount === "number" &&
      socket.bufferedAmount > this.#maximumBufferedBytes
    ) {
      return false;
    }
    socket.send(data);
    return true;
  }

  #sendProviderControl(type: string) {
    return this.#sendProviderEvent({ type });
  }

  #sendProviderEvent(event: object) {
    if (this.#send(this.#provider, JSON.stringify(event))) {
      return true;
    }
    this.#fail("provider-egress-backpressure", applicationCloseCode.backpressure);
    return false;
  }

  #fail(reason: string, code: number) {
    if (this.#closed) return;
    this.#onFailure?.(reason);
    this.#closed = true;
    this.#clearDownlinkQueue();
    try {
      this.#device.close(code, reason);
    } catch {
      this.#onFailure?.("device-websocket-close-failed");
    }
    try {
      this.#provider.close(code, reason);
    } catch {
      this.#onFailure?.("provider-websocket-close-failed");
    } finally {
      this.#onClose(this);
    }
  }

  #closeFrom(event: CloseEvent, counterpart: WebSocket, origin: DevicePcmSocketClose["origin"]) {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearDownlinkQueue();
    const normal = event.code === 1000 || event.code === 1001;
    const relayable = event.code === 1000 || (event.code >= 3000 && event.code <= 4999);
    /*
     * Publish before asking the counterpart to close. A strict WebSocket
     * implementation may throw while relaying, but that must not erase the
     * actual peer event which caused this generation to end.
     */
    this.#onSocketClose?.({
      classification: normal ? "normal" : "unexpected",
      code: event.code,
      origin,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    try {
      counterpart.close(
        relayable ? event.code : applicationCloseCode.counterpartFailure,
        normal
          ? event.reason || "PCM counterpart disconnected normally."
          : "PCM counterpart disconnected unexpectedly.",
      );
    } catch {
      this.#onFailure?.("counterpart-websocket-close-failed");
    } finally {
      this.#onClose(this);
    }
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearDownlinkQueue();
    try {
      this.#device.close(1000, "PCM proxy session stopped.");
    } catch {
      this.#onFailure?.("device-websocket-close-failed");
    }
    try {
      this.#provider.close(1000, "PCM proxy session stopped.");
    } catch {
      this.#onFailure?.("provider-websocket-close-failed");
    } finally {
      this.#onClose(this);
    }
  }
}

function offeredProtocols(request: Request) {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requestBearerToken(request: Request, protocols: readonly string[]) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length);
    if (token && !token.includes(" ")) return token;
  }
  const bearerProtocol = protocols.find((protocol) =>
    protocol.startsWith(projectBearerProtocolPrefix),
  );
  if (!bearerProtocol) return undefined;
  const encoded = bearerProtocol.slice(projectBearerProtocolPrefix.length);
  try {
    const base64 = encoded
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function synchronousBinaryBytes(data: unknown) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}
