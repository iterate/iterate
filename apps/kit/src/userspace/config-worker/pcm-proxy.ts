import { decodePcmDownlinkReleaseReceipt } from "./device-pcm-wire.ts";

export const ITERATE_KIT_PCM_FRAME_BYTES = 640;
export const ITERATE_KIT_PCM_SAMPLE_RATE_HZ = 16_000;
export const ITERATE_KIT_PCM_SUBPROTOCOL = "iterate.kit.pcm.v1";
export type PcmTurnDetection = "manual" | "server-vad";

/*
 * These bounds describe three different queues and must never be collapsed
 * into one magic number:
 *
 * - 180 seconds is the declared maximum provider response retained by the
 *   userspace response reservoir. A physical
 *   grok-voice-think-fast-2.0 run filled an eight-second reservoir after
 *   generating roughly ten seconds of a requested thirty-second story. That
 *   was normal source acceleration, not a slow device or network backlog. The
 *   first sixty-second bound later cut off a measured 71.88-second story after
 *   only eleven audible seconds: Grok had generated the valid future audio
 *   faster than realtime, so reservoir exhaustion discarded content which the
 *   healthy Stick was still draining exactly. A later direct provider
 *   measurement generated the complete 300..400 acceptance count as 153.752
 *   seconds / 4,920,064 PCM bytes in 20.85 seconds. The former 90-second bound
 *   therefore made that valid scenario impossible. A declared 180-second
 *   ceiling covers the measured response with 17% duration headroom while
 *   remaining a finite 5.76 MB per-call budget. The device still receives only
 *   hardware-release-paced frames; interruption and socket failure discard
 *   the reservoir in one operation.
 * - 32 frames / 640 ms is the source-readiness watermark. A physical Grok run
 *   measured a 203.28 ms gap between provider packets, so the smaller hardware
 *   lead is not enough to prove that userspace has a continuous source.
 * - sixteen frames / 320 ms is the finite lead admitted at startup. This is
 *   not merely a jitter guess: the M5StickS3 direct-I2S owner cannot produce
 *   its first hardware-release receipt until all sixteen cyclic DMA
 *   descriptors have been initialized. A smaller credit window deadlocks the
 *   two correct local contracts: userspace waits for a hardware receipt while
 *   firmware waits for enough content to start the hardware clock. Sixteen is
 *   also above the measured 170 ms post-send delivery gap and remains below
 *   the Stick's existing 32-frame / 640 ms receive bound. Subsequent frames
 *   still cross only when exact hardware completion returns credit, so this
 *   startup requirement does not turn the provider reservoir into an ESP
 *   backlog.
 */
const MAXIMUM_PROVIDER_RESPONSE_DURATION_MS = 180_000;
const PCM_FRAME_DURATION_MS = 20;
const DOWNLINK_RESPONSE_RESERVOIR_FRAMES =
  MAXIMUM_PROVIDER_RESPONSE_DURATION_MS / PCM_FRAME_DURATION_MS;
const DOWNLINK_SOURCE_STARTUP_FRAMES = 32;
const DEVICE_INITIAL_LEAD_FRAMES = 16;
const DOWNLINK_RECEIPT_TIMEOUT_MS = 1_500;
const DOWNLINK_ITEM_COUNTER_MAXIMUM = 0xffff_ffff;
/*
 * Truncation repairs provider conversation history; it is not an audio retry.
 * A missing acknowledgement leaves the next answer semantically divergent
 * from what the person heard, so that provider generation is disposable after
 * one bounded wait. The device lane remains connected for a fresh generation.
 */
const PROVIDER_TRUNCATION_TIMEOUT_MS = 1_500;
/*
 * The ESP's I2S clock, not a JavaScript timer, owns audible time. Device
 * metrics report its current receive-ring depth once per second over the
 * independent Cap'n Web lane. If that depth grows beyond the admitted
 * sixteen-frame lead, pause at most three frame periods per observation so I2S
 * can drain the excess. The cap matters because a delayed capability callback
 * is a stale control observation: applying an arbitrarily large correction
 * could drain a ring that has already recovered and manufacture an underrun.
 * Three frames per second corrects a deliberately pessimistic 6% clock error,
 * while the target-specific finite ring remains responsible for sub-second
 * delivery bunching. This is playout feedback, not an audio queue or retry.
 */
/*
 * This is not an audio queue timeout. The PCM marker owns the turn boundary;
 * the independently delivered Cap'n Web stop event merely starts a watchdog
 * when it gets there first. Healthy delivery is a few milliseconds; 1.5
 * seconds tolerates control/media scheduling skew while ensuring a lost marker
 * cannot leave a Grok input buffer open indefinitely.
 */
const UPLINK_END_MARKER_TIMEOUT_MS = 1_500;
/*
 * A server-VAD start without a stop is an upstream generation that cannot
 * produce a reply. It also streams live room audio for as long as it remains
 * attached. Sixty seconds permits an unusually long human turn but gives the
 * failure a finite privacy, cost, and recovery bound. Only the provider is
 * retired; the device's realtime lane remains warm and queue-free.
 */
const SERVER_VAD_MAXIMUM_SPEECH_MS = 60_000;
/*
 * xAI owns response creation under server VAD. A client-side response.create
 * fallback can race a merely late automatic response and manufacture two
 * answers for one utterance. Five seconds is therefore a terminal generation
 * watchdog, not a retry threshold: retire Grok, preserve the device lane, and
 * never replay microphone audio into a new provider conversation.
 */
const SERVER_VAD_RESPONSE_TIMEOUT_MS = 5_000;
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
    | "downlink-device-receipt-timeout"
    | "downlink-item-counter-exhausted"
    | "downlink-overflow"
    | "downlink-pacing-overrun"
    | "empty-uplink-turn"
    | "invalid-device-frame"
    | "invalid-device-receipt"
    | "playback-interruption-failed"
    | "provider-closed"
    | "provider-event"
    | "provider-function-call-failed"
    | "provider-response-failed"
    | "provider-send-failed"
    | "provider-truncation-invalid"
    | "provider-truncation-timeout"
    | "provider-unavailable"
    | "server-vad-response-timeout"
    | "server-vad-speech-timeout"
    | "socket-error"
    | "unsolicited-provider-response"
    | "uplink-backpressure"
    | "uplink-end-marker-timeout"
    | "uplink-observer-failed"
    | "unexpected-manual-turn-control"
    | "unexpected-uplink-end-marker";
  detail?: unknown;
  droppedBytes?: number;
  sessionId: string;
  severity: "debug" | "error" | "info" | "warn";
}

export interface PcmSessionMetrics {
  awaitingCommitAcknowledgement: boolean;
  awaitingUplinkEndMarker: boolean;
  closed: boolean;
  conversationActive: boolean;
  conversationEnds: number;
  conversationStartedAtMs: number | null;
  conversationStarts: number;
  devicePcmPeakSample: number;
  devicePcmRmsSample: number;
  devicePcmSamples: number;
  diagnosticResponseRequests: number;
  deviceDownlinkDepthCorrectionFrames: number;
  deviceDownlinkDepthCorrections: number;
  deviceDownlinkDepthMaximumFrames: number;
  deviceDownlinkDepthObservations: number;
  downlinkCreditBlocked: number;
  downlinkDroppedBytes: number;
  downlinkFrames: number;
  downlinkItemsAcknowledged: number;
  downlinkItemsInFlight: number;
  downlinkItemsSent: number;
  downlinkMaximumInFlightItems: number;
  downlinkInterruptedBytes: number;
  downlinkPacingCatchUpFrames: number;
  downlinkPacingCatchUpIncidents: number;
  downlinkPacingMaximumLatenessMs: number;
  downlinkPacingOverrunFrames: number;
  downlinkPartialBytes: number;
  downlinkQueuedBytes: number;
  downlinkQueueHighWaterBytes: number;
  downlinkReceipts: number;
  downlinkResponseReservoirCapacityBytes: number;
  downlinkRetiredBoundaryPending: boolean;
  downlinkSourceStartupFrames: number;
  downlinkDuplicateReceipts: number;
  downlinkReceiptTimeouts: number;
  emptyUplinkTurns: number;
  firstDevicePcmSentAtMs: number | null;
  firstProviderPcmAtMs: number | null;
  initialGreetingRequests: number;
  interrupted: boolean;
  lastProviderError: { code: string | null; message: string | null } | null;
  lastProviderEventType: string | null;
  lastSocketClose: {
    code: number;
    reason: string;
    source: "device" | "provider";
  } | null;
  maximumProviderResponseDurationMs: number;
  providerAvailable: boolean;
  providerAttachedAtMs: number | null;
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
  playbackInterruptionFailures: number;
  playbackInterruptionPending: boolean;
  playbackInterruptionsCoalesced: number;
  playbackInterruptionsCompleted: number;
  playbackInterruptionsRequested: number;
  playbackInterruptionsSkippedIdle: number;
  providerPcmPeakSample: number;
  providerPcmRmsSample: number;
  providerPcmSamples: number;
  providerRetirements: number;
  providerResponseActive: boolean;
  providerResponseCreateMessagesSent: number;
  providerResponsesCancelled: number;
  providerResponsesCompleted: number;
  providerResponsesFailed: number;
  providerUnsolicitedPcmBytes: number;
  providerUnsolicitedResponses: number;
  providerSessionReadyAtMs: number | null;
  providerSendFailures: number;
  providerTruncationsCompleted: number;
  providerTruncationsPending: number;
  providerTruncationsRequested: number;
  providerTruncationTimeouts: number;
  providerSpeechActiveSinceAtMs: number | null;
  providerSpeechMaximumDurationMs: number;
  providerSpeechStarts: number;
  providerSpeechStops: number;
  providerSpeechTimeouts: number;
  serverVadResponseTimeouts: number;
  turnDetection: PcmTurnDetection;
  uplinkGainMultiplier: number;
  uplinkPcmClippedSamples: number;
  uplinkPcmPeakSample: number;
  uplinkPcmRmsSample: number;
  uplinkPcmSamples: number;
  uplinkDroppedBytes: number;
  uplinkControlStarts: number;
  uplinkControlStops: number;
  uplinkEndMarkers: number;
  uplinkEndMarkerTimeouts: number;
  uplinkFrames: number;
  uplinkTurns: number;
  uplinkUnavailableFrames: number;
}

export interface PcmSessionBridgeOptions {
  device: WebSocket;
  /**
   * Generated source frames required before a non-final response may start.
   * This is a userspace jitter reserve, not the number admitted to hardware.
   */
  downlinkSourceStartupFrames?: number;
  initialGreeting?: string;
  maximumSocketBufferedBytes: number;
  onDiagnostic?: (diagnostic: PcmProxyDiagnostic) => void;
  /** Called synchronously, after provider send succeeds; retainers must copy. */
  onAcceptedUplinkPcm?: (frame: Uint8Array, acceptedUplinkFrame: number) => void;
  onPlaybackInterruption?: () => Promise<void> | void;
  onProviderEvent?: (event: ProviderNonPcmEvent) => void;
  onProviderFunctionCall?: (call: ProviderFunctionCall) => Promise<unknown>;
  onProviderUnavailable?: () => void;
  sessionId: string;
  turnDetection: PcmTurnDetection;
  uplinkGainMultiplier?: number;
}

interface AssistantAudioPlayback {
  acknowledgedAudioBytes: number;
  contentIndex: number;
  itemId: string;
}

interface DownlinkReleaseLedgerItem {
  audioBytes: number;
  owner: AssistantAudioPlayback | null;
}

interface PendingProviderTruncation {
  audioEndMs: number;
  contentIndex: number;
  itemId: string;
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
  readonly #downlinkSourceStartupFrames: number;
  readonly #initialGreeting: string | undefined;
  readonly #maximumSocketBufferedBytes: number;
  readonly #onAcceptedUplinkPcm:
    | ((frame: Uint8Array, acceptedUplinkFrame: number) => void)
    | undefined;
  readonly #onDiagnostic: (diagnostic: PcmProxyDiagnostic) => void;
  readonly #onPlaybackInterruption: () => Promise<void> | void;
  readonly #onProviderEvent: (event: ProviderNonPcmEvent) => void;
  readonly #onProviderFunctionCall: (call: ProviderFunctionCall) => Promise<unknown>;
  readonly #onProviderUnavailable: () => void;
  readonly #sessionId: string;
  readonly #turnDetection: PcmTurnDetection;
  readonly #uplinkGainMultiplier: number;
  readonly #downlinkQueue = new Uint8Array(
    ITERATE_KIT_PCM_FRAME_BYTES * DOWNLINK_RESPONSE_RESERVOIR_FRAMES,
  );
  #closed = false;
  #conversationActive = false;
  #conversationEnds = 0;
  #conversationStartedAtMs: number | null = null;
  #conversationStarts = 0;
  #devicePcmNormalizedSquareSum = 0;
  #devicePcmPeakSample = 0;
  #devicePcmSamples = 0;
  #diagnosticResponsePending = false;
  #diagnosticResponseRequests = 0;
  #deviceDownlinkDepthCorrectionFrames = 0;
  #deviceDownlinkDepthCorrections = 0;
  #deviceDownlinkDepthMaximumFrames = 0;
  #deviceDownlinkDepthObservations = 0;
  #awaitingUplinkEndMarker = false;
  #downlinkCreditBlocked = 0;
  #downlinkDroppedBytes = 0;
  #downlinkFrames = 0;
  #downlinkItemsAcknowledged = 0;
  #downlinkItemsSent = 0;
  readonly #downlinkReleaseLedger = new Map<number, DownlinkReleaseLedgerItem>();
  #downlinkMaximumInFlightItems = 0;
  #downlinkInterruptedBytes = 0;
  #downlinkPacingCatchUpFrames = 0;
  #downlinkPacingCatchUpIncidents = 0;
  #downlinkPacingMaximumLatenessMs = 0;
  #downlinkPacingOverrunFrames = 0;
  #downlinkQueuedBytes = 0;
  #downlinkQueueHighWaterBytes = 0;
  #downlinkReceipts = 0;
  #downlinkDuplicateReceipts = 0;
  #downlinkReceiptTimeouts = 0;
  #downlinkReceiptTimer: ReturnType<typeof setTimeout> | undefined;
  #downlinkReadOffset = 0;
  #downlinkResponseDone = false;
  #downlinkRetiredBoundaryPending = false;
  #downlinkStarted = false;
  #downlinkWriteOffset = 0;
  #emptyUplinkTurns = 0;
  #firstDevicePcmSentAtMs: number | null = null;
  #firstProviderPcmAtMs: number | null = null;
  #initialGreetingRequests = 0;
  #initialGreetingRequestedForConversation = false;
  #interrupted = false;
  #lastProviderError: PcmSessionMetrics["lastProviderError"] = null;
  #lastProviderEventType: string | null = null;
  #lastSocketClose: PcmSessionMetrics["lastSocketClose"] = null;
  #provider: WebSocket | undefined;
  #providerAttachedAtMs: number | null = null;
  #providerCommitMessagesSent = 0;
  #providerConnections = 0;
  #providerControlEvents = 0;
  #providerControlMessagesSent = 0;
  #providerDisconnects = 0;
  #providerFunctionCallFailures = 0;
  #providerFunctionCalls = 0;
  #providerKeepalivePings = 0;
  #providerKeepalivePongs = 0;
  #playbackInterruptionEpoch = 0;
  #playbackInterruptionFailures = 0;
  #playbackInterruptionPending = false;
  #playbackInterruptionsCoalesced = 0;
  #playbackInterruptionsCompleted = 0;
  #playbackInterruptionsRequested = 0;
  #playbackInterruptionsSkippedIdle = 0;
  #providerPcmNormalizedSquareSum = 0;
  #providerPcmPeakSample = 0;
  #providerPcmSamples = 0;
  #providerPcmTrailingByte: number | undefined;
  #providerRetirements = 0;
  #providerResponseEpoch = 0;
  #providerResponseFunctionCallIds = new Set<string>();
  #providerResponseFunctionCallsPending = 0;
  #providerResponseFunctionCallsSeen = 0;
  #providerResponseHadPcm = false;
  #providerResponseDone = false;
  #providerResponsePlaybackFinished = false;
  #providerResponseCreateMessagesSent = 0;
  #providerResponsesCancelled = 0;
  #providerResponsesCompleted = 0;
  #providerResponsesFailed = 0;
  #providerUnsolicitedPcmBytes = 0;
  #providerUnsolicitedResponses = 0;
  #providerSessionReadyAtMs: number | null = null;
  #providerSendFailures = 0;
  #providerAssistantOutputItemId: string | null = null;
  #providerAudioPlayback: AssistantAudioPlayback | null = null;
  #providerTruncationPending: PendingProviderTruncation | null = null;
  #providerTruncationTimer: ReturnType<typeof setTimeout> | undefined;
  #providerTruncationsCompleted = 0;
  #providerTruncationsRequested = 0;
  #providerTruncationTimeouts = 0;
  #providerSpeechActiveSinceAtMs: number | null = null;
  #providerSpeechMaximumDurationMs = 0;
  #providerSpeechStarts = 0;
  #providerSpeechStops = 0;
  #providerSpeechTimeouts = 0;
  #responseAfterCommitPending = false;
  #responseActive = false;
  #manualResponseAuthorized = false;
  #manualResponseStarted = false;
  #unsolicitedResponseActive = false;
  #serverVadAwaitingResponse = false;
  #serverVadResponseTimeouts = 0;
  #serverVadResponseTimer: ReturnType<typeof setTimeout> | undefined;
  #serverVadSpeechActive = false;
  #serverVadSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  #uplinkControlStarts = 0;
  #uplinkControlStops = 0;
  #uplinkDroppedBytes = 0;
  #uplinkEndMarkers = 0;
  #uplinkEndMarkerTimeouts = 0;
  #uplinkEndMarkerTimer: ReturnType<typeof setTimeout> | undefined;
  #uplinkFrames = 0;
  #uplinkFramesInTurn = 0;
  #uplinkPcmClippedSamples = 0;
  #uplinkPcmNormalizedSquareSum = 0;
  #uplinkPcmPeakSample = 0;
  #uplinkPcmSamples = 0;
  #uplinkTurnActive = false;
  #uplinkTurns = 0;
  #uplinkUnavailableFrames = 0;

  constructor(options: PcmSessionBridgeOptions) {
    if (
      !Number.isSafeInteger(options.maximumSocketBufferedBytes) ||
      options.maximumSocketBufferedBytes < ITERATE_KIT_PCM_FRAME_BYTES ||
      options.maximumSocketBufferedBytes > 256 * 1_024
    ) {
      throw new Error("The PCM socket backlog limit must be from one frame through 256 KiB.");
    }
    if (options.turnDetection !== "manual" && options.turnDetection !== "server-vad") {
      throw new Error(`Unsupported PCM turn-detection policy: ${String(options.turnDetection)}`);
    }
    const downlinkSourceStartupFrames =
      options.downlinkSourceStartupFrames ?? DOWNLINK_SOURCE_STARTUP_FRAMES;
    if (
      !Number.isSafeInteger(downlinkSourceStartupFrames) ||
      downlinkSourceStartupFrames < 1 ||
      downlinkSourceStartupFrames > DOWNLINK_RESPONSE_RESERVOIR_FRAMES
    ) {
      throw new Error(
        `The PCM source-readiness watermark must be from one through ${DOWNLINK_RESPONSE_RESERVOIR_FRAMES} frames.`,
      );
    }
    const uplinkGainMultiplier = options.uplinkGainMultiplier ?? 1;
    if (
      !Number.isSafeInteger(uplinkGainMultiplier) ||
      uplinkGainMultiplier < 1 ||
      uplinkGainMultiplier > 64
    ) {
      throw new Error("The PCM uplink gain multiplier must be an integer from 1 through 64.");
    }
    const initialGreetingBytes =
      options.initialGreeting === undefined
        ? 0
        : new TextEncoder().encode(options.initialGreeting).byteLength;
    if (
      options.initialGreeting !== undefined &&
      (initialGreetingBytes === 0 || initialGreetingBytes > 160)
    ) {
      throw new Error("The initial greeting must contain from one through 160 UTF-8 bytes.");
    }
    if (options.turnDetection === "manual" && options.initialGreeting !== undefined) {
      throw new Error("Manual push-to-talk sessions cannot configure an initial greeting.");
    }
    this.#device = options.device;
    this.#downlinkSourceStartupFrames = downlinkSourceStartupFrames;
    this.#initialGreeting = options.initialGreeting;
    this.#maximumSocketBufferedBytes = options.maximumSocketBufferedBytes;
    this.#onAcceptedUplinkPcm = options.onAcceptedUplinkPcm;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onPlaybackInterruption = options.onPlaybackInterruption ?? (() => undefined);
    this.#onProviderEvent = options.onProviderEvent ?? (() => undefined);
    this.#onProviderFunctionCall =
      options.onProviderFunctionCall ??
      (async () => {
        throw new Error("No userspace device tool handler is installed.");
      });
    this.#onProviderUnavailable = options.onProviderUnavailable ?? (() => undefined);
    this.#sessionId = options.sessionId;
    this.#turnDetection = options.turnDetection;
    this.#uplinkGainMultiplier = uplinkGainMultiplier;
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
  }

  metrics(): PcmSessionMetrics {
    return {
      awaitingCommitAcknowledgement: this.#responseAfterCommitPending,
      awaitingUplinkEndMarker: this.#awaitingUplinkEndMarker,
      closed: this.#closed,
      conversationActive: this.#conversationActive,
      conversationEnds: this.#conversationEnds,
      conversationStartedAtMs: this.#conversationStartedAtMs,
      conversationStarts: this.#conversationStarts,
      devicePcmPeakSample: this.#devicePcmPeakSample,
      devicePcmRmsSample:
        this.#devicePcmSamples === 0
          ? 0
          : Math.sqrt(this.#devicePcmNormalizedSquareSum / this.#devicePcmSamples) * 32_768,
      devicePcmSamples: this.#devicePcmSamples,
      diagnosticResponseRequests: this.#diagnosticResponseRequests,
      deviceDownlinkDepthCorrectionFrames: this.#deviceDownlinkDepthCorrectionFrames,
      deviceDownlinkDepthCorrections: this.#deviceDownlinkDepthCorrections,
      deviceDownlinkDepthMaximumFrames: this.#deviceDownlinkDepthMaximumFrames,
      deviceDownlinkDepthObservations: this.#deviceDownlinkDepthObservations,
      downlinkCreditBlocked: this.#downlinkCreditBlocked,
      downlinkDroppedBytes: this.#downlinkDroppedBytes,
      downlinkFrames: this.#downlinkFrames,
      downlinkItemsAcknowledged: this.#downlinkItemsAcknowledged,
      downlinkItemsInFlight: this.#downlinkItemsSent - this.#downlinkItemsAcknowledged,
      downlinkItemsSent: this.#downlinkItemsSent,
      downlinkMaximumInFlightItems: this.#downlinkMaximumInFlightItems,
      downlinkInterruptedBytes: this.#downlinkInterruptedBytes,
      downlinkPacingCatchUpFrames: this.#downlinkPacingCatchUpFrames,
      downlinkPacingCatchUpIncidents: this.#downlinkPacingCatchUpIncidents,
      downlinkPacingMaximumLatenessMs: this.#downlinkPacingMaximumLatenessMs,
      downlinkPacingOverrunFrames: this.#downlinkPacingOverrunFrames,
      downlinkPartialBytes: this.#downlinkQueuedBytes % ITERATE_KIT_PCM_FRAME_BYTES,
      downlinkQueuedBytes: this.#downlinkQueuedBytes,
      downlinkQueueHighWaterBytes: this.#downlinkQueueHighWaterBytes,
      downlinkReceipts: this.#downlinkReceipts,
      /*
       * Queue usage without its finite allocation ceiling cannot answer the
       * operational memory question. Report the declared policy beside the
       * high-water mark so an endurance artifact can distinguish healthy
       * source acceleration from a response approaching the per-call budget.
       */
      downlinkResponseReservoirCapacityBytes:
        DOWNLINK_RESPONSE_RESERVOIR_FRAMES * ITERATE_KIT_PCM_FRAME_BYTES,
      downlinkRetiredBoundaryPending: this.#downlinkRetiredBoundaryPending,
      downlinkSourceStartupFrames: this.#downlinkSourceStartupFrames,
      downlinkDuplicateReceipts: this.#downlinkDuplicateReceipts,
      downlinkReceiptTimeouts: this.#downlinkReceiptTimeouts,
      emptyUplinkTurns: this.#emptyUplinkTurns,
      firstDevicePcmSentAtMs: this.#firstDevicePcmSentAtMs,
      firstProviderPcmAtMs: this.#firstProviderPcmAtMs,
      initialGreetingRequests: this.#initialGreetingRequests,
      interrupted: this.#interrupted,
      lastProviderError: this.#lastProviderError,
      lastProviderEventType: this.#lastProviderEventType,
      lastSocketClose: this.#lastSocketClose,
      maximumProviderResponseDurationMs: MAXIMUM_PROVIDER_RESPONSE_DURATION_MS,
      providerAvailable: this.#provider !== undefined && socketIsOpen(this.#provider),
      providerAttachedAtMs: this.#providerAttachedAtMs,
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
      playbackInterruptionFailures: this.#playbackInterruptionFailures,
      playbackInterruptionPending: this.#playbackInterruptionPending,
      playbackInterruptionsCoalesced: this.#playbackInterruptionsCoalesced,
      playbackInterruptionsCompleted: this.#playbackInterruptionsCompleted,
      playbackInterruptionsRequested: this.#playbackInterruptionsRequested,
      playbackInterruptionsSkippedIdle: this.#playbackInterruptionsSkippedIdle,
      providerPcmPeakSample: this.#providerPcmPeakSample,
      providerPcmRmsSample:
        this.#providerPcmSamples === 0
          ? 0
          : Math.sqrt(this.#providerPcmNormalizedSquareSum / this.#providerPcmSamples) * 32_768,
      providerPcmSamples: this.#providerPcmSamples,
      providerRetirements: this.#providerRetirements,
      providerResponseActive: this.#responseActive,
      providerResponseCreateMessagesSent: this.#providerResponseCreateMessagesSent,
      providerResponsesCancelled: this.#providerResponsesCancelled,
      providerResponsesCompleted: this.#providerResponsesCompleted,
      providerResponsesFailed: this.#providerResponsesFailed,
      providerUnsolicitedPcmBytes: this.#providerUnsolicitedPcmBytes,
      providerUnsolicitedResponses: this.#providerUnsolicitedResponses,
      providerSessionReadyAtMs: this.#providerSessionReadyAtMs,
      providerSendFailures: this.#providerSendFailures,
      providerTruncationsCompleted: this.#providerTruncationsCompleted,
      providerTruncationsPending: this.#providerTruncationPending === null ? 0 : 1,
      providerTruncationsRequested: this.#providerTruncationsRequested,
      providerTruncationTimeouts: this.#providerTruncationTimeouts,
      providerSpeechActiveSinceAtMs: this.#providerSpeechActiveSinceAtMs,
      providerSpeechMaximumDurationMs: this.#providerSpeechMaximumDurationMs,
      providerSpeechStarts: this.#providerSpeechStarts,
      providerSpeechStops: this.#providerSpeechStops,
      providerSpeechTimeouts: this.#providerSpeechTimeouts,
      serverVadResponseTimeouts: this.#serverVadResponseTimeouts,
      turnDetection: this.#turnDetection,
      uplinkGainMultiplier: this.#uplinkGainMultiplier,
      uplinkPcmClippedSamples: this.#uplinkPcmClippedSamples,
      uplinkPcmPeakSample: this.#uplinkPcmPeakSample,
      uplinkPcmRmsSample:
        this.#uplinkPcmSamples === 0
          ? 0
          : Math.sqrt(this.#uplinkPcmNormalizedSquareSum / this.#uplinkPcmSamples) * 32_768,
      uplinkPcmSamples: this.#uplinkPcmSamples,
      uplinkControlStarts: this.#uplinkControlStarts,
      uplinkControlStops: this.#uplinkControlStops,
      uplinkDroppedBytes: this.#uplinkDroppedBytes,
      uplinkEndMarkers: this.#uplinkEndMarkers,
      uplinkEndMarkerTimeouts: this.#uplinkEndMarkerTimeouts,
      uplinkFrames: this.#uplinkFrames,
      uplinkTurns: this.#uplinkTurns,
      uplinkUnavailableFrames: this.#uplinkUnavailableFrames,
    };
  }

  /**
   * Requests one known provider response for a continuous-AEC physical test.
   *
   * A deterministic provider intentionally does not fake server-VAD events,
   * because doing so would make the mocked lane look more like Grok than it
   * really is. The harness therefore needs one explicit response edge. It is
   * fenced until the previous response's zero-length physical boundary has
   * drained, so a fast test driver cannot overlap tones or create hidden
   * latency. Manual PTT rejects this seam: its only legal response edge remains
   * a completed microphone turn and provider commit acknowledgement.
   */
  requestDiagnosticResponse(): boolean {
    if (
      this.#closed ||
      this.#turnDetection !== "server-vad" ||
      !this.#conversationActive ||
      this.#provider === undefined ||
      this.#diagnosticResponsePending ||
      this.#responseActive ||
      this.#downlinkResponseDone ||
      this.#downlinkRetiredBoundaryPending ||
      this.#downlinkQueuedBytes > 0 ||
      this.#downlinkStarted ||
      this.#serverVadSpeechActive ||
      this.#serverVadAwaitingResponse ||
      this.#interrupted ||
      this.#playbackInterruptionPending
    ) {
      return false;
    }
    this.#diagnosticResponsePending = true;
    if (!this.#sendProviderControl("response.create")) {
      this.#diagnosticResponsePending = false;
      return false;
    }
    this.#diagnosticResponseRequests += 1;
    return true;
  }

  /**
   * Records feedback from the physical playout ring.
   *
   * `WebSocket.send()` only establishes local runtime acceptance. It cannot
   * reveal an ESP playback clock that is slightly slower, nor bytes bunched by
   * TLS/radio delivery after the send. The cumulative release receipt is now
   * the sole flow-control fact: it is emitted only after the hardware-clocked
   * consumer frees an ordered lane slot. Depth remains valuable diagnostic
   * context, but it must not create a second media clock or alter admission.
   */
  observeDeviceDownlinkDepth(depthFrames: number): void {
    if (!Number.isSafeInteger(depthFrames) || depthFrames < 0) {
      throw new Error("The device downlink depth must be a non-negative safe integer.");
    }
    this.#deviceDownlinkDepthObservations += 1;
    this.#deviceDownlinkDepthMaximumFrames = Math.max(
      this.#deviceDownlinkDepthMaximumFrames,
      depthFrames,
    );
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
    if (this.#closed || !this.#conversationActive) {
      if (socketIsOpenOrConnecting(provider)) {
        provider.close(
          1000,
          this.#closed ? "The device PCM lane has ended." : "No conversation is active.",
        );
      }
      return false;
    }

    const previous = this.#provider;
    this.#provider = undefined;
    if (previous && socketIsOpenOrConnecting(previous)) {
      previous.close(1000, "A fresh provider generation replaced this one.");
    }
    /* Provider-owned VAD and hardware purge fences cannot cross generations. */
    this.#clearServerVadSpeechWindow();
    this.#clearServerVadResponseWait();
    this.#serverVadSpeechActive = false;
    this.#serverVadAwaitingResponse = false;
    this.#interrupted = false;
    this.#diagnosticResponsePending = false;
    this.#invalidatePlaybackInterruption();
    this.#invalidateProviderTruncation();

    provider.binaryType = "arraybuffer";
    this.#provider = provider;
    this.#providerAttachedAtMs ??= Date.now();
    this.#providerConnections += 1;
    /*
     * A replacement provider has an empty input buffer even if its predecessor
     * received frames from the current physical press. Retaining the old count
     * would commit an empty buffer on the new generation. The media socket is
     * stable, but provider-buffer ownership is generation-scoped.
     */
    this.#uplinkFramesInTurn = 0;
    this.#manualResponseAuthorized = false;
    this.#manualResponseStarted = false;
    this.#unsolicitedResponseActive = false;
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

  /**
   * Reconciles Button B's call state without touching the device WebSocket.
   *
   * The device lane is boot-warm infrastructure; one Grok socket is the
   * disposable conversation. Conflating those lifetimes cost the physical
   * Stick 5.52 seconds of DNS/TLS/WebSocket work after every button press.
   * This method is idempotent because a replacement Cap'n Web callback first
   * supplies a state snapshot and can then observe the same edge again.
   */
  setConversationActive(active: boolean): boolean {
    if (this.#closed || active === this.#conversationActive) return false;
    this.#conversationActive = active;
    if (active) {
      this.#conversationStarts += 1;
      this.#conversationStartedAtMs = Date.now();
      this.#firstDevicePcmSentAtMs = null;
      this.#firstProviderPcmAtMs = null;
      this.#providerAttachedAtMs = null;
      this.#providerSessionReadyAtMs = null;
      this.#initialGreetingRequestedForConversation = false;
      this.#interrupted = false;
      this.#clearServerVadSpeechWindow();
      this.#clearServerVadResponseWait();
      this.#serverVadAwaitingResponse = false;
      this.#serverVadSpeechActive = false;
      this.#uplinkFramesInTurn = 0;
      this.#uplinkTurnActive = false;
      this.#manualResponseAuthorized = false;
      this.#manualResponseStarted = false;
      this.#unsolicitedResponseActive = false;
      this.#providerAssistantOutputItemId = null;
      this.#providerAudioPlayback = null;
      return true;
    }

    this.#conversationEnds += 1;
    this.#diagnosticResponsePending = false;
    this.#invalidatePlaybackInterruption();
    this.#invalidateProviderTruncation();
    this.#clearUplinkEndMarkerWait();
    this.#responseAfterCommitPending = false;
    this.#interrupted = false;
    this.#clearServerVadSpeechWindow();
    this.#clearServerVadResponseWait();
    this.#serverVadAwaitingResponse = false;
    this.#serverVadSpeechActive = false;
    this.#uplinkFramesInTurn = 0;
    this.#uplinkTurnActive = false;
    this.#manualResponseAuthorized = false;
    this.#manualResponseStarted = false;
    this.#unsolicitedResponseActive = false;
    this.#discardDownlinkQueue();
    this.#abandonProviderResponse();
    const provider = this.#provider;
    this.#provider = undefined;
    if (provider !== undefined) {
      this.#providerRetirements += 1;
      if (socketIsOpenOrConnecting(provider)) {
        provider.close(1000, "The device conversation ended.");
      }
    }
    return true;
  }

  inputStarted(): boolean {
    if (this.#closed) return false;
    if (this.#turnDetection === "server-vad") {
      this.#diagnostic(
        "unexpected-manual-turn-control",
        "error",
        "A manual input-start edge reached a provider-owned server-VAD session.",
      );
      return false;
    }
    /*
     * Cap'n Web and PCM use independent sockets, so this edge cannot open or
     * reset a media epoch. Production proved that even on a healthy network the
     * first PCM frame can arrive first. Retain the edge only for provenance and
     * the start/stop accounting used by the missing-marker watchdog; the first
     * non-empty PCM message performs interruption on the authoritative lane.
     */
    this.#uplinkControlStarts += 1;
    return true;
  }

  inputStopped(): boolean {
    if (this.#closed) return false;
    if (this.#turnDetection === "server-vad") {
      this.#diagnostic(
        "unexpected-manual-turn-control",
        "error",
        "A manual input-stop edge reached a provider-owned server-VAD session.",
      );
      return false;
    }
    this.#uplinkControlStops += 1;
    /*
     * A stop that arrives before its in-band media marker starts only a bounded
     * watchdog. A stop that arrives after the marker is already reconciled and
     * must not close whatever newer media turn may have begun meanwhile. The
     * monotonic counts, rather than a shared "pressed" boolean, make all legal
     * cross-socket reorderings idempotent.
     */
    this.#reconcileUplinkEndMarkerWatchdog();
    return true;
  }

  #reconcileUplinkEndMarkerWatchdog(): void {
    if (this.#uplinkControlStops <= this.#uplinkEndMarkers) {
      this.#clearUplinkEndMarkerWait();
      return;
    }
    if (this.#uplinkEndMarkerTimer !== undefined) return;
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
  }

  close(code = 1000, reason = "PCM session ended."): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#diagnosticResponsePending = false;
    this.#invalidatePlaybackInterruption();
    this.#invalidateProviderTruncation();
    this.#clearServerVadSpeechWindow();
    this.#clearServerVadResponseWait();
    this.#clearUplinkEndMarkerWait();
    this.#clearDownlinkReceiptWait();
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
    const acceptedDownlinkItems = decodePcmDownlinkReleaseReceipt(bytes);
    if (acceptedDownlinkItems !== null) {
      this.#handleDownlinkReceipt(acceptedDownlinkItems);
      return;
    }
    if (bytes?.byteLength === 0) {
      if (this.#turnDetection === "server-vad") {
        this.#uplinkEndMarkers += 1;
        this.#fail(
          "unexpected-uplink-end-marker",
          "Continuous AEC firmware emitted a manual PCM turn boundary into a server-VAD session.",
        );
        return;
      }
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
    if (this.#turnDetection === "manual" && !this.#uplinkTurnActive) {
      /*
       * The first non-empty message after connection or END is the only start
       * fact that is ordered with the microphone samples. Let it own the turn.
       * This deliberately makes Cap'n Web button latency irrelevant to media
       * conservation while still preserving those events as analytics.
       */
      this.#beginUplinkTurn();
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
    /*
     * The received MessageEvent owns this 640-byte payload; neither socket nor
     * the device can share its JavaScript memory after delivery. Mutating that
     * private frame avoids a 32 KiB/s allocation stream and adds no queue. The
     * provider WebSocket copies/accepts the bytes synchronously at send(), as
     * the existing zero-retention relay already requires. Keep raw and gained
     * aggregates in local scalars until send succeeds so a failed socket can
     * never make diagnostics claim that Grok accepted a louder frame.
     */
    let devicePeakSample = 0;
    let deviceNormalizedSquareSum = 0;
    let uplinkClippedSamples = 0;
    let uplinkPeakSample = 0;
    let uplinkNormalizedSquareSum = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += 2) {
      const unsigned = bytes[offset]! | (bytes[offset + 1]! << 8);
      const deviceSample = unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned;
      devicePeakSample = Math.max(devicePeakSample, Math.abs(deviceSample));
      const normalizedDeviceSample = deviceSample / 32_768;
      deviceNormalizedSquareSum += normalizedDeviceSample * normalizedDeviceSample;

      const amplifiedSample = deviceSample * this.#uplinkGainMultiplier;
      const uplinkSample = Math.max(-32_768, Math.min(32_767, amplifiedSample));
      if (uplinkSample !== amplifiedSample) uplinkClippedSamples += 1;
      uplinkPeakSample = Math.max(uplinkPeakSample, Math.abs(uplinkSample));
      const normalizedUplinkSample = uplinkSample / 32_768;
      uplinkNormalizedSquareSum += normalizedUplinkSample * normalizedUplinkSample;
      bytes[offset] = uplinkSample & 0xff;
      bytes[offset + 1] = (uplinkSample >> 8) & 0xff;
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
    try {
      /*
       * This callback is intentionally after the provider accepted the frame:
       * a diagnostic capture must never contain PCM that Grok did not receive.
       * It runs inline and receives the already-owned MessageEvent buffer, so
       * normal traffic pays no copy or queue; an opt-in recorder performs one
       * bounded copy into its preallocated evidence buffer.
       */
      /*
       * The ordinal belongs to provider acceptance, not device ingress. It is
       * passed before the lifetime counter is committed so a broken optional
       * observer cannot make the bridge skip or double-count media. The next
       * value is nevertheless deterministic here because this receive path is
       * synchronous and owns the counter.
       */
      this.#onAcceptedUplinkPcm?.(bytes, this.#uplinkFrames + 1);
    } catch (error) {
      /*
       * Diagnostics are an observer, never an audio owner. A recorder defect
       * is visible and invalidates that proof, but the already-accepted live
       * microphone frame must continue through the conversation.
       */
      this.#diagnostic("uplink-observer-failed", "error", {
        message: boundedErrorMessage(error),
      });
    }
    /*
     * Observe only after the provider socket accepted the frame. Sampling at
     * device ingress would make a backpressured/dropped frame look like audio
     * Grok had received and would defeat this metric's attribution purpose.
     * Device v1 frames are always complete little-endian int16 PCM, so this
     * path needs neither a trailing-byte state nor an audio-retention buffer.
     */
    const samples = bytes.byteLength / 2;
    this.#devicePcmPeakSample = Math.max(this.#devicePcmPeakSample, devicePeakSample);
    this.#devicePcmNormalizedSquareSum += deviceNormalizedSquareSum;
    this.#devicePcmSamples += samples;
    this.#uplinkPcmClippedSamples += uplinkClippedSamples;
    this.#uplinkPcmPeakSample = Math.max(this.#uplinkPcmPeakSample, uplinkPeakSample);
    this.#uplinkPcmNormalizedSquareSum += uplinkNormalizedSquareSum;
    this.#uplinkPcmSamples += samples;
    this.#uplinkFrames += 1;
    if (this.#turnDetection === "manual") this.#uplinkFramesInTurn += 1;
  }

  #handleDownlinkReceipt(acceptedItems: number): void {
    if (
      acceptedItems > this.#downlinkItemsSent ||
      acceptedItems < this.#downlinkItemsAcknowledged
    ) {
      /*
       * This count belongs to one ordered WebSocket generation. TCP cannot
       * reorder its messages, so a value ahead of what userspace sent or
       * behind what the same device already acknowledged is not packet loss:
       * it is an impossible peer ledger. Closing is intentional because
       * guessing credit here would put unmeasured speech back below send().
       */
      this.#fail(
        "invalid-device-receipt",
        "The device reported an impossible cumulative downlink receipt.",
        0,
        {
          acceptedItems,
          acknowledgedItems: this.#downlinkItemsAcknowledged,
          sentItems: this.#downlinkItemsSent,
        },
      );
      return;
    }

    this.#downlinkReceipts += 1;
    if (acceptedItems === this.#downlinkItemsAcknowledged) {
      /*
       * Coalescing is permitted in both directions, and a reconnecting sender
       * may repeat its latest cumulative fact. A duplicate proves no new
       * progress, so it grants no credit and—crucially—cannot postpone the
       * no-progress watchdog forever.
       */
      this.#downlinkDuplicateReceipts += 1;
      return;
    }

    for (
      let releasedItem = this.#downlinkItemsAcknowledged + 1;
      releasedItem <= acceptedItems;
      releasedItem += 1
    ) {
      const release = this.#downlinkReleaseLedger.get(releasedItem);
      if (release === undefined) {
        /*
         * Every admitted item is recorded before a MessageEvent can return its
         * cumulative hardware fact. A missing entry would make the provider
         * duration unknowable even though transport credit looked valid, so
         * do not silently grant that ambiguous credit.
         */
        this.#fail(
          "invalid-device-receipt",
          "The device receipt referred to an untracked downlink item.",
          0,
          { releasedItem },
        );
        return;
      }
      this.#downlinkReleaseLedger.delete(releasedItem);
      if (release.owner !== null) {
        release.owner.acknowledgedAudioBytes += release.audioBytes;
      }
    }
    this.#downlinkItemsAcknowledged = acceptedItems;
    this.#clearDownlinkReceiptWait();
    if (this.#downlinkItemsAcknowledged < this.#downlinkItemsSent) {
      this.#armDownlinkReceiptWait();
    }
    this.#scheduleDownlink();
  }

  #armDownlinkReceiptWait(): void {
    if (
      this.#closed ||
      this.#downlinkReceiptTimer !== undefined ||
      this.#downlinkItemsAcknowledged === this.#downlinkItemsSent
    ) {
      return;
    }
    this.#downlinkReceiptTimer = setTimeout(() => {
      this.#downlinkReceiptTimer = undefined;
      if (this.#closed || this.#downlinkItemsAcknowledged === this.#downlinkItemsSent) return;
      this.#downlinkReceiptTimeouts += 1;
      this.#fail(
        "downlink-device-receipt-timeout",
        "The device made no progress accepting the finite downlink window.",
        0,
        {
          acknowledgedItems: this.#downlinkItemsAcknowledged,
          inFlightItems: this.#downlinkItemsSent - this.#downlinkItemsAcknowledged,
          sentItems: this.#downlinkItemsSent,
          timeoutMs: DOWNLINK_RECEIPT_TIMEOUT_MS,
        },
      );
    }, DOWNLINK_RECEIPT_TIMEOUT_MS);
  }

  #clearDownlinkReceiptWait(): void {
    if (this.#downlinkReceiptTimer === undefined) return;
    clearTimeout(this.#downlinkReceiptTimer);
    this.#downlinkReceiptTimer = undefined;
  }

  #handleUplinkEndMarker(): void {
    this.#uplinkEndMarkers += 1;
    this.#reconcileUplinkEndMarkerWatchdog();
    if (!this.#uplinkTurnActive) {
      /*
       * The firmware preserves a quick press/release as an END even when no 20
       * ms frame was captured. Count and absorb it: committing an empty Grok
       * buffer can terminate an otherwise healthy conversation.
       */
      this.#emptyUplinkTurns += 1;
      this.#diagnostic(
        "empty-uplink-turn",
        "info",
        "The completed manual PTT turn contained no microphone frames and was not committed.",
      );
      return;
    }
    this.#uplinkTurnActive = false;
    this.#interrupted = false;
    this.#finishInputTurn();
  }

  #beginUplinkTurn(): void {
    this.#uplinkTurnActive = true;
    this.#uplinkTurns += 1;
    this.#uplinkFramesInTurn = 0;
    /*
     * A fresh media turn supersedes any released turn whose provider response
     * has not started. No turn queue is retained: delayed speech is less useful
     * than current speech, and every discarded response byte remains counted.
     */
    this.#responseAfterCommitPending = false;
    this.#manualResponseAuthorized = false;
    this.#manualResponseStarted = false;
    this.#unsolicitedResponseActive = false;
    this.#interrupted = true;
    this.#discardDownlinkQueue();
    const responseWasActive = this.#responseActive;
    this.#requestProviderTruncation();
    this.#abandonProviderResponse();
    /*
     * `response.cancel` targets a concrete response and Grok rejects it on an
     * idle generation. Only observed response activity is cancellable.
     */
    if (responseWasActive) this.#sendProviderControl("response.cancel");
  }

  #finishInputTurn(): boolean {
    const frames = this.#uplinkFramesInTurn;
    this.#uplinkFramesInTurn = 0;
    this.#clearUplinkEndMarkerWait();
    return frames !== 0 && this.#commitInputTurn();
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

  #handleServerVadSpeechStarted(): void {
    if (this.#serverVadSpeechActive) return;
    /*
     * Capture this before clearing the response reservoir below. A physical
     * purge is justified only by provider audio which can still reach the
     * speaker: bytes retained in userspace or non-empty ordered items not yet
     * released by the hardware clock. `responseActive` and `downlinkStarted`
     * are deliberately insufficient—both can remain true at lifecycle edges
     * where there is no audible sample left to destroy.
     *
     * HAVPE's XMOS consumes the playback I2S bus as its AEC reference. An
     * unconditional reset on the first caller utterance used to stop/restart
     * that reference even though the speaker was idle, immediately before the
     * first assistant reply. We still advance every semantic interruption and
     * discard every userspace byte; we omit only an empty hardware mutation.
     */
    const physicalPlaybackMayContainStaleAudio =
      this.#downlinkQueuedBytes > 0 ||
      [...this.#downlinkReleaseLedger.values()].some(({ audioBytes }) => audioBytes > 0);
    this.#clearServerVadResponseWait();
    this.#serverVadSpeechActive = true;
    this.#serverVadAwaitingResponse = false;
    this.#providerSpeechStarts += 1;
    this.#providerSpeechActiveSinceAtMs = Date.now();
    this.#serverVadSpeechTimer = setTimeout(() => {
      this.#serverVadSpeechTimer = undefined;
      this.#retireProviderAfterServerVadTimeout();
    }, SERVER_VAD_MAXIMUM_SPEECH_MS);
    this.#responseAfterCommitPending = false;
    this.#interrupted = true;
    /*
     * These bytes are not transport loss: the new near-end utterance makes
     * them semantically obsolete. Keep them in the total dropped-byte ledger
     * for exact conservation, but also classify the intentional subset so an
     * interruption proof can reject one unexplained byte without rejecting
     * the very purge it asked the system to perform.
     */
    this.#downlinkInterruptedBytes += this.#downlinkQueuedBytes;
    this.#discardDownlinkQueue();
    this.#requestProviderTruncation();
    this.#abandonProviderResponse();
    /*
     * A pending hardware purge is already the admission barrier for every
     * provider byte: both downlink schedulers refuse to send while it is set,
     * and the response-local reservoir was discarded immediately above. A
     * second speech edge therefore has no additional sample that a second
     * physical command could reach. Reusing the in-flight barrier is safer
     * than forwarding concurrent Cap'n Web calls, which the one-slot audio
     * owner correctly rejects, and it keeps the event visible as an explicit
     * coalescing metric instead of disguising it as a successful extra purge.
     */
    if (this.#playbackInterruptionPending) {
      this.#playbackInterruptionsCoalesced += 1;
      return;
    }
    if (!physicalPlaybackMayContainStaleAudio) {
      this.#playbackInterruptionsSkippedIdle += 1;
      return;
    }
    this.#playbackInterruptionsRequested += 1;
    const interruptionEpoch = ++this.#playbackInterruptionEpoch;
    this.#playbackInterruptionPending = true;
    let acknowledgement: Promise<void> | void;
    try {
      /*
       * Invoke the Cap'n Web reset immediately, but never await it in this
       * provider MessageEvent. Later provider audio must keep entering the
       * bounded userspace reservoir while the independent control socket makes
       * the physical speaker discard already-admitted samples. The playout
       * scheduler below is the barrier: it admits the fresh response only once
       * the device has acknowledged that reset.
       */
      acknowledgement = this.#onPlaybackInterruption();
    } catch (error) {
      this.#handlePlaybackInterruptionFailure(interruptionEpoch, error);
      return;
    }
    void Promise.resolve(acknowledgement).then(
      () => this.#handlePlaybackInterruptionAcknowledged(interruptionEpoch),
      (error: unknown) => this.#handlePlaybackInterruptionFailure(interruptionEpoch, error),
    );
  }

  #handlePlaybackInterruptionAcknowledged(interruptionEpoch: number): void {
    if (
      this.#closed ||
      interruptionEpoch !== this.#playbackInterruptionEpoch ||
      !this.#playbackInterruptionPending
    ) {
      return;
    }
    this.#playbackInterruptionPending = false;
    this.#playbackInterruptionsCompleted += 1;
    this.#scheduleDownlink();
  }

  #handlePlaybackInterruptionFailure(interruptionEpoch: number, error: unknown): void {
    if (
      this.#closed ||
      interruptionEpoch !== this.#playbackInterruptionEpoch ||
      !this.#playbackInterruptionPending
    ) {
      return;
    }
    this.#playbackInterruptionPending = false;
    this.#playbackInterruptionFailures += 1;
    this.#fail(
      "playback-interruption-failed",
      "The device did not acknowledge the physical playback reset.",
      0,
      { message: boundedErrorMessage(error) },
    );
  }

  #invalidatePlaybackInterruption(): void {
    /*
     * Promises cannot be cancelled, so every conversation boundary advances a
     * generation fence. A late acknowledgement may then settle harmlessly but
     * can never release audio belonging to a newer call or provider response.
     */
    this.#playbackInterruptionEpoch += 1;
    this.#playbackInterruptionPending = false;
  }

  #requestProviderTruncation(): void {
    if (this.#providerTruncationPending !== null) return;
    const playback = this.#providerAudioPlayback;
    if (playback === null) return;
    /*
     * A reset can bulk-release every discarded DMA slot through the ordinary
     * credit ledger. Freeze the duration before asking the device to reset so
     * those transport releases can never masquerade as audible history. PCM16
     * mono at 16 kHz contains exactly 32 bytes per millisecond; floor retains
     * only complete source time when a malformed provider ends mid-sample.
     */
    const pending: PendingProviderTruncation = {
      audioEndMs: Math.floor(
        (playback.acknowledgedAudioBytes * 1_000) / (ITERATE_KIT_PCM_SAMPLE_RATE_HZ * 2),
      ),
      contentIndex: playback.contentIndex,
      itemId: playback.itemId,
    };
    this.#providerTruncationPending = pending;
    if (
      !this.#sendProviderMessage({
        audio_end_ms: pending.audioEndMs,
        content_index: pending.contentIndex,
        item_id: pending.itemId,
        type: "conversation.item.truncate",
      })
    ) {
      this.#invalidateProviderTruncation();
      return;
    }
    this.#providerTruncationsRequested += 1;
    this.#providerTruncationTimer = setTimeout(() => {
      this.#providerTruncationTimer = undefined;
      if (this.#closed || this.#providerTruncationPending !== pending) return;
      this.#providerTruncationTimeouts += 1;
      this.#retireProviderAfterTruncationFailure(
        "provider-truncation-timeout",
        "Grok did not confirm conversation history truncation.",
        {
          audioEndMs: pending.audioEndMs,
          contentIndex: pending.contentIndex,
          itemId: pending.itemId,
          timeoutMs: PROVIDER_TRUNCATION_TIMEOUT_MS,
        },
      );
    }, PROVIDER_TRUNCATION_TIMEOUT_MS);
  }

  #handleProviderTruncated(event: { type: string }): void {
    const pending = this.#providerTruncationPending;
    if (pending === null) return;
    const acknowledgement = providerTruncatedAcknowledgement(event);
    if (
      acknowledgement === null ||
      acknowledgement.itemId !== pending.itemId ||
      acknowledgement.contentIndex !== pending.contentIndex ||
      acknowledgement.audioEndMs !== pending.audioEndMs
    ) {
      this.#retireProviderAfterTruncationFailure(
        "provider-truncation-invalid",
        "Grok confirmed a different conversation item than userspace truncated.",
        { acknowledgement, pending },
      );
      return;
    }
    this.#invalidateProviderTruncation();
    this.#providerTruncationsCompleted += 1;
    this.#scheduleDownlink();
  }

  #retireProviderAfterTruncationFailure(
    code: "provider-truncation-invalid" | "provider-truncation-timeout",
    reason: string,
    detail: unknown,
  ): void {
    const provider = this.#provider;
    this.#diagnostic(code, "error", detail);
    this.#invalidateProviderTruncation();
    if (provider === undefined) {
      this.#onProviderUnavailable();
      return;
    }
    this.#providerRetirements += 1;
    this.#detachProvider(provider, 4000, reason, "provider-closed");
    if (socketIsOpenOrConnecting(provider)) provider.close(4000, reason);
  }

  #invalidateProviderTruncation(): void {
    this.#providerTruncationPending = null;
    if (this.#providerTruncationTimer === undefined) return;
    clearTimeout(this.#providerTruncationTimer);
    this.#providerTruncationTimer = undefined;
  }

  #handleServerVadSpeechStopped(): void {
    if (!this.#serverVadSpeechActive) return;
    this.#serverVadSpeechActive = false;
    this.#clearServerVadSpeechWindow();
    this.#serverVadAwaitingResponse = true;
    this.#providerSpeechStops += 1;
  }

  #armServerVadResponseWait(provider: WebSocket): void {
    this.#clearServerVadResponseWait();
    this.#serverVadResponseTimer = setTimeout(() => {
      this.#serverVadResponseTimer = undefined;
      if (
        this.#closed ||
        this.#provider !== provider ||
        !this.#serverVadAwaitingResponse ||
        this.#serverVadSpeechActive ||
        this.#responseActive
      ) {
        return;
      }

      const reason = "Grok did not automatically start a response for the server-VAD turn.";
      this.#serverVadResponseTimeouts += 1;
      this.#serverVadAwaitingResponse = false;
      this.#interrupted = false;
      this.#diagnostic("server-vad-response-timeout", "error", {
        automaticResponseTimeoutMs: SERVER_VAD_RESPONSE_TIMEOUT_MS,
        recovery: "retire-provider-generation",
      });
      this.#providerRetirements += 1;
      this.#detachProvider(provider, 4000, reason, "provider-closed");
      if (socketIsOpenOrConnecting(provider)) provider.close(4000, reason);
    }, SERVER_VAD_RESPONSE_TIMEOUT_MS);
  }

  #clearServerVadResponseWait(): void {
    if (this.#serverVadResponseTimer === undefined) return;
    clearTimeout(this.#serverVadResponseTimer);
    this.#serverVadResponseTimer = undefined;
  }

  #clearServerVadSpeechWindow(): void {
    if (this.#providerSpeechActiveSinceAtMs !== null) {
      this.#providerSpeechMaximumDurationMs = Math.max(
        this.#providerSpeechMaximumDurationMs,
        Date.now() - this.#providerSpeechActiveSinceAtMs,
      );
      this.#providerSpeechActiveSinceAtMs = null;
    }
    if (this.#serverVadSpeechTimer === undefined) return;
    clearTimeout(this.#serverVadSpeechTimer);
    this.#serverVadSpeechTimer = undefined;
  }

  #retireProviderAfterServerVadTimeout(): void {
    if (this.#closed || !this.#serverVadSpeechActive) return;
    const provider = this.#provider;
    const reason = "Grok server VAD did not end the utterance within 60 seconds.";
    this.#serverVadSpeechActive = false;
    this.#serverVadAwaitingResponse = false;
    this.#interrupted = false;
    this.#providerSpeechTimeouts += 1;
    this.#clearServerVadSpeechWindow();
    this.#clearServerVadResponseWait();
    this.#diagnostic("server-vad-speech-timeout", "warn", {
      maximumSpeechMs: SERVER_VAD_MAXIMUM_SPEECH_MS,
      recovery: "retire-provider-generation",
    });

    if (provider === undefined) {
      this.#onProviderUnavailable();
      return;
    }
    this.#providerRetirements += 1;
    this.#detachProvider(provider, 4000, reason, "provider-closed");
    if (socketIsOpenOrConnecting(provider)) provider.close(4000, reason);
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
    if (this.#turnDetection === "manual" && !this.#manualResponseAuthorized) {
      this.#rejectUnsolicitedProviderResponse(bytes.byteLength);
      return;
    }
    if (this.#turnDetection === "manual") this.#manualResponseStarted = true;
    if (
      this.#turnDetection === "server-vad" &&
      this.#interrupted &&
      !this.#serverVadSpeechActive &&
      this.#serverVadAwaitingResponse
    ) {
      /*
       * response.created is useful lifecycle evidence but binary media is the
       * authoritative response start. Accept providers that omit/reorder the
       * optional event only after speech_stopped; doing this while speech is
       * still active would splice cancelled audio back into the interruption.
       */
      this.#serverVadAwaitingResponse = false;
      this.#clearServerVadResponseWait();
      this.#interrupted = false;
    }
    /*
     * A binary chunk is conclusive response activity even if a provider omits
     * or reorders its optional response.created event. This conservative
     * observation preserves interruption while avoiding speculative cancel on
     * a fresh socket.
     */
    if (!this.#responseActive) this.#beginProviderResponse();
    this.#responseActive = true;
    if (bytes.byteLength > 0) {
      this.#providerResponseHadPcm = true;
      this.#firstProviderPcmAtMs ??= Date.now();
    }
    this.#observeProviderPcm(bytes);
    if (this.#interrupted) {
      this.#downlinkInterruptedBytes += bytes.byteLength;
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
    if (event.type === "session.updated") {
      this.#providerSessionReadyAtMs ??= Date.now();
      this.#requestInitialGreeting();
      return;
    }
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
    if (event.type === "response.output_item.added") {
      const item = providerAssistantOutputItem(event);
      if (item !== null) this.#providerAssistantOutputItemId = item.itemId;
      return;
    }
    if (event.type === "response.content_part.added") {
      const part = providerAssistantAudioContentPart(event);
      if (part !== null && part.itemId === this.#providerAssistantOutputItemId) {
        /*
         * Raw binary PCM deliberately carries no duplicated JSON envelope.
         * xAI orders this content-part event before those bytes, so one small
         * response-scoped owner is sufficient; copying an item ID alongside
         * every byte in the bounded source reservoir would add metadata
         * proportional to generated speech for no extra information.
         */
        this.#providerAudioPlayback = {
          acknowledgedAudioBytes: 0,
          contentIndex: part.contentIndex,
          itemId: part.itemId,
        };
      }
      return;
    }
    if (event.type === "conversation.item.truncated") {
      this.#handleProviderTruncated(event);
      return;
    }
    if (
      this.#turnDetection === "server-vad" &&
      event.type === "input_audio_buffer.speech_started"
    ) {
      this.#handleServerVadSpeechStarted();
      return;
    }
    if (
      this.#turnDetection === "server-vad" &&
      event.type === "input_audio_buffer.speech_stopped"
    ) {
      this.#handleServerVadSpeechStopped();
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      this.#clearServerVadResponseWait();
      this.#handleProviderFunctionCall(provider, event);
      return;
    }
    if (event.type === "input_audio_buffer.committed") {
      if (this.#turnDetection === "server-vad" && this.#serverVadAwaitingResponse) {
        this.#armServerVadResponseWait(provider);
        return;
      }
      if (!this.#responseAfterCommitPending) return;
      this.#responseAfterCommitPending = false;
      if (!this.#interrupted) this.#sendProviderControl("response.create");
      return;
    }
    if (event.type === "response.created") {
      this.#clearServerVadResponseWait();
      this.#providerAssistantOutputItemId = null;
      this.#providerAudioPlayback = null;
      if (this.#turnDetection === "manual" && !this.#manualResponseAuthorized) {
        this.#rejectUnsolicitedProviderResponse();
        return;
      }
      if (this.#turnDetection === "manual") this.#manualResponseStarted = true;
      if (
        this.#turnDetection === "server-vad" &&
        this.#interrupted &&
        !this.#serverVadSpeechActive &&
        this.#serverVadAwaitingResponse
      ) {
        this.#serverVadAwaitingResponse = false;
        this.#interrupted = false;
      }
      this.#beginProviderResponse();
      this.#responseActive = true;
      return;
    }
    if (event.type !== "response.done") return;
    const responseStatus = providerResponseStatus(event);
    if (this.#turnDetection === "manual" && !this.#manualResponseAuthorized) {
      this.#unsolicitedResponseActive = false;
      this.#discardDownlinkQueue();
      this.#abandonProviderResponse();
      return;
    }
    if (
      this.#turnDetection === "manual" &&
      !(responseStatus === "cancelled" && !this.#manualResponseStarted)
    ) {
      /*
       * One successful response.create authorizes exactly one response. xAI
       * may report the prior cancelled generation immediately before the new
       * response.created; retain authorization only for that explicitly
       * observed no-start cancellation. Every completed/failed/started result
       * consumes it, so a second provider response cannot ride the same PTT.
       */
      this.#manualResponseAuthorized = false;
      this.#manualResponseStarted = false;
    }
    this.#responseActive = false;

    if (this.#turnDetection === "server-vad" && this.#interrupted) {
      if (responseStatus === "cancelled") {
        this.#providerResponsesCancelled += 1;
      } else if (responseStatus !== null && responseStatus !== "completed") {
        this.#providerResponsesFailed += 1;
        this.#diagnostic("provider-response-failed", "error", { status: responseStatus });
      }
      /*
       * xAI owns cancellation after speech_started. Its old response.done may
       * arrive before speech_stopped/new response.created; clearing the
       * interruption here would admit a late binary tail. The physical reset
       * callback already destroyed admitted speaker state, so retain the fence
       * until the next provider response begins.
       */
      this.#discardDownlinkQueue();
      this.#abandonProviderResponse();
      return;
    }

    if (responseStatus !== null && responseStatus !== "completed") {
      if (responseStatus === "cancelled") {
        this.#providerResponsesCancelled += 1;
      } else {
        this.#providerResponsesFailed += 1;
        this.#diagnostic("provider-response-failed", "error", { status: responseStatus });
      }
      /*
       * A cancelled response.done is a provider lifecycle boundary, not proof
       * of audible speech. xAI can emit one immediately before response.created
       * for the actual manual-PTT answer. With no PCM there is consequently no
       * device boundary to send; abandoning the generation prevents a physical
       * harness from hanging up on a phantom answer. If any PCM did enter this
       * response, discard its stale tail and terminate the device response
       * explicitly so partial speech cannot splice into whatever follows.
       */
      const responseHadPcm =
        this.#providerResponseHadPcm || this.#downlinkQueuedBytes > 0 || this.#downlinkStarted;
      this.#discardDownlinkQueue();
      if (this.#interrupted) {
        this.#providerResponseDone = true;
        this.#downlinkResponseDone = true;
        this.#scheduleDownlink();
        return;
      }
      if (responseHadPcm) {
        this.#providerResponseDone = true;
        this.#downlinkResponseDone = true;
        this.#scheduleDownlink();
        return;
      }
      this.#abandonProviderResponse();
      return;
    }

    /*
     * Deterministic in-repo providers predate xAI's nested response.status and
     * intentionally emit only {type: response.done}; absence therefore keeps
     * the established completed contract. An explicit non-completed status is
     * classified above and can never advance this counter.
     */
    this.#providerResponsesCompleted += 1;
    if (this.#interrupted) {
      this.#discardDownlinkQueue();
      this.#providerResponseDone = true;
      this.#downlinkResponseDone = true;
      this.#scheduleDownlink();
      return;
    }
    this.#providerResponseDone = true;
    this.#downlinkResponseDone = true;
    this.#scheduleDownlink();
  }

  #handleProviderFunctionCall(provider: WebSocket, event: { type: string }): void {
    if (this.#turnDetection === "manual" && !this.#manualResponseAuthorized) {
      this.#rejectUnsolicitedProviderResponse();
      return;
    }
    if (this.#turnDetection === "manual") this.#manualResponseStarted = true;
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
    this.#diagnosticResponsePending = false;
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
       * healthy answer. The provider generation owns this finite response,
       * however; the device WebSocket does not. Retiring only that generation
       * preserves freshness and exact loss accounting without turning one
       * overlong answer into Wi-Fi/TLS churn or a dead physical call.
       */
      this.#retireProviderAfterDownlinkOverflow(bytes.byteLength);
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

  #retireProviderAfterDownlinkOverflow(incomingBytes: number): void {
    const provider = this.#provider;
    const reason =
      "The bounded userspace playback reservoir filled before realtime playout caught up.";
    this.#downlinkDroppedBytes += incomingBytes;
    this.#diagnostic(
      "downlink-overflow",
      "error",
      {
        capacityBytes: this.#downlinkQueue.byteLength,
        incomingBytes,
        queuedBytes: this.#downlinkQueuedBytes,
        scope: "provider-response-reservoir",
      },
      incomingBytes,
    );

    /*
     * Revoke the upstream identity before closing it. Its close event and any
     * already-enqueued binary MessageEvents then fail the generation fence in
     * attachProvider(), while detachProvider() atomically accounts for and
     * discards the response tail that still occupied the reservoir.
     */
    if (provider !== undefined) {
      this.#providerRetirements += 1;
      this.#detachProvider(provider, 4000, reason, "provider-closed");
    } else {
      this.#abandonProviderResponse();
      this.#discardDownlinkQueue();
    }

    /*
     * The finite lead already admitted to the physical device is valid audio,
     * but it needs an ordinary response boundary so firmware cannot wait for a
     * marker that an aborted provider will never produce. The marker occupies
     * the same ordered device lane as PCM and therefore waits for explicit
     * credit instead of slipping past an already-full transport window.
     */
    /*
     * The provider generation is gone, but the device still needs one ordered
     * end marker for the audio already admitted to its hardware lane. This is
     * deliberately separate from `downlinkResponseDone`: that flag describes
     * the bytes currently in the source reservoir. Reusing it let an eagerly
     * attached replacement append new PCM behind a full credit window and
     * inherit the retired response's completion state, bypassing the source
     * watermark and splicing two generations into one physical response.
     *
     * No second queue is needed. The marker consumes the next ordinary
     * hardware credit, so TCP ordering makes it precede any replacement PCM
     * already waiting in the existing bounded reservoir.
     */
    this.#downlinkRetiredBoundaryPending = true;
    this.#scheduleDownlink();
    if (provider && socketIsOpenOrConnecting(provider)) {
      provider.close(4000, reason);
    }
  }

  #scheduleDownlink(): void {
    if (
      this.#closed ||
      (this.#interrupted &&
        !this.#downlinkRetiredBoundaryPending &&
        !(this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0)) ||
      this.#playbackInterruptionPending ||
      this.#providerTruncationPending !== null
    ) {
      return;
    }
    if (this.#downlinkRetiredBoundaryPending) {
      /*
       * A replacement provider may already have filled the source reservoir,
       * but this zero-length item belongs to the retired generation. Admit it
       * first through the same credit ledger; never infer that a JavaScript
       * callback ran early enough or let replacement bytes jump the boundary.
       */
      if (!this.#sendDevice(pcmEndOfResponse)) return;
      this.#downlinkRetiredBoundaryPending = false;
    }
    if (!this.#downlinkStarted) {
      if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
        this.#finishDownlinkResponse();
        return;
      }
      const startupBytes = ITERATE_KIT_PCM_FRAME_BYTES * this.#downlinkSourceStartupFrames;
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
    }

    /*
     * There is deliberately no JavaScript media timer here. The codec DMA is
     * the only clock that can prove a playout slot elapsed, and firmware turns
     * each hardware-consumed item into one cumulative receipt. Draining one
     * finite credit window synchronously keeps the device supplied without an
     * unbounded callback loop: at most DEVICE_INITIAL_LEAD_FRAMES items can
     * cross before the next physical release fact is required.
     */
    while (this.#hasDownlinkCredit()) {
      const hasCompleteFrame = this.#downlinkQueuedBytes >= ITERATE_KIT_PCM_FRAME_BYTES;
      const hasFinalPartialFrame = this.#downlinkResponseDone && this.#downlinkQueuedBytes > 0;
      if (!hasCompleteFrame && !hasFinalPartialFrame) break;
      if (!this.#sendQueuedDownlinkFrame()) return;
    }
    if (this.#downlinkResponseDone && this.#downlinkQueuedBytes === 0) {
      this.#finishDownlinkResponse();
    }
  }

  #sendQueuedDownlinkFrame(): boolean {
    const copiedBytes = Math.min(ITERATE_KIT_PCM_FRAME_BYTES, this.#downlinkQueuedBytes);
    if (copiedBytes === 0) return false;
    if (!this.#hasDownlinkCredit()) {
      this.#downlinkCreditBlocked += 1;
      return false;
    }

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
    /*
     * Do not advance the inspectable reservoir until send() succeeds. A
     * credit stall is normal flow control, and a synchronous socket failure
     * closes the bridge and lets discardDownlinkQueue() account this exact
     * still-owned frame with the rest of the response.
     */
    if (!this.#sendDevice(frame, copiedBytes)) return false;
    this.#downlinkReadOffset =
      (this.#downlinkReadOffset + copiedBytes) % this.#downlinkQueue.byteLength;
    this.#downlinkQueuedBytes -= copiedBytes;
    return true;
  }

  #finishDownlinkResponse(): boolean {
    if (!this.#sendDevice(pcmEndOfResponse)) return false;
    this.#downlinkResponseDone = false;
    this.#downlinkStarted = false;
    this.#interrupted = false;
    this.#providerResponsePlaybackFinished = true;
    this.#continueAfterProviderFunctionCalls();
    return true;
  }

  #discardDownlinkQueue(): void {
    this.#downlinkDroppedBytes += this.#downlinkQueuedBytes;
    this.#downlinkQueuedBytes = 0;
    this.#downlinkReadOffset = 0;
    this.#downlinkResponseDone = false;
    /* A physical interruption or call end supersedes every prior boundary. */
    this.#downlinkRetiredBoundaryPending = false;
    this.#downlinkStarted = false;
    this.#downlinkWriteOffset = 0;
  }

  #sendDevice(bytes: Uint8Array, providerAudioBytes = 0): boolean {
    if (!socketIsOpen(this.#device)) {
      this.#downlinkDroppedBytes += bytes.byteLength;
      this.#fail(
        "device-closed",
        "Device egress closed before the current playback frame could be sent.",
        bytes.byteLength,
      );
      return false;
    }

    if (!this.#hasDownlinkCredit()) {
      this.#downlinkCreditBlocked += 1;
      return false;
    }
    if (this.#downlinkItemsSent >= DOWNLINK_ITEM_COUNTER_MAXIMUM) {
      /*
       * Receipt v1 deliberately uses a four-byte cumulative count. At fifty
       * items per second this needs years of one uninterrupted socket, but a
       * wrap would turn old acknowledgements into apparently fresh credit.
       * End that generation explicitly instead of carrying an ambiguous
       * ledger across the integer boundary.
       */
      this.#fail(
        "downlink-item-counter-exhausted",
        "The PCM generation exhausted its cumulative downlink item counter.",
      );
      return false;
    }
    try {
      this.#device.send(bytes);
    } catch (error) {
      this.#fail("socket-error", "Device WebSocket rejected the current downlink item.", 0, {
        message: boundedErrorMessage(error),
      });
      return false;
    }
    const hadOutstandingItem = this.#downlinkItemsAcknowledged < this.#downlinkItemsSent;
    this.#downlinkItemsSent += 1;
    this.#downlinkReleaseLedger.set(this.#downlinkItemsSent, {
      audioBytes: providerAudioBytes,
      owner: providerAudioBytes === 0 ? null : this.#providerAudioPlayback,
    });
    const inFlightItems = this.#downlinkItemsSent - this.#downlinkItemsAcknowledged;
    this.#downlinkMaximumInFlightItems = Math.max(
      this.#downlinkMaximumInFlightItems,
      inFlightItems,
    );
    if (!hadOutstandingItem) this.#armDownlinkReceiptWait();
    if (bytes.byteLength > 0) {
      this.#downlinkFrames += 1;
      this.#firstDevicePcmSentAtMs ??= Date.now();
    }
    return true;
  }

  #hasDownlinkCredit(): boolean {
    return this.#downlinkItemsSent - this.#downlinkItemsAcknowledged < DEVICE_INITIAL_LEAD_FRAMES;
  }

  #requestInitialGreeting(): void {
    if (
      !this.#conversationActive ||
      this.#initialGreeting === undefined ||
      this.#initialGreetingRequestedForConversation
    ) {
      return;
    }
    /*
     * The provider acknowledgement above is the first instant at which its
     * native PCM format, voice, tools, and server-VAD policy are known to be
     * installed. Manual PTT deliberately rejects this option at construction;
     * this hook remains only for measured full-duplex/AEC experiments. xAI's
     * force_message is intentionally used instead of a
     * synthetic user instruction plus response.create: the physical proof
     * showed that the latter remains in conversation context and can make
     * every later answer repeat the greeting. A normal greeting must remain
     * interruptible: xAI documents non-interruptible force messages as
     * discarding caller audio, and using that to hide an unsettled AEC path
     * converts a DSP defect into deliberate user-input loss. The counter is a
     * call-lifetime fence, so a replacement provider cannot surprise the user
     * by greeting them again mid-conversation. It resets only on the next
     * explicit call; the public counter remains cumulative for diagnostics.
     */
    const itemSent = this.#sendProviderMessage({
      item: {
        content: [
          {
            text: this.#initialGreeting,
            type: "output_text",
          },
        ],
        interruptible: true,
        role: "assistant",
        type: "force_message",
      },
      type: "conversation.item.create",
    });
    if (!itemSent) return;
    this.#initialGreetingRequestedForConversation = true;
    this.#initialGreetingRequests += 1;
  }

  #rejectUnsolicitedProviderResponse(pcmBytes = 0): void {
    if (pcmBytes > 0) {
      this.#providerUnsolicitedPcmBytes += pcmBytes;
      this.#downlinkDroppedBytes += pcmBytes;
    }
    if (this.#unsolicitedResponseActive) return;
    this.#unsolicitedResponseActive = true;
    this.#providerUnsolicitedResponses += 1;
    /*
     * In manual mode the only legal response edge is our own response.create
     * after a non-empty microphone turn was committed and acknowledged. Raw
     * provider events have already been journaled before this guard runs, so
     * cancelling here is both fail-closed for the speaker and fully
     * attributable. Keeping the socket alive lets the next real PTT turn
     * recover without an unnecessary credential/TLS reconnect.
     */
    this.#diagnostic(
      "unsolicited-provider-response",
      "error",
      "Manual PTT provider speech arrived without an authorized response.create.",
      pcmBytes,
    );
    this.#sendProviderControl("response.cancel");
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
    if (type === "response.create") {
      this.#providerResponseCreateMessagesSent += 1;
      if (this.#turnDetection === "manual") {
        this.#manualResponseAuthorized = true;
        this.#manualResponseStarted = false;
        this.#unsolicitedResponseActive = false;
      }
    }
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
    this.#invalidatePlaybackInterruption();
    this.#invalidateProviderTruncation();
    this.#clearServerVadSpeechWindow();
    this.#clearServerVadResponseWait();
    this.#serverVadSpeechActive = false;
    this.#serverVadAwaitingResponse = false;
    this.#interrupted = false;
    this.#diagnosticResponsePending = false;
    this.#clearUplinkEndMarkerWait();
    this.#responseAfterCommitPending = false;
    this.#manualResponseAuthorized = false;
    this.#manualResponseStarted = false;
    this.#unsolicitedResponseActive = false;
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

function providerResponseStatus(event: { type: string }): string | null {
  /*
   * Only response.done calls this guard. Keeping the provider-owned nested
   * object unknown until this boundary avoids teaching the realtime bridge a
   * broad, brittle copy of xAI's response schema while still classifying the
   * one field that changes whether an answer was actually completed.
   */
  if (!("response" in event) || typeof event.response !== "object" || event.response === null) {
    return null;
  }
  return selectedBoundedString(event.response, "status");
}

function providerAssistantOutputItem(event: { type: string }): { itemId: string } | null {
  if (!("item" in event) || typeof event.item !== "object" || event.item === null) return null;
  const itemId = selectedBoundedString(event.item, "id");
  if (
    itemId === null ||
    selectedBoundedString(event.item, "role") !== "assistant" ||
    selectedBoundedString(event.item, "type") !== "message"
  ) {
    return null;
  }
  return { itemId };
}

function providerAssistantAudioContentPart(event: {
  type: string;
}): { contentIndex: number; itemId: string } | null {
  if (
    !("part" in event) ||
    typeof event.part !== "object" ||
    event.part === null ||
    selectedBoundedString(event.part, "type") !== "audio" ||
    !("item_id" in event) ||
    typeof event.item_id !== "string" ||
    event.item_id.length === 0 ||
    event.item_id.length > 256 ||
    !("content_index" in event) ||
    !Number.isSafeInteger(event.content_index) ||
    (event.content_index as number) < 0
  ) {
    return null;
  }
  return {
    contentIndex: event.content_index as number,
    itemId: event.item_id,
  };
}

function providerTruncatedAcknowledgement(event: {
  type: string;
}): { audioEndMs: number; contentIndex: number; itemId: string } | null {
  if (
    !("audio_end_ms" in event) ||
    !Number.isSafeInteger(event.audio_end_ms) ||
    (event.audio_end_ms as number) < 0 ||
    !("item_id" in event) ||
    typeof event.item_id !== "string" ||
    event.item_id.length === 0 ||
    event.item_id.length > 256 ||
    !("content_index" in event) ||
    !Number.isSafeInteger(event.content_index) ||
    (event.content_index as number) < 0
  ) {
    return null;
  }
  return {
    audioEndMs: event.audio_end_ms as number,
    contentIndex: event.content_index as number,
    itemId: event.item_id,
  };
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
 * properties. Workerd's server-side socket likewise has no bufferedAmount.
 * Device correctness consequently never calls socketBufferedAmount: its
 * explicit cumulative receipt is the only finite egress ledger. The helper
 * remains for the outbound provider socket, where an absent value means that
 * this optional early warning is unavailable; send failure and the no-retry
 * microphone policy remain the authoritative provider-side outcomes.
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
