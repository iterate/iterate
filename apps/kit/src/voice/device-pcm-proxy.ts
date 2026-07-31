import { createWebSocketResponse, WebSocketPair } from "captun";
import { z } from "zod";
import { nextPcmFrameDeadline } from "./pcm-frame-pacer.ts";

export const ITERATE_KIT_PCM_SUBPROTOCOL = "iterate.kit.pcm.v1";
const projectBearerProtocolPrefix = "iterate-bearer.";
/*
 * Grok can synthesize a short response much faster than a speaker can consume
 * it: a measured 1.59-second response arrived in 235 ms, including one 20,552
 * byte WebSocket message. The userspace proxy must therefore retain generated
 * response audio independently of the much smaller device startup lead.
 *
 * Eight seconds is a bounded response reservoir, not permission to replay stale
 * conversation after an outage. Interruption clears it immediately, transport
 * failure destroys the generation, and overflow is terminal and observable.
 * Keeping this memory in userspace also avoids charging the ESP for provider
 * packetization. A future provider/device credit protocol can replace this
 * finite reservoir without changing the PCM frame contract.
 */
const defaultMaximumDownlinkFrames = 400;
/*
 * Provider message boundaries are not device playout boundaries. In
 * particular, the physical endurance source delivers 1,000 bytes every
 * 31.25 ms while the device consumes 640 bytes every 20 ms. Starting on the
 * first complete frame makes the pacer repeatedly run dry even though average
 * rates are identical. Three complete frames are the conservative 60 ms
 * default. Device-clocked hardware may explicitly choose a larger userspace
 * source watermark while retaining a smaller device lead; both remain inside
 * the fixed response reservoir and interruption still discards them together.
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

export interface PcmFrameObservation {
  /*
   * These are the two application wire boundaries, not claims about capture
   * or playout time. Uplink means the provider socket accepted the exact
   * device frame; downlink means the device socket accepted the exact padded
   * frame. A recorder must still correlate device metrics to prove when the
   * samples were captured or became audible.
   */
  bytes: Uint8Array;
  direction: "microphone-uplink" | "speaker-downlink";
  observedAtMonotonicMs: number;
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

export type DevicePcmDownlinkDeliveryMode = "device-clocked" | "host-paced";

export interface DevicePcmSessionDescriptor {
  id: string;
  inputMode: DevicePcmInputMode;
}

export interface DevicePcmProxyOptions {
  authenticate(projectId: string, bearerToken: string): boolean;
  connectProvider(session: DevicePcmSessionDescriptor): Promise<WebSocket>;
  /*
   * Source readiness and device lead are separate budgets. This value is the
   * number of already-generated frames sent immediately when device-clocked
   * playout begins. It is constrained by the device's bounded receive path and
   * must not exceed `minimumDownlinkStartupFrames`.
   *
   * The remaining source frames stay in userspace and cross the device socket
   * one per media deadline. Raising the source watermark can therefore absorb
   * provider packet jitter without increasing ESP RAM or its audible lead.
   */
  deviceClockedInitialBurstFrames?: number;
  /*
   * The speaker's I²S peripheral is the only clock that ultimately determines
   * when samples become audible. `device-clocked` primes a bounded lead on the
   * device, then replenishes it at the nominal media rate so provider bursts
   * cannot be mistaken for device capacity. The JavaScript deadline limits
   * ingress into the device; it does not claim to schedule audible samples.
   * `host-paced` retains the older comparison path, which starts with only one
   * frame and therefore provides no device-side scheduler-jitter reserve.
   *
   * Keeping this choice explicit is useful while physical tests compare both
   * models. It must not become an implicit fallback: changing clocks changes
   * latency, underrun classification, and where queue bounds are enforced.
   */
  downlinkDeliveryMode?: DevicePcmDownlinkDeliveryMode;
  frameBytes: number;
  frameDurationMs?: number;
  maximumBufferedBytes?: number;
  maximumDownlinkQueuedBytes?: number;
  /*
   * Provider WebSocket message boundaries are arbitrary transport batching,
   * not playout or freshness boundaries. This optional stricter guard may be
   * lower than the response reservoir, but never larger: a message that
   * cannot fit in an empty reservoir has no admissible state.
   */
  maximumProviderMessageBytes?: number;
  /*
   * This is the userspace source watermark, not the number of frames dumped to
   * the device. A completed response may start below it because `response.done`
   * proves there is no future source packet to wait for.
   */
  minimumDownlinkStartupFrames?: number;
  onFailure?(reason: string): void;
  onDownlinkResponseComplete?(observedAtMonotonicMs: number): void;
  /*
   * Diagnostic observers run only after the corresponding WebSocket send has
   * accepted a frame. They receive a borrowed view and must copy synchronously
   * if retaining it. Throwing disables the observer and reports one visible
   * failure; it never tears down or delays the realtime lane.
   */
  onPcmFrame?(frame: PcmFrameObservation): void;
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
  readonly #deviceClockedInitialBurstFrames: number;
  readonly #maximumDownlinkQueuedBytes: number;
  readonly #minimumDownlinkStartupFrames: number;
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
    if (
      options.deviceClockedInitialBurstFrames !== undefined &&
      (!Number.isSafeInteger(options.deviceClockedInitialBurstFrames) ||
        options.deviceClockedInitialBurstFrames <= 0)
    ) {
      throw new Error("PCM device-clocked initial burst must contain whole positive frames.");
    }
    if (
      options.deviceClockedInitialBurstFrames !== undefined &&
      options.downlinkDeliveryMode !== "device-clocked"
    ) {
      throw new Error("PCM device-clocked initial burst requires device-clocked delivery.");
    }
    const maximumDownlinkQueuedBytes =
      options.maximumDownlinkQueuedBytes ?? options.frameBytes * defaultMaximumDownlinkFrames;
    if (
      options.maximumProviderMessageBytes !== undefined &&
      (!Number.isSafeInteger(options.maximumProviderMessageBytes) ||
        options.maximumProviderMessageBytes < 2 ||
        options.maximumProviderMessageBytes > maximumDownlinkQueuedBytes)
    ) {
      throw new Error("A provider PCM message limit must fit inside the bounded downlink queue.");
    }
    const minimumDownlinkStartupFrames =
      options.minimumDownlinkStartupFrames ??
      Math.min(
        defaultMinimumDownlinkStartupFrames,
        Math.floor(maximumDownlinkQueuedBytes / options.frameBytes),
      );
    if (
      minimumDownlinkStartupFrames > Math.floor(maximumDownlinkQueuedBytes / options.frameBytes)
    ) {
      throw new Error("PCM downlink startup must fit inside the bounded downlink queue.");
    }
    const deviceClockedInitialBurstFrames =
      options.deviceClockedInitialBurstFrames ?? minimumDownlinkStartupFrames;
    if (deviceClockedInitialBurstFrames > minimumDownlinkStartupFrames) {
      throw new Error(
        "PCM device-clocked initial burst must not exceed the source startup reservoir.",
      );
    }
    this.#deviceClockedInitialBurstFrames = deviceClockedInitialBurstFrames;
    this.#maximumDownlinkQueuedBytes = maximumDownlinkQueuedBytes;
    this.#minimumDownlinkStartupFrames = minimumDownlinkStartupFrames;
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
    const session = new DevicePcmProxySession({
      device: proxySocket,
      deviceClockedInitialBurstBytes:
        this.#options.frameBytes * this.#deviceClockedInitialBurstFrames,
      downlinkDeliveryMode: this.#options.downlinkDeliveryMode ?? "host-paced",
      frameBytes: this.#options.frameBytes,
      frameDurationMs: this.#options.frameDurationMs ?? 20,
      inputMode: descriptor.inputMode,
      maximumBufferedBytes: this.#options.maximumBufferedBytes ?? this.#options.frameBytes * 8,
      /*
       * The response reservoir is already the explicit memory/freshness
       * bound. A second, smaller magic number cut a real 73,400-byte Grok
       * message mid-sentence even though the complete packet fit safely here.
       * Defaulting to the same bound removes that false protocol constraint
       * without allocating a byte more or admitting an unbounded backlog.
       */
      maximumProviderMessageBytes:
        this.#options.maximumProviderMessageBytes ?? this.#maximumDownlinkQueuedBytes,
      maximumDownlinkQueuedBytes: this.#maximumDownlinkQueuedBytes,
      minimumDownlinkStartupBytes: this.#options.frameBytes * this.#minimumDownlinkStartupFrames,
      onClose: (closed) => {
        if (this.#sessions.get(descriptor.id) === closed) {
          this.#sessions.delete(descriptor.id);
        }
      },
      onFailure: this.#options.onFailure,
      onDownlinkResponseComplete: this.#options.onDownlinkResponseComplete,
      onPcmFrame: this.#options.onPcmFrame,
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
  deviceClockedInitialBurstBytes: number;
  downlinkDeliveryMode: DevicePcmDownlinkDeliveryMode;
  frameBytes: number;
  frameDurationMs: number;
  inputMode: DevicePcmInputMode;
  maximumBufferedBytes: number;
  maximumDownlinkQueuedBytes: number;
  maximumProviderMessageBytes: number;
  minimumDownlinkStartupBytes: number;
  onClose(session: DevicePcmProxySession): void;
  onFailure?: DevicePcmProxyOptions["onFailure"];
  onDownlinkResponseComplete?: DevicePcmProxyOptions["onDownlinkResponseComplete"];
  onPcmFrame?: DevicePcmProxyOptions["onPcmFrame"];
  onProviderEvent?: DevicePcmProxyOptions["onProviderEvent"];
  onSocketClose?: DevicePcmProxyOptions["onSocketClose"];
  provider: WebSocket;
}

class DevicePcmProxySession implements Disposable {
  readonly #device: WebSocket;
  readonly #deviceClockedInitialBurstBytes: number;
  readonly #downlinkDeliveryMode: DevicePcmDownlinkDeliveryMode;
  readonly #downlinkQueue: Uint8Array;
  readonly #frameBytes: number;
  readonly #frameDurationMs: number;
  readonly #inputMode: DevicePcmInputMode;
  readonly #maximumBufferedBytes: number;
  readonly #maximumProviderMessageBytes: number;
  readonly #minimumDownlinkStartupBytes: number;
  readonly #onClose: DevicePcmProxySessionOptions["onClose"];
  readonly #onFailure: DevicePcmProxySessionOptions["onFailure"];
  readonly #onDownlinkResponseComplete: DevicePcmProxySessionOptions["onDownlinkResponseComplete"];
  readonly #onPcmFrame: DevicePcmProxySessionOptions["onPcmFrame"];
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
  #pcmObserverFailed = false;
  #responseActive = false;
  #responseRequested = false;
  #suppressDownlink = false;
  #providerBlobConversion: Promise<void> | undefined;
  #closed = false;

  constructor(options: DevicePcmProxySessionOptions) {
    this.#device = options.device;
    this.#deviceClockedInitialBurstBytes = options.deviceClockedInitialBurstBytes;
    this.#downlinkDeliveryMode = options.downlinkDeliveryMode;
    this.#downlinkQueue = new Uint8Array(options.maximumDownlinkQueuedBytes);
    this.#frameBytes = options.frameBytes;
    this.#frameDurationMs = options.frameDurationMs;
    this.#inputMode = options.inputMode;
    this.#maximumBufferedBytes = options.maximumBufferedBytes;
    this.#maximumProviderMessageBytes = options.maximumProviderMessageBytes;
    this.#minimumDownlinkStartupBytes = options.minimumDownlinkStartupBytes;
    this.#onClose = options.onClose;
    this.#onFailure = options.onFailure;
    this.#onDownlinkResponseComplete = options.onDownlinkResponseComplete;
    this.#onPcmFrame = options.onPcmFrame;
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
      return;
    }
    this.#observePcmFrame("microphone-uplink", bytes);
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
    if (!(data instanceof Blob) || data.size === 0 || data.size % 2 !== 0) {
      this.#fail("invalid-provider-pcm-message", applicationCloseCode.protocolError);
      return;
    }
    if (data.size > this.#maximumProviderMessageBytes) {
      /*
       * Oversized but otherwise valid PCM is a bounded-resource outcome, not
       * malformed protocol. Keeping that distinction in the close reason is
       * what lets a physical run attribute a capacity miss without blaming
       * xAI's codec or silently weakening the memory limit.
       */
      this.#fail("provider-pcm-message-budget-exceeded", applicationCloseCode.backpressure);
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
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
      this.#fail("invalid-provider-pcm-message", applicationCloseCode.protocolError);
      return;
    }
    if (bytes.byteLength > this.#maximumProviderMessageBytes) {
      this.#fail("provider-pcm-message-budget-exceeded", applicationCloseCode.backpressure);
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
      if (this.#downlinkDeliveryMode === "device-clocked") {
        /*
         * Prime a finite hardware lead, not the whole provider message. Grok
         * packet boundaries have no timing meaning and can contain hundreds of
         * milliseconds of samples. Dumping one such packet synchronously into
         * WebSocket/TCP would recreate an opaque backlog below this queue and
         * can overflow the Stick before I2S consumes its first descriptor.
         *
         * The userspace source watermark can be materially larger than this
         * device lead. Conflating them would force us to choose between
         * provider-jitter tolerance and overflowing the Stick's receive path.
         * A completed shorter response is the sole exception; its final
         * partial frame is padded by sendQueuedDownlinkFrame(), exactly as in
         * host-paced mode.
         */
        const startupFrameCount = Math.ceil(
          Math.min(this.#downlinkQueuedBytes, this.#deviceClockedInitialBurstBytes) /
            this.#frameBytes,
        );
        for (let frame = 0; frame < startupFrameCount; frame += 1) {
          if (!this.#sendQueuedDownlinkFrame()) {
            this.#fail("device-egress-backpressure", applicationCloseCode.backpressure);
            return;
          }
        }
        this.#nextDownlinkAt = performance.now() + this.#frameDurationMs;
      } else {
        this.#nextDownlinkAt = performance.now();
      }
    }
    if (this.#downlinkDeliveryMode === "device-clocked") {
      this.#scheduleDeviceClockedDownlink();
      return;
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
    if (!this.#sendQueuedDownlinkFrame()) {
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

  /*
   * Once primed, send at most one frame per deadline. This is flow shaping at
   * the userspace/device boundary, not a second claim about playout time: I2S
   * still consumes the already-queued lead on its own clock, and firmware
   * metrics remain authoritative for receive-to-audible delay and underrun.
   *
   * If provider ingress temporarily runs dry, do not invent a host underrun or
   * shift a retained FIFO. The device consumes its finite lead and applies its
   * own freshness/reset policy. A later provider packet resumes from the old
   * deadline (immediately if overdue) without a catch-up burst.
   */
  #scheduleDeviceClockedDownlink() {
    const hasCompleteFrame = this.#downlinkQueuedBytes >= this.#frameBytes;
    const hasFinalPartialFrame = this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0;
    if (!hasCompleteFrame && !hasFinalPartialFrame) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#sendDownlinkEndOfStream();
      }
      return;
    }
    const delay = Math.max(0, this.#nextDownlinkAt - performance.now());
    this.#downlinkTimer = setTimeout(() => {
      this.#downlinkTimer = undefined;
      this.#sendNextDeviceClockedDownlinkFrame();
    }, delay);
  }

  #sendNextDeviceClockedDownlinkFrame() {
    if (this.#closed || this.#suppressDownlink) return;
    const hasCompleteFrame = this.#downlinkQueuedBytes >= this.#frameBytes;
    const hasFinalPartialFrame = this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0;
    if (!hasCompleteFrame && !hasFinalPartialFrame) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#sendDownlinkEndOfStream();
      }
      return;
    }
    if (!this.#sendQueuedDownlinkFrame()) {
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

  /*
   * Copy before sending because the ring may wrap and because the final source
   * message may be shorter than one device frame. The output frame is
   * deliberately owned and never mutated after `send()`: Workers WebSockets
   * snapshot typed arrays, but standards-shaped local peers may retain the
   * view until an asynchronous message event. Reusing one scratch frame would
   * make a burst of speech arrive as repeated copies of its final 20 ms.
   *
   * This allocation occurs in the userspace proxy, not on the ESP realtime
   * path. Its rate is one bounded allocation per actual wire frame; the
   * WebSocket transport must retain equivalent bytes in either case.
   */
  #sendQueuedDownlinkFrame() {
    const copiedBytes = Math.min(this.#frameBytes, this.#downlinkQueuedBytes);
    if (copiedBytes === 0) {
      return false;
    }
    const downlinkFrame = new Uint8Array(this.#frameBytes);
    const firstCopyBytes = Math.min(
      copiedBytes,
      this.#downlinkQueue.byteLength - this.#downlinkReadOffset,
    );
    downlinkFrame.set(
      this.#downlinkQueue.subarray(
        this.#downlinkReadOffset,
        this.#downlinkReadOffset + firstCopyBytes,
      ),
      0,
    );
    if (firstCopyBytes < copiedBytes) {
      downlinkFrame.set(
        this.#downlinkQueue.subarray(0, copiedBytes - firstCopyBytes),
        firstCopyBytes,
      );
    }
    this.#downlinkReadOffset =
      (this.#downlinkReadOffset + copiedBytes) % this.#downlinkQueue.byteLength;
    this.#downlinkQueuedBytes -= copiedBytes;
    const sent = this.#send(this.#device, downlinkFrame);
    if (sent) this.#observePcmFrame("speaker-downlink", downlinkFrame);
    return sent;
  }

  #observePcmFrame(direction: PcmFrameObservation["direction"], bytes: Uint8Array) {
    if (!this.#onPcmFrame || this.#pcmObserverFailed) return;
    try {
      this.#onPcmFrame({
        bytes,
        direction,
        observedAtMonotonicMs: performance.now(),
      });
    } catch {
      /*
       * Evidence collection must never become an audio transport dependency.
       * Disable a broken observer after one report so a disk/diagnostic bug
       * cannot create per-frame exception load or disconnect a healthy call.
       */
      this.#pcmObserverFailed = true;
      this.#onFailure?.("pcm-frame-observer-failed");
    }
  }

  #sendDownlinkEndOfStream() {
    if (!this.#send(this.#device, pcmEndOfStream)) {
      this.#fail("device-egress-backpressure", applicationCloseCode.backpressure);
      return false;
    }
    this.#downlinkResponseDone = false;
    this.#downlinkStarted = false;
    this.#nextDownlinkAt = 0;
    this.#onDownlinkResponseComplete?.(performance.now());
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
