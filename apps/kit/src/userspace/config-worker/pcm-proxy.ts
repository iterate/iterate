export const ITERATE_KIT_PCM_FRAME_BYTES = 640;
export const ITERATE_KIT_PCM_SAMPLE_RATE_HZ = 16_000;
export const ITERATE_KIT_PCM_SUBPROTOCOL = "iterate.kit.pcm.v1";

/*
 * These bounds describe three different queues and must never be collapsed
 * into one magic number:
 *
 * - 400 frames / eight seconds is the userspace response reservoir. Grok can
 *   synthesize speech much faster than a loudspeaker consumes it, so retaining
 *   that burst in the Durable Object is necessary even though replay after an
 *   outage is forbidden. Interruption and socket failure discard it in one
 *   operation; overflow is terminal and visible.
 * - 32 frames / 640 ms is the source-readiness watermark. A physical Grok run
 *   measured a 203.28 ms gap between provider packets, so the smaller hardware
 *   lead is not enough to prove that userspace has a continuous source.
 * - eight frames / 160 ms is the finite lead admitted to the Stick at startup.
 *   Subsequent frames cross the socket one per 20 ms media deadline. This is
 *   deliberately no larger than the firmware's measured receive/playback
 *   budget and therefore does not move the provider's burst into TCP or ESP
 *   RAM.
 */
const DOWNLINK_RESPONSE_RESERVOIR_FRAMES = 400;
const DOWNLINK_SOURCE_STARTUP_FRAMES = 32;
const DEVICE_INITIAL_LEAD_FRAMES = 8;
const PCM_FRAME_DURATION_MS = 20;
/*
 * This is not an audio queue timeout. It bounds how long two independently
 * delivered facts may disagree after PTT release: the Cap'n Web stop event and
 * the empty marker ordered behind the last PCM frame. Healthy delivery is a few
 * milliseconds; 1.5 seconds tolerates control/media scheduling skew while
 * ensuring a lost marker cannot leave a Grok input buffer open indefinitely.
 */
const UPLINK_END_MARKER_TIMEOUT_MS = 1_500;
const MAXIMUM_FUNCTION_CALLS_PER_RESPONSE = 8;
const MAXIMUM_FUNCTION_ARGUMENT_BYTES = 2_048;
const pcmEndOfResponse = new Uint8Array(0);

export interface ProviderFunctionCall {
  arguments: string;
  callId: string;
  name: string;
}

/** One exact text frame from the provider control lane; PCM never enters it. */
export interface ProviderNonPcmEvent {
  event: unknown;
  raw: string;
  type: string | null;
}

export interface PcmProxyDiagnostic {
  code:
    | "device-closed"
    | "downlink-overflow"
    | "empty-uplink-turn"
    | "invalid-device-frame"
    | "provider-closed"
    | "provider-event"
    | "provider-function-call-failed"
    | "provider-send-failed"
    | "provider-unavailable"
    | "socket-error"
    | "uplink-backpressure"
    | "uplink-end-marker-timeout"
    | "uplink-frame-after-end-marker"
    | "uplink-turn-overlap";
  detail?: unknown;
  droppedBytes?: number;
  sessionId: string;
  severity: "debug" | "error" | "info" | "warn";
}

export interface PcmSessionMetrics {
  awaitingCommitAcknowledgement: boolean;
  awaitingUplinkEndMarker: boolean;
  closed: boolean;
  downlinkDroppedBytes: number;
  downlinkFrames: number;
  downlinkPartialBytes: number;
  downlinkQueuedBytes: number;
  downlinkQueueHighWaterBytes: number;
  emptyUplinkTurns: number;
  interrupted: boolean;
  lastProviderError: { code: string | null; message: string | null } | null;
  lastProviderEventType: string | null;
  lastSocketClose: {
    code: number;
    reason: string;
    source: "device" | "provider";
  } | null;
  providerAvailable: boolean;
  providerCommitMessagesSent: number;
  providerConnections: number;
  providerControlEvents: number;
  providerControlMessagesSent: number;
  providerBufferedBytes: number;
  providerDisconnects: number;
  providerFunctionCallFailures: number;
  providerFunctionCalls: number;
  providerFunctionCallsPending: number;
  providerKeepalivePings: number;
  providerKeepalivePongs: number;
  providerPcmPeakSample: number;
  providerPcmRmsSample: number;
  providerPcmSamples: number;
  providerResponseActive: boolean;
  providerResponseCreateMessagesSent: number;
  providerResponsesCompleted: number;
  providerSendFailures: number;
  uplinkDroppedBytes: number;
  uplinkEndMarkers: number;
  uplinkEndMarkerTimeouts: number;
  uplinkFrames: number;
  uplinkFramesAfterEndMarkerDropped: number;
  uplinkUnavailableFrames: number;
}

export interface PcmSessionBridgeOptions {
  device: WebSocket;
  maximumSocketBufferedBytes: number;
  onDiagnostic?: (diagnostic: PcmProxyDiagnostic) => void;
  onProviderEvent?: (event: ProviderNonPcmEvent) => void;
  onProviderFunctionCall?: (call: ProviderFunctionCall) => Promise<unknown>;
  onProviderUnavailable?: () => void;
  provider: WebSocket;
  sessionId: string;
}

/**
 * One deliberately small real-time bridge between a device socket and a
 * provider socket.
 *
 * The key asymmetric design choice is what is absent: there is no microphone
 * queue. A valid 20 ms microphone frame either enters the provider's current
 * socket immediately or is dropped with a visible freshness failure. Speaker
 * audio is different because a provider may legally synthesize seconds of PCM
 * in one burst. One fixed userspace ring absorbs that source packetization,
 * while a 20 ms admission clock prevents the burst from becoming an invisible
 * WebSocket/TCP/device queue. The I2S peripheral remains the authoritative
 * playout clock; this timer only limits how fast userspace can feed its finite
 * lead.
 */
export class PcmSessionBridge {
  readonly #device: WebSocket;
  readonly #maximumSocketBufferedBytes: number;
  readonly #onDiagnostic: (diagnostic: PcmProxyDiagnostic) => void;
  readonly #onProviderEvent: (event: ProviderNonPcmEvent) => void;
  readonly #onProviderFunctionCall: (call: ProviderFunctionCall) => Promise<unknown>;
  readonly #onProviderUnavailable: () => void;
  readonly #sessionId: string;
  readonly #downlinkQueue = new Uint8Array(
    ITERATE_KIT_PCM_FRAME_BYTES * DOWNLINK_RESPONSE_RESERVOIR_FRAMES,
  );
  #closed = false;
  #awaitingUplinkEndMarker = false;
  #downlinkDroppedBytes = 0;
  #downlinkFrames = 0;
  #downlinkQueuedBytes = 0;
  #downlinkQueueHighWaterBytes = 0;
  #downlinkReadOffset = 0;
  #downlinkResponseDone = false;
  #downlinkStarted = false;
  #downlinkTimer: ReturnType<typeof setTimeout> | undefined;
  #downlinkWriteOffset = 0;
  #emptyUplinkTurns = 0;
  #interrupted = false;
  #lastProviderError: PcmSessionMetrics["lastProviderError"] = null;
  #lastProviderEventType: string | null = null;
  #lastSocketClose: PcmSessionMetrics["lastSocketClose"] = null;
  #provider: WebSocket | undefined;
  #providerCommitMessagesSent = 0;
  #providerConnections = 0;
  #providerControlEvents = 0;
  #providerControlMessagesSent = 0;
  #providerDisconnects = 0;
  #providerFunctionCallFailures = 0;
  #providerFunctionCalls = 0;
  #providerKeepalivePings = 0;
  #providerKeepalivePongs = 0;
  #providerPcmNormalizedSquareSum = 0;
  #providerPcmPeakSample = 0;
  #providerPcmSamples = 0;
  #providerPcmTrailingByte: number | undefined;
  #providerResponseEpoch = 0;
  #providerResponseFunctionCallIds = new Set<string>();
  #providerResponseFunctionCallsPending = 0;
  #providerResponseFunctionCallsSeen = 0;
  #providerResponseHadPcm = false;
  #providerResponseDone = false;
  #providerResponsePlaybackFinished = false;
  #providerResponseCreateMessagesSent = 0;
  #providerResponsesCompleted = 0;
  #providerSendFailures = 0;
  #responseAfterCommitPending = false;
  #responseActive = false;
  #nextDownlinkAt = 0;
  #uplinkDroppedBytes = 0;
  #uplinkEndMarkerSeen = false;
  #uplinkEndMarkers = 0;
  #uplinkEndMarkerTimeouts = 0;
  #uplinkEndMarkerTimer: ReturnType<typeof setTimeout> | undefined;
  #uplinkFrames = 0;
  #uplinkFramesInTurn = 0;
  #uplinkFramesAfterEndMarkerDropped = 0;
  #uplinkUnavailableFrames = 0;

  constructor(options: PcmSessionBridgeOptions) {
    if (
      !Number.isSafeInteger(options.maximumSocketBufferedBytes) ||
      options.maximumSocketBufferedBytes < ITERATE_KIT_PCM_FRAME_BYTES ||
      options.maximumSocketBufferedBytes > 256 * 1_024
    ) {
      throw new Error("The PCM socket backlog limit must be from one frame through 256 KiB.");
    }
    this.#device = options.device;
    this.#maximumSocketBufferedBytes = options.maximumSocketBufferedBytes;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onProviderEvent = options.onProviderEvent ?? (() => undefined);
    this.#onProviderFunctionCall =
      options.onProviderFunctionCall ??
      (async () => {
        throw new Error("No userspace device tool handler is installed.");
      });
    this.#onProviderUnavailable = options.onProviderUnavailable ?? (() => undefined);
    this.#sessionId = options.sessionId;
    this.#device.binaryType = "arraybuffer";

    this.#device.addEventListener("message", (event) => {
      this.#handleDeviceMessage(event.data);
    });
    this.#device.addEventListener("close", (event) => {
      this.#lastSocketClose ??= {
        code: event.code,
        reason: event.reason,
        source: "device",
      };
      this.#diagnostic("device-closed", "info", {
        code: event.code,
        reason: event.reason,
      });
      this.close(1000, "Device socket closed.");
    });
    this.#device.addEventListener("error", () => {
      this.#fail("socket-error", "PCM WebSocket emitted an error.");
    });
    this.attachProvider(options.provider);
  }

  metrics(): PcmSessionMetrics {
    return {
      awaitingCommitAcknowledgement: this.#responseAfterCommitPending,
      awaitingUplinkEndMarker: this.#awaitingUplinkEndMarker,
      closed: this.#closed,
      downlinkDroppedBytes: this.#downlinkDroppedBytes,
      downlinkFrames: this.#downlinkFrames,
      downlinkPartialBytes: this.#downlinkQueuedBytes % ITERATE_KIT_PCM_FRAME_BYTES,
      downlinkQueuedBytes: this.#downlinkQueuedBytes,
      downlinkQueueHighWaterBytes: this.#downlinkQueueHighWaterBytes,
      emptyUplinkTurns: this.#emptyUplinkTurns,
      interrupted: this.#interrupted,
      lastProviderError: this.#lastProviderError,
      lastProviderEventType: this.#lastProviderEventType,
      lastSocketClose: this.#lastSocketClose,
      providerAvailable: this.#provider !== undefined && socketIsOpen(this.#provider),
      providerCommitMessagesSent: this.#providerCommitMessagesSent,
      providerConnections: this.#providerConnections,
      providerControlEvents: this.#providerControlEvents,
      providerControlMessagesSent: this.#providerControlMessagesSent,
      providerBufferedBytes: this.#provider ? socketBufferedAmount(this.#provider) : 0,
      providerDisconnects: this.#providerDisconnects,
      providerFunctionCallFailures: this.#providerFunctionCallFailures,
      providerFunctionCalls: this.#providerFunctionCalls,
      providerFunctionCallsPending: this.#providerResponseFunctionCallsPending,
      providerKeepalivePings: this.#providerKeepalivePings,
      providerKeepalivePongs: this.#providerKeepalivePongs,
      providerPcmPeakSample: this.#providerPcmPeakSample,
      providerPcmRmsSample:
        this.#providerPcmSamples === 0
          ? 0
          : Math.sqrt(this.#providerPcmNormalizedSquareSum / this.#providerPcmSamples) * 32_768,
      providerPcmSamples: this.#providerPcmSamples,
      providerResponseActive: this.#responseActive,
      providerResponseCreateMessagesSent: this.#providerResponseCreateMessagesSent,
      providerResponsesCompleted: this.#providerResponsesCompleted,
      providerSendFailures: this.#providerSendFailures,
      uplinkDroppedBytes: this.#uplinkDroppedBytes,
      uplinkEndMarkers: this.#uplinkEndMarkers,
      uplinkEndMarkerTimeouts: this.#uplinkEndMarkerTimeouts,
      uplinkFrames: this.#uplinkFrames,
      uplinkFramesAfterEndMarkerDropped: this.#uplinkFramesAfterEndMarkerDropped,
      uplinkUnavailableFrames: this.#uplinkUnavailableFrames,
    };
  }

  /**
   * Installs a fresh upstream generation without disturbing the device lane.
   *
   * Provider sockets are disposable conversations. The physical `/pcm`
   * socket is instead the stable realtime route owned by the device. Keeping
   * replacement at this boundary prevents an idle provider timeout from
   * forcing Wi-Fi/TLS churn and, critically, lets queued events from the old
   * socket be rejected by identity rather than mistaken for current speech.
   */
  attachProvider(provider: WebSocket): boolean {
    if (this.#closed) {
      if (socketIsOpenOrConnecting(provider)) {
        provider.close(1000, "The device PCM lane has ended.");
      }
      return false;
    }

    const previous = this.#provider;
    this.#provider = undefined;
    if (previous && socketIsOpenOrConnecting(previous)) {
      previous.close(1000, "A fresh provider generation replaced this one.");
    }

    provider.binaryType = "arraybuffer";
    this.#provider = provider;
    this.#providerConnections += 1;
    /*
     * A replacement provider has an empty input buffer even if its predecessor
     * received frames from the current physical press. Retaining the old count
     * would commit an empty buffer on the new generation. The media socket is
     * stable, but provider-buffer ownership is generation-scoped.
     */
    this.#uplinkFramesInTurn = 0;
    this.#abandonProviderResponse();
    provider.addEventListener("message", (event) => {
      /*
       * `binaryType = "arraybuffer"` is part of the socket contract above.
       * Handling that value synchronously is important: chaining promises here
       * would itself become an invisible queue of provider MessageEvents and
       * their audio payloads under load. The socket identity check is the
       * reconnect generation fence.
       */
      if (this.#provider === provider) this.#handleProviderMessage(provider, event.data);
    });
    provider.addEventListener("close", (event) => {
      this.#detachProvider(provider, event.code, event.reason, "provider-closed");
    });
    provider.addEventListener("error", () => {
      if (this.#provider !== provider) return;
      this.#diagnostic("socket-error", "error", "Provider WebSocket emitted an error.");
      this.#detachProvider(provider, 1011, "Provider WebSocket emitted an error.", "socket-error");
      if (socketIsOpenOrConnecting(provider)) {
        provider.close(1011, "Provider WebSocket emitted an error.");
      }
    });
    return true;
  }

  inputStarted(): boolean {
    if (this.#closed) return false;
    if (!this.#provider || !socketIsOpen(this.#provider)) {
      this.#onProviderUnavailable();
      return false;
    }
    if (this.#awaitingUplinkEndMarker) {
      /*
       * A new capture cannot safely reuse this socket until the prior turn's
       * ordered marker arrives. Treating the next marker as the new turn's end
       * would drop fresh speech; ignoring it would let the old tail leak into
       * the new Grok buffer. Replacing one ambiguous realtime generation is
       * safer and bounded, and the explicit diagnostic distinguishes this from
       * provider/network unavailability.
       */
      this.#fail(
        "uplink-turn-overlap",
        "A new PTT turn began before the prior PCM end marker arrived.",
      );
      return false;
    }
    this.#uplinkEndMarkerSeen = false;
    this.#uplinkFramesInTurn = 0;
    /*
     * A new press supersedes any released turn that Grok has not acknowledged
     * yet. Remembering one boolean is enough: keeping the stale request would
     * let a delayed control-plane acknowledgement start speech over the new
     * microphone turn, while queuing the turns would violate realtime
     * semantics and grow without a useful bound.
     */
    this.#responseAfterCommitPending = false;
    this.#interrupted = true;
    this.#discardDownlinkQueue();
    const responseWasActive = this.#responseActive;
    this.#abandonProviderResponse();
    /*
     * `response.cancel` is not an idempotent "ensure silence" command. Grok
     * Voice 2.0 can reject it when no response exists, which needlessly kills
     * the first PTT generation before any microphone audio is useful. Only an
     * observed provider response may be cancelled; entering capture state for
     * the first turn is otherwise entirely local.
     */
    return !responseWasActive || this.#sendProviderControl("response.cancel");
  }

  inputStopped(): boolean {
    if (this.#closed) return false;
    if (!this.#provider || !socketIsOpen(this.#provider)) {
      this.#onProviderUnavailable();
      return false;
    }
    this.#interrupted = false;
    /*
     * Grok confirms that the manual-turn audio buffer became a conversation
     * item asynchronously. `response.create` belongs after that confirmation;
     * sending both controls back-to-back races provider state and was observed
     * to close an otherwise healthy production generation after PTT release.
     * This is a control-plane fence only—PCM still travels immediately and no
     * audio or turn queue is introduced.
     */
    if (this.#uplinkEndMarkerSeen) return this.#finishInputTurn();
    this.#awaitingUplinkEndMarker = true;
    this.#uplinkEndMarkerTimer = setTimeout(() => {
      this.#uplinkEndMarkerTimer = undefined;
      if (this.#closed || !this.#awaitingUplinkEndMarker) return;
      this.#awaitingUplinkEndMarker = false;
      this.#uplinkEndMarkerTimeouts += 1;
      this.#fail(
        "uplink-end-marker-timeout",
        "The ordered PCM end marker did not arrive after PTT release.",
      );
    }, UPLINK_END_MARKER_TIMEOUT_MS);
    return true;
  }

  close(code = 1000, reason = "PCM session ended."): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearUplinkEndMarkerWait();
    this.#responseAfterCommitPending = false;
    this.#abandonProviderResponse();
    this.#discardDownlinkQueue();
    const provider = this.#provider;
    this.#provider = undefined;
    if (socketIsOpenOrConnecting(this.#device)) {
      this.#device.close(code, reason);
    }
    if (provider && socketIsOpenOrConnecting(provider)) {
      provider.close(code, reason);
    }
  }

  #handleDeviceMessage(data: unknown): void {
    if (this.#closed) return;
    const bytes = binaryBytes(data);
    if (bytes?.byteLength === 0) {
      this.#handleUplinkEndMarker();
      return;
    }
    if (!bytes || bytes.byteLength !== ITERATE_KIT_PCM_FRAME_BYTES) {
      const droppedBytes = bytes?.byteLength ?? 0;
      this.#uplinkDroppedBytes += droppedBytes;
      this.#fail(
        "invalid-device-frame",
        `Device PCM messages must contain exactly ${ITERATE_KIT_PCM_FRAME_BYTES} bytes.`,
        droppedBytes,
      );
      return;
    }
    if (this.#uplinkEndMarkerSeen) {
      /*
       * FIFO ordering makes this a concrete contradiction: no audio from the
       * just-ended turn can legally follow its marker, and the next turn is
       * not open until inputStarted() clears the fence. Drop rather than close
       * so one late callback remains diagnosable without destroying an
       * otherwise healthy provider conversation.
       */
      this.#uplinkDroppedBytes += bytes.byteLength;
      this.#uplinkFramesAfterEndMarkerDropped += 1;
      this.#diagnostic(
        "uplink-frame-after-end-marker",
        "warn",
        "A microphone frame arrived after its turn's ordered end marker.",
        bytes.byteLength,
      );
      return;
    }
    const provider = this.#provider;
    if (!provider || !socketIsOpen(provider)) {
      this.#uplinkDroppedBytes += bytes.byteLength;
      this.#uplinkUnavailableFrames += 1;
      this.#diagnostic(
        "provider-unavailable",
        "warn",
        "The live microphone frame was discarded because no provider generation was available.",
        bytes.byteLength,
      );
      return;
    }
    if (socketBufferedAmount(provider) + bytes.byteLength > this.#maximumSocketBufferedBytes) {
      this.#uplinkDroppedBytes += bytes.byteLength;
      this.#fail(
        "uplink-backpressure",
        "Provider egress could not accept the current microphone frame.",
        bytes.byteLength,
      );
      return;
    }
    try {
      provider.send(bytes);
    } catch (error) {
      /*
       * OPEN is only a sampled socket state; a synchronous send may still be
       * the first operation to discover a dead provider generation. The live
       * microphone frame cannot be retried without creating delayed speech,
       * but that upstream failure says nothing about the independently useful
       * device socket. Drop this one frame visibly, fence the provider object,
       * and let the owner establish a fresh upstream generation.
       */
      this.#uplinkDroppedBytes += bytes.byteLength;
      this.#uplinkUnavailableFrames += 1;
      this.#handleProviderSendFailure(provider, error, "pcm", bytes.byteLength);
      return;
    }
    this.#uplinkFrames += 1;
    this.#uplinkFramesInTurn += 1;
  }

  #handleUplinkEndMarker(): void {
    if (this.#uplinkEndMarkerSeen) {
      this.#fail(
        "invalid-device-frame",
        "The device sent two PCM end markers without beginning another turn.",
      );
      return;
    }
    this.#uplinkEndMarkerSeen = true;
    this.#uplinkEndMarkers += 1;
    if (!this.#awaitingUplinkEndMarker) return;
    this.#finishInputTurn();
  }

  #finishInputTurn(): boolean {
    const frames = this.#uplinkFramesInTurn;
    this.#uplinkFramesInTurn = 0;
    this.#clearUplinkEndMarkerWait();
    if (frames !== 0) return this.#commitInputTurn();

    /*
     * The firmware preserves quick start/stop pairs as marker-only turns so a
     * successful remote action is never scheduler-dependent. That is a valid
     * device event but not valid provider input: an empty Grok commit may be
     * rejected and disconnect an otherwise healthy conversation. Classify and
     * absorb it here without synthesising a response or hiding the gesture.
     */
    this.#emptyUplinkTurns += 1;
    this.#responseAfterCommitPending = false;
    this.#diagnostic(
      "empty-uplink-turn",
      "info",
      "The completed manual PTT turn contained no microphone frames and was not committed.",
    );
    return true;
  }

  #commitInputTurn(): boolean {
    const provider = this.#provider;
    if (this.#closed || !provider || !socketIsOpen(provider)) {
      this.#onProviderUnavailable();
      return false;
    }
    this.#clearUplinkEndMarkerWait();
    this.#responseAfterCommitPending = true;
    if (this.#sendProviderControl("input_audio_buffer.commit")) return true;
    this.#responseAfterCommitPending = false;
    return false;
  }

  #clearUplinkEndMarkerWait(): void {
    this.#awaitingUplinkEndMarker = false;
    if (this.#uplinkEndMarkerTimer === undefined) return;
    clearTimeout(this.#uplinkEndMarkerTimer);
    this.#uplinkEndMarkerTimer = undefined;
  }

  #handleProviderMessage(provider: WebSocket, data: unknown): void {
    if (this.#closed) return;
    if (typeof data === "string") {
      this.#handleProviderControl(provider, data);
      return;
    }
    const bytes = binaryBytes(data);
    if (!bytes) {
      this.#fail("socket-error", "Provider sent an unsupported WebSocket message.");
      return;
    }
    /*
     * A binary chunk is conclusive response activity even if a provider omits
     * or reorders its optional response.created event. This conservative
     * observation preserves interruption while avoiding speculative cancel on
     * a fresh socket.
     */
    if (!this.#responseActive) this.#beginProviderResponse();
    this.#responseActive = true;
    if (bytes.byteLength > 0) this.#providerResponseHadPcm = true;
    this.#observeProviderPcm(bytes);
    if (this.#interrupted) {
      this.#downlinkDroppedBytes += bytes.byteLength;
      return;
    }
    /*
     * A provider WebSocket message is a transport boundary, not a playback
     * deadline. Copy it once into the preallocated ring and let the admission
     * clock drain that ring. Relying on `WebSocket.bufferedAmount` here would
     * only move the same backlog into a runtime queue that cannot be inspected,
     * interrupted atomically, or included in our diagnostics.
     */
    this.#enqueueDownlink(bytes);
  }

  #handleProviderControl(provider: WebSocket, text: string): void {
    let event: unknown = text;
    try {
      event = JSON.parse(text);
    } catch {
      // The raw event stays observable; malformed non-PCM must not disturb the
      // audio lane merely because a provider added or changed an event shape.
    }
    this.#onProviderEvent({
      event,
      raw: text,
      type: isProviderEvent(event) ? event.type : null,
    });
    this.#diagnostic("provider-event", "debug", event);
    if (!isProviderEvent(event)) return;
    this.#providerControlEvents += 1;
    this.#lastProviderEventType = event.type;
    if (event.type === "error") this.#lastProviderError = summarizeProviderError(event);
    if (event.type === "ping") {
      this.#providerKeepalivePings += 1;
      const timestamp = "timestamp" in event ? event.timestamp : undefined;
      /*
       * This is xAI's application protocol, not an RFC 6455 ping frame and not
       * Cap'n Web traffic. Official xAI clients answer it even though the current
       * public speech-to-speech page does not describe it. Keeping the response
       * here makes provider liveness independent of both device transports and
       * preserves the raw ping above for the project event stream. Reflect only the one
       * bounded numeric nonce defined by xAI's official clients; reflecting an
       * arbitrary object would turn a control event into unbounded egress.
       */
      if (typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0) {
        if (this.#sendProviderMessage({ ping_timestamp: timestamp, type: "pong" })) {
          this.#providerKeepalivePongs += 1;
        }
      }
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      this.#handleProviderFunctionCall(provider, event);
      return;
    }
    if (event.type === "input_audio_buffer.committed") {
      if (!this.#responseAfterCommitPending) return;
      this.#responseAfterCommitPending = false;
      if (!this.#interrupted) this.#sendProviderControl("response.create");
      return;
    }
    if (event.type === "response.created") {
      this.#beginProviderResponse();
      this.#responseActive = true;
      return;
    }
    if (event.type !== "response.done") return;
    this.#providerResponsesCompleted += 1;
    this.#responseActive = false;
    if (this.#interrupted) {
      this.#discardDownlinkQueue();
      if (this.#sendDevice(pcmEndOfResponse)) {
        this.#interrupted = false;
        this.#providerResponseDone = true;
        this.#providerResponsePlaybackFinished = true;
        this.#continueAfterProviderFunctionCalls();
      }
      return;
    }
    this.#providerResponseDone = true;
    this.#downlinkResponseDone = true;
    this.#scheduleDownlink();
  }

  #handleProviderFunctionCall(provider: WebSocket, event: { type: string }): void {
    const call = parseProviderFunctionCall(event);
    if (call === null) {
      this.#providerFunctionCallFailures += 1;
      this.#diagnostic(
        "provider-function-call-failed",
        "error",
        "Grok emitted a malformed function call event.",
      );
      return;
    }
    if (!this.#responseActive) this.#beginProviderResponse();
    if (this.#providerResponseFunctionCallIds.has(call.callId)) {
      /*
       * Replaying a call ID could actuate physical hardware twice. The first
       * execution owns that ID; the duplicate stays visible but cannot create
       * another side effect or another continuation response.
       */
      this.#providerFunctionCallFailures += 1;
      this.#diagnostic("provider-function-call-failed", "error", {
        callId: call.callId,
        reason: "duplicate-call-id",
      });
      return;
    }

    this.#providerResponseFunctionCallsSeen += 1;
    this.#providerResponseFunctionCallsPending += 1;
    this.#providerFunctionCalls += 1;
    const epoch = this.#providerResponseEpoch;
    if (
      this.#providerResponseFunctionCallIds.size >= MAXIMUM_FUNCTION_CALLS_PER_RESPONSE ||
      new TextEncoder().encode(call.arguments).byteLength > MAXIMUM_FUNCTION_ARGUMENT_BYTES
    ) {
      this.#completeProviderFunctionCall(
        provider,
        epoch,
        call,
        {
          error: "The function-call request exceeded the bounded userspace tool budget.",
          ok: false,
        },
        true,
      );
      return;
    }

    this.#providerResponseFunctionCallIds.add(call.callId);
    void Promise.resolve()
      .then(async () => {
        if (this.#closed || this.#provider !== provider || this.#providerResponseEpoch !== epoch) {
          return undefined;
        }
        return await this.#onProviderFunctionCall(call);
      })
      .then(
        (result) => this.#completeProviderFunctionCall(provider, epoch, call, result, false),
        (error: unknown) =>
          this.#completeProviderFunctionCall(
            provider,
            epoch,
            call,
            { error: boundedErrorMessage(error), ok: false },
            true,
          ),
      );
  }

  #completeProviderFunctionCall(
    provider: WebSocket,
    epoch: number,
    call: ProviderFunctionCall,
    result: unknown,
    failed: boolean,
  ): void {
    if (this.#closed || this.#provider !== provider || this.#providerResponseEpoch !== epoch) {
      return;
    }
    if (this.#providerResponseFunctionCallsPending > 0) {
      this.#providerResponseFunctionCallsPending -= 1;
    }
    if (failed) {
      this.#providerFunctionCallFailures += 1;
      this.#diagnostic("provider-function-call-failed", "error", {
        callId: call.callId,
        name: call.name,
        result,
      });
    }

    let output: string;
    try {
      output = JSON.stringify(result ?? null);
    } catch (error) {
      this.#providerFunctionCallFailures += 1;
      output = JSON.stringify({
        error: `The device tool returned a non-serializable result: ${boundedErrorMessage(error)}`,
        ok: false,
      });
    }
    if (
      !this.#sendProviderMessage({
        item: {
          call_id: call.callId,
          output,
          type: "function_call_output",
        },
        type: "conversation.item.create",
      })
    ) {
      return;
    }
    this.#continueAfterProviderFunctionCalls();
  }

  #continueAfterProviderFunctionCalls(): void {
    if (
      this.#closed ||
      this.#interrupted ||
      !this.#providerResponseDone ||
      !this.#providerResponsePlaybackFinished ||
      this.#providerResponseFunctionCallsPending !== 0 ||
      this.#providerResponseFunctionCallsSeen === 0
    ) {
      return;
    }
    if (this.#providerResponseHadPcm) {
      /*
       * Grok can legally combine speech and a function call in one response.
       * The function output still enters conversation history above, but a
       * response.create here asks it to answer the same completed turn again.
       * This was observed physically as an exactly duplicated sentence, with
       * two honest sets of PCM frames and only one desired answer. Once that
       * response's own playback and every tool result are complete, there is
       * nothing left to synthesize.
       */
      this.#abandonProviderResponse();
      return;
    }
    /*
     * xAI permits parallel calls in one response and requires every output
     * before exactly one response.create. The playback fence also prevents the
     * continuation's speech from overlapping audio that is still draining to
     * the physical Stick.
     */
    if (this.#sendProviderControl("response.create")) {
      this.#abandonProviderResponse();
    }
  }

  #beginProviderResponse(): void {
    this.#abandonProviderResponse();
    this.#responseActive = true;
  }

  #abandonProviderResponse(): void {
    this.#providerResponseEpoch += 1;
    this.#providerResponseFunctionCallIds.clear();
    this.#providerResponseFunctionCallsPending = 0;
    this.#providerResponseFunctionCallsSeen = 0;
    this.#providerResponseHadPcm = false;
    this.#providerResponseDone = false;
    this.#providerResponsePlaybackFinished = false;
    this.#responseActive = false;
    /* A response boundary may never splice half a PCM16 sample into the next. */
    this.#providerPcmTrailingByte = undefined;
  }

  #observeProviderPcm(bytes: Uint8Array): void {
    /*
     * This is deliberately an aggregate over the source bytes, not a retained
     * audio tap. Peak/RMS lets the physical harness attribute a quiet capture
     * to provider level versus the codec/speaker path without storing private
     * conversation PCM in Durable Object memory. A single trailing byte is
     * enough to remain correct when WebSocket packet boundaries split PCM16;
     * no source-sized allocation or analysis queue enters the realtime lane.
     */
    let offset = 0;
    if (this.#providerPcmTrailingByte !== undefined && bytes.byteLength > 0) {
      this.#observeProviderPcmSample(this.#providerPcmTrailingByte, bytes[0]!);
      this.#providerPcmTrailingByte = undefined;
      offset = 1;
    }
    for (; offset + 1 < bytes.byteLength; offset += 2) {
      this.#observeProviderPcmSample(bytes[offset]!, bytes[offset + 1]!);
    }
    if (offset < bytes.byteLength) this.#providerPcmTrailingByte = bytes[offset]!;
  }

  #observeProviderPcmSample(lowByte: number, highByte: number): void {
    const unsigned = lowByte | (highByte << 8);
    const sample = unsigned >= 0x8_000 ? unsigned - 0x1_0000 : unsigned;
    this.#providerPcmPeakSample = Math.max(this.#providerPcmPeakSample, Math.abs(sample));
    const normalized = sample / 32_768;
    this.#providerPcmNormalizedSquareSum += normalized * normalized;
    this.#providerPcmSamples += 1;
  }

  #enqueueDownlink(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > this.#downlinkQueue.byteLength - this.#downlinkQueuedBytes) {
      /*
       * There is intentionally no "drop oldest" policy for speech. Either
       * choice would splice two unrelated sample times into one apparently
       * healthy answer. Destroying the generation preserves freshness and
       * leaves an exact durable count of every byte that could not be played.
       */
      this.#downlinkDroppedBytes += bytes.byteLength;
      this.#fail(
        "downlink-overflow",
        "The bounded userspace playback reservoir filled before realtime playout caught up.",
        bytes.byteLength,
      );
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
    this.#downlinkQueueHighWaterBytes = Math.max(
      this.#downlinkQueueHighWaterBytes,
      this.#downlinkQueuedBytes,
    );
    this.#scheduleDownlink();
  }

  #scheduleDownlink(): void {
    if (this.#closed || this.#interrupted || this.#downlinkTimer !== undefined) return;
    if (!this.#downlinkStarted) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#finishDownlinkResponse();
        return;
      }
      const startupBytes = ITERATE_KIT_PCM_FRAME_BYTES * DOWNLINK_SOURCE_STARTUP_FRAMES;
      if (
        this.#downlinkQueuedBytes < startupBytes &&
        !(this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0)
      ) {
        return;
      }
      this.#downlinkStarted = true;

      /*
       * Prime only the hardware lead. The remaining source reservoir stays in
       * this ring and is therefore visible to metrics and immediately
       * discardable on interruption. A completed response shorter than the
       * lead sends only its actual frames; the final one is padded below.
       */
      const initialFrames = Math.ceil(
        Math.min(
          this.#downlinkQueuedBytes,
          ITERATE_KIT_PCM_FRAME_BYTES * DEVICE_INITIAL_LEAD_FRAMES,
        ) / ITERATE_KIT_PCM_FRAME_BYTES,
      );
      for (let frame = 0; frame < initialFrames; frame += 1) {
        if (!this.#sendQueuedDownlinkFrame()) return;
      }
      this.#nextDownlinkAt = performance.now() + PCM_FRAME_DURATION_MS;
    }

    const hasCompleteFrame = this.#downlinkQueuedBytes >= ITERATE_KIT_PCM_FRAME_BYTES;
    const hasFinalPartialFrame = this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0;
    if (!hasCompleteFrame && !hasFinalPartialFrame) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#finishDownlinkResponse();
      }
      return;
    }
    const delayMs = Math.max(0, this.#nextDownlinkAt - performance.now());
    this.#downlinkTimer = setTimeout(() => {
      this.#downlinkTimer = undefined;
      this.#sendNextDownlinkFrame();
    }, delayMs);
  }

  #sendNextDownlinkFrame(): void {
    if (this.#closed || this.#interrupted) return;
    const hasCompleteFrame = this.#downlinkQueuedBytes >= ITERATE_KIT_PCM_FRAME_BYTES;
    const hasFinalPartialFrame = this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0;
    if (!hasCompleteFrame && !hasFinalPartialFrame) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#finishDownlinkResponse();
      }
      return;
    }
    if (!this.#sendQueuedDownlinkFrame()) return;
    this.#nextDownlinkAt = nextPcmFrameDeadline(
      this.#nextDownlinkAt,
      performance.now(),
      PCM_FRAME_DURATION_MS,
    );
    if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
      this.#finishDownlinkResponse();
      return;
    }
    this.#scheduleDownlink();
  }

  #sendQueuedDownlinkFrame(): boolean {
    const copiedBytes = Math.min(ITERATE_KIT_PCM_FRAME_BYTES, this.#downlinkQueuedBytes);
    if (copiedBytes === 0) return false;

    /*
     * Every send receives an owned frame. Captun exposed why this matters:
     * standards-shaped WebSocket peers may retain the ArrayBufferView until a
     * later message event. Reusing a scratch array made a whole provider burst
     * arrive as repeated copies of its final frame even though the production
     * runtime happened to snapshot eagerly.
     */
    const frame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES);
    const firstCopyBytes = Math.min(
      copiedBytes,
      this.#downlinkQueue.byteLength - this.#downlinkReadOffset,
    );
    frame.set(
      this.#downlinkQueue.subarray(
        this.#downlinkReadOffset,
        this.#downlinkReadOffset + firstCopyBytes,
      ),
    );
    if (firstCopyBytes < copiedBytes) {
      frame.set(this.#downlinkQueue.subarray(0, copiedBytes - firstCopyBytes), firstCopyBytes);
    }
    this.#downlinkReadOffset =
      (this.#downlinkReadOffset + copiedBytes) % this.#downlinkQueue.byteLength;
    this.#downlinkQueuedBytes -= copiedBytes;
    return this.#sendDevice(frame);
  }

  #finishDownlinkResponse(): boolean {
    if (!this.#sendDevice(pcmEndOfResponse)) return false;
    this.#downlinkResponseDone = false;
    this.#downlinkStarted = false;
    this.#nextDownlinkAt = 0;
    this.#interrupted = false;
    this.#providerResponsePlaybackFinished = true;
    this.#continueAfterProviderFunctionCalls();
    return true;
  }

  #discardDownlinkQueue(): void {
    if (this.#downlinkTimer !== undefined) {
      clearTimeout(this.#downlinkTimer);
      this.#downlinkTimer = undefined;
    }
    this.#downlinkDroppedBytes += this.#downlinkQueuedBytes;
    this.#downlinkQueuedBytes = 0;
    this.#downlinkReadOffset = 0;
    this.#downlinkResponseDone = false;
    this.#downlinkStarted = false;
    this.#downlinkWriteOffset = 0;
    this.#nextDownlinkAt = 0;
  }

  #sendDevice(bytes: Uint8Array): boolean {
    if (
      !socketIsOpen(this.#device) ||
      socketBufferedAmount(this.#device) + bytes.byteLength > this.#maximumSocketBufferedBytes
    ) {
      this.#downlinkDroppedBytes += bytes.byteLength;
      this.#fail(
        "downlink-overflow",
        "Device egress could not accept the current playback frame.",
        bytes.byteLength,
      );
      return false;
    }
    this.#device.send(bytes);
    if (bytes.byteLength > 0) this.#downlinkFrames += 1;
    return true;
  }

  #sendProviderControl(type: string): boolean {
    return this.#sendProviderMessage({ type });
  }

  #sendProviderMessage(message: unknown): boolean {
    const provider = this.#provider;
    if (!provider || !socketIsOpen(provider)) return false;
    const control = JSON.stringify(message);
    if (socketBufferedAmount(provider) + control.length > this.#maximumSocketBufferedBytes) {
      this.#fail(
        "uplink-backpressure",
        "Provider egress could not accept a control message.",
        control.length,
      );
      return false;
    }
    try {
      provider.send(control);
    } catch (error) {
      /*
       * A thrown commit/response send used to escape the WebSocket callback
       * and could tear down the whole Durable Object incarnation. Recovery is
       * intentionally generation-scoped: the control is not replayed against
       * a new Grok input buffer, while the device lane remains available for
       * the next explicit PTT turn.
       */
      this.#handleProviderSendFailure(provider, error, "control", control.length);
      return false;
    }
    this.#providerControlMessagesSent += 1;
    const type = providerMessageType(message);
    if (type === "input_audio_buffer.commit") this.#providerCommitMessagesSent += 1;
    if (type === "response.create") this.#providerResponseCreateMessagesSent += 1;
    return true;
  }

  #handleProviderSendFailure(
    provider: WebSocket,
    error: unknown,
    lane: "control" | "pcm",
    droppedBytes: number,
  ): void {
    if (this.#provider !== provider) return;
    this.#providerSendFailures += 1;
    this.#diagnostic(
      "provider-send-failed",
      "error",
      { lane, message: boundedErrorMessage(error) },
      droppedBytes,
    );
    this.#detachProvider(provider, 1011, "Provider WebSocket send failed.", "socket-error");
    if (!socketIsOpenOrConnecting(provider)) return;
    try {
      provider.close(1011, "Provider WebSocket send failed.");
    } catch (closeError) {
      /*
       * Identity was revoked before cleanup, so this cannot re-admit stale
       * bytes. Still retain the cleanup failure: an exception here must not
       * resurrect the original unhandled-callback failure mode invisibly.
       */
      this.#diagnostic("provider-send-failed", "error", {
        lane: "close-after-send-failure",
        message: boundedErrorMessage(closeError),
      });
    }
  }

  #detachProvider(
    provider: WebSocket,
    code: number,
    reason: string,
    diagnosticCode: "provider-closed" | "socket-error",
  ): void {
    if (this.#closed || this.#provider !== provider) return;
    this.#provider = undefined;
    this.#providerDisconnects += 1;
    this.#lastSocketClose = { code, reason, source: "provider" };
    this.#clearUplinkEndMarkerWait();
    this.#responseAfterCommitPending = false;
    this.#abandonProviderResponse();
    this.#discardDownlinkQueue();
    if (diagnosticCode === "provider-closed") {
      this.#diagnostic("provider-closed", "info", { code, reason });
    }
    this.#onProviderUnavailable();
  }

  #fail(code: PcmProxyDiagnostic["code"], message: string, droppedBytes = 0, detail?: unknown) {
    this.#diagnostic(code, "error", detail ?? message, droppedBytes);
    this.close(4000, message.slice(0, 120));
  }

  #diagnostic(
    code: PcmProxyDiagnostic["code"],
    severity: PcmProxyDiagnostic["severity"],
    detail?: unknown,
    droppedBytes?: number,
  ) {
    this.#onDiagnostic({
      code,
      ...(detail === undefined ? {} : { detail }),
      ...(droppedBytes === undefined ? {} : { droppedBytes }),
      sessionId: this.#sessionId,
      severity,
    });
  }
}

function isProviderEvent(value: unknown): value is { type: string } {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function providerMessageType(value: unknown): string | null {
  /*
   * This deliberately inspects only the bounded routing discriminator. The
   * metrics need to prove that commit and response.create crossed userspace;
   * retaining whole outbound controls here would duplicate the event journal
   * and risk making diagnostics memory proportional to provider payloads.
   */
  return isProviderEvent(value) ? value.type : null;
}

function parseProviderFunctionCall(event: { type: string }): ProviderFunctionCall | null {
  if (
    !("arguments" in event) ||
    typeof event.arguments !== "string" ||
    !("call_id" in event) ||
    typeof event.call_id !== "string" ||
    event.call_id.length === 0 ||
    event.call_id.length > 256 ||
    !("name" in event) ||
    typeof event.name !== "string" ||
    event.name.length === 0 ||
    event.name.length > 128
  ) {
    return null;
  }
  return {
    arguments: event.arguments,
    callId: event.call_id,
    name: event.name,
  };
}

function boundedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 256);
}

function summarizeProviderError(event: { type: string }): PcmSessionMetrics["lastProviderError"] {
  const error =
    "error" in event && typeof event.error === "object" && event.error !== null
      ? event.error
      : event;
  return {
    code: selectedBoundedString(error, "code"),
    message: selectedBoundedString(error, "message"),
  };
}

function selectedBoundedString(value: object, key: string): string | null {
  const selected = key in value ? (value as Record<string, unknown>)[key] : undefined;
  return typeof selected === "string" ? selected.slice(0, 256) : null;
}

function binaryBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/*
 * Captun's in-memory Worker WebSocketPair intentionally implements only the
 * actual server-side pair surface and omits browser-client bookkeeping
 * properties. Treating an absent readyState/bufferedAmount as accepted/zero
 * keeps the core testable against that faithful boundary; native workerd
 * sockets still take the strict branches.
 */
function socketIsOpen(socket: WebSocket): boolean {
  return socket.readyState === undefined || socket.readyState === WebSocket.OPEN;
}

function socketIsOpenOrConnecting(socket: WebSocket): boolean {
  return (
    socket.readyState === undefined ||
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  );
}

function socketBufferedAmount(socket: WebSocket): number {
  return typeof socket.bufferedAmount === "number" ? socket.bufferedAmount : 0;
}

/**
 * Preserve the original media grid across small timer slips, but never emit a
 * catch-up burst when an isolate was delayed for longer than a complete frame.
 * The latter restarts one frame from now, leaving firmware metrics to classify
 * whether its finite hardware lead covered the scheduling delay.
 */
function nextPcmFrameDeadline(
  currentDeadline: number,
  sentAt: number,
  frameDurationMs: number,
): number {
  if (currentDeadline <= 0) return sentAt + frameDurationMs;
  const gridDeadline = currentDeadline + frameDurationMs;
  return gridDeadline <= sentAt ? sentAt + frameDurationMs : gridDeadline;
}
