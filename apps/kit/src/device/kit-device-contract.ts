export type KitPcmUplinkRestartReason =
  | "none"
  | "producer_backpressure"
  | "transport_disconnected"
  | "no_progress_timeout"
  | "frame_send_timeout"
  | "capture_stale";

/**
 * Buffer values carry their evidence strength because ESP-IDF does not expose
 * live occupancy at every egress layer. Consumers must never interpret a zero
 * from an opaque TLS or Wi-Fi queue as proof that the queue is empty.
 */
export type KitBufferMetricEvidence = "observed" | "derivedBound" | "capacityOnly" | "unavailable";

export interface KitBufferMetrics {
  evidence: KitBufferMetricEvidence;
  /** Current occupancy in bytes, or zero when the evidence says unavailable. */
  current: number;
  /** Largest occupancy observed since boot, in bytes. */
  highWater: number;
  /** Configured or derived capacity in bytes. */
  capacity: number;
}

export interface KitAudioMetrics {
  capture: {
    sent: number;
    dropped: number;
    failures: number;
  };
  uplink: {
    sent: number;
    dropped: number;
    depth: number;
    highWater: number;
    sendDeferrals: number;
    consecutiveSendDeferrals: number;
    maximumConsecutiveSendDeferrals: number;
    /** Stale epochs purged before any cancelled WebSocket byte reached TLS. */
    inPlaceFreshnessRecoveries: number;
    /** Freshness or disconnect recoveries that had to replace the socket. */
    socketRestarts: number;
    restartIncidents: number;
    producerBackpressureRestarts: number;
    transportDisconnectRestarts: number;
    noProgressTimeoutRestarts: number;
    frameSendTimeoutRestarts: number;
    captureStaleRestarts: number;
    lastTransportAcceptAgeMs: number;
    maximumTransportAcceptAgeMs: number;
    lastRestartOldestCaptureAgeMs: number;
    lastRestartReason: KitPcmUplinkRestartReason;
    lastRestartFramesDiscarded: number;
    failures: number;
  };
  downlink: {
    received: number;
    dropped: number;
    depth: number;
    highWater: number;
    failures: number;
  };
  /**
   * Present only when the hardware owner can conserve discrete 20 ms content
   * frames through physical submission/completion. Transport-only zeros are
   * not measurements and therefore must be represented by absence.
   */
  playback?: {
    submitted: number;
    completed: number;
    flushed: number;
    depth: number;
    highWater: number;
    failures: number;
  };
  protocolFailures: number;
  /**
   * Optional only for compatibility with capability drivers that predate
   * cross-layer buffer telemetry. Current Iterate PCM transports publish every
   * layer, using `unavailable` instead of silently omitting opaque queues.
   *
   * These views are not additive. A partially written PCM frame is retained in
   * the application ring while its masked copy occupies the WebSocket writer,
   * so those two values can overlap by one frame. Opaque lower transports are
   * deliberately labelled capacity-only or unavailable; a WebSocket PONG is
   * not promoted into a fictional peer-delivery queue measurement.
   */
  buffers?: {
    uplinkApplication: KitBufferMetrics;
    websocketTransmitter: KitBufferMetrics;
    lwipSend: KitBufferMetrics;
    tlsEgress: KitBufferMetrics;
    wifiEgress: KitBufferMetrics;
  };
}

export interface KitMetrics {
  uptimeMs: number;
  freeHeapBytes: number;
  minimumFreeHeapBytes: number;
  freeInternalHeapBytes: number;
  minimumFreeInternalHeapBytes: number;
  freePsramBytes: number;
  taskStackHighWaterBytes: number;
  cpuPermille: number;
  audio?: KitAudioMetrics;
}

/**
 * Latest bounded direct-speaker evidence from the device audio owner.
 *
 * This is a second view over the same once-per-second device sample, not a
 * second sampler or a telemetry queue. It remains separate from KitMetrics
 * because the complete maximum-width representation does not fit safely in
 * the firmware control lane's fixed 2 KiB message slot. Consumers should
 * flatten names only when writing a retained proof artifact; keeping the wire
 * form grouped avoids repeated prefixes and permanent device RAM growth.
 */
export interface KitPlaybackMetrics {
  schemaVersion: 5;
  sequence: number;
  producedAtMs: number;
  downlinkAccepted: number;
  playback: {
    submitted: number;
    completed: number;
    generationFramesFlushed: number;
    freshnessFramesDropped: number;
    partialPrebufferFramesDropped: number;
    underrunFramesFlushed: number;
    underrunIncidents: number;
    underrunSilenceFramesSubmitted: number;
    underrunSilenceFramesCompleted: number;
    underrunSilenceFramesRetired: number;
    underrunLateFramesDropped: number;
    dmaDeadlineMissIncidents: number;
    freshnessIncidents: number;
    partialPrebufferIncidents: number;
    endOfStreamMarkersConsumed: number;
    endOfStreamResponses: number;
    endOfStreamSilenceDescriptors: number;
    endOfStreamPaddingDescriptorsCompleted: number;
    driverQueueOverflowIncidents: number;
    driverFailures: number;
    driverStopFailures: number;
    fatalFramesFlushed: number;
    writeBackpressureIncidents: number;
    writeBackpressureDestructiveResets: number;
    writeBackpressureFramesDropped: number;
    invalidFrames: number;
    stateErrors: number;
    ownerClockRegressions: number;
    receiveToDmaStartSamples: number;
    maximumReceiveToDmaStartMs: number;
    downlinkInterarrivalSamples: number;
    maximumDownlinkInterarrivalMs: number;
    maximumEofToSuccessfulRefillUs: number;
    maximumWriteCallDurationUs: number;
    minimumReuseLeadAtSuccessfulRefillUs: number;
  };
  runtime: {
    audioOwnerStackHeadroomBytes: number;
    mainStackHeadroomBytes: number;
    controlNetworkStackHeadroomBytes: number;
    pcmNetworkStackHeadroomBytes: number;
    freeInternalHeapBytes: number;
    minimumFreeInternalHeapBytes: number;
    freeDmaHeapBytes: number;
    minimumFreeDmaHeapBytes: number;
    largestFreeInternalHeapBlockBytes: number;
    largestFreeDmaBlockBytes: number;
    cpuPermille: number;
    generationFenceAcknowledgementTimeouts: number;
    lifecycleAcknowledgementTimeouts: number;
    controlNetworkStackExhaustions: number;
    pcmNetworkStackExhaustions: number;
    /**
     * Cumulative calls into and positive-byte chunks from the PCM socket
     * receive path. Compare their deltas with downlinkAccepted: this separates
     * a task that did not run, a socket with no bytes ready, and raw bytes that
     * did not yet complete another WebSocket message.
     */
    pcmReceiveCalls: number;
    pcmReceiveChunks: number;
    controlNetworkMaximumWorkCycles: number;
    pcmNetworkMaximumWorkCycles: number;
  };
}

/**
 * One device-clocked AEC signal window.
 *
 * All six amplitudes come from identical sampled positions before and after
 * AEC. A harness can therefore distinguish weak capture from aggressive
 * suppression and derive an echo-suppression ratio during speaker-only
 * intervals. Sequence zero is the explicitly partial startup window; completed
 * one-second windows begin at one and may be repeated when a callback poll
 * lands before the audio owner rotates again.
 */
export interface KitAecMetrics {
  schemaVersion: 1;
  sequence: number;
  windowStartedAtMs: number;
  producedAtMs: number;
  sampleStride: number;
  sampledSamples: number;
  nearPeak: number;
  referencePeak: number;
  cleanPeak: number;
  nearMeanAbsolute: number;
  referenceMeanAbsolute: number;
  cleanMeanAbsolute: number;
  lifetimeFramesProcessed: number;
  lifetimeRecreates: number;
  lifetimeRecreateFailures: number;
  lastLinearUs: number;
  maximumLinearUs: number;
  lastNlpUs: number;
  maximumNlpUs: number;
  lastCaptureToUplinkUs: number;
  maximumCaptureToUplinkUs: number;
  lifetimeCaptureReserveDroppedChunks: number;
  lifetimeCaptureBridgeErrors: number;
  lifetimeSignalMeasurementFailures: number;
}

/**
 * Latest-state proof from a talking-head display owner.
 *
 * Mailbox overwrites and analyzer sequence gaps are intentional visual
 * load-shedding: the face jumps to current playout instead of accumulating
 * delay. Failures, timeouts, or counters that stop advancing during audible
 * playback are defects. `mouthOpenRenderedFrames` counts only frames whose LCD
 * transfer completed, so retained pixels from an earlier boot cannot pass the
 * production harness.
 */
export interface KitAvatarMetrics {
  schemaVersion: 1;
  producedAtMs: number;
  ready: boolean;
  playoutObservations: number;
  malformedObservations: number;
  mailboxOverwrites: number;
  mailboxFailures: number;
  analyzerFrames: number;
  analyzerSequenceGaps: number;
  mouthOpenRenderedFrames: number;
  snapshotRaces: number;
  renderedFrames: number;
  renderFailures: number;
  displayTransfers: number;
  displayTransferFailures: number;
  displayTransferTimeouts: number;
  maximumHandoffDelayUs: number;
  maximumAnalyzerUs: number;
  maximumRenderUs: number;
  maximumDisplayTransferUs: number;
  analyzerStackMinimumFreeBytes: number;
  physicalPlayoutSampleClock: number;
  currentAvatarIndex: number;
  framebufferBytes: number;
}

/**
 * Aligned AEC evidence from a hardware coprocessor with a private reference.
 *
 * HAVPE's XMOS publishes an original microphone and its selected processed
 * AEC+IC+NS output on one I2S edge, but not the far-end reference it used
 * internally. The two channels are simultaneous but intentionally have
 * different gain, so consumers must calibrate the processed/raw transfer on a
 * near-end interval before interpreting a far-end interval. The topology is
 * explicit and reference fields are absent. `playbackContentSamples` is
 * physical non-silence submitted during this exact signal window; it lets an
 * acceptance harness select far-end intervals without misrepresenting
 * intended PCM as a measured hardware tap.
 */
export interface KitRawCleanAecMetrics {
  schemaVersion: 3;
  topology: "raw-clean";
  sequence: number;
  windowStartedAtMs: number;
  producedAtMs: number;
  sampleStride: number;
  sampledSamples: number;
  rawPeak: number;
  cleanPeak: number;
  rawMeanAbsolute: number;
  cleanMeanAbsolute: number;
  /** Exact sampled absolute-magnitude totals; means alone lose quiet-signal precision. */
  rawAbsoluteSum: number;
  cleanAbsoluteSum: number;
  playbackContentSamples: number;
  lifetimeCaptureFrames: number;
  lifetimeCleanUplinkFrames: number;
  lifetimeCleanUplinkDrops: number;
  lifetimeCaptureFailures: number;
  lifetimeSignalMeasurementFailures: number;
  lastCaptureToUplinkUs: number;
  maximumCaptureToUplinkUs: number;
}

/**
 * Raw ESP WebSocket error categories. Keep the numeric SDK value on the wire
 * and map it only for display: the accompanying TLS, errno, handshake, and
 * close fields live in different domains and must not be collapsed into one
 * generic JavaScript exception.
 */
export type KitControlWebsocketErrorType = 0 | 1 | 2 | 3 | 4;

/** Operation which observed the retained terminal PCM transport incident. */
export type KitPcmTransportFailureOperation = 0 | 1 | 2 | 3;

/**
 * Exact `capnweb_status` integer domain from the C peer. Keep it numeric on
 * the recovery endpoint so diagnostics cannot accidentally conflate a local
 * bounded-transport failure with an ESP-IDF error code.
 */
export type KitCapnwebStatus = 0 | -1 | -2 | -3 | -4 | -5 | -6 | -7 | -8 | -9;

export interface KitControlRingDiagnostics {
  capacitySlots: number;
  messagesPublished: number;
  messagesConsumed: number;
  producerBackpressure: number;
  highWaterSlots: number;
  currentSlots: number;
}

interface KitControlDiagnosticsCommon {
  producedAtMs: number;
  control: {
    websocketStartAttempts: number;
    websocketConnections: number;
    websocketDisconnects: number;
    websocketErrors: number;
    wifiDisconnects: number;
    protocolFailures: number;
    receiveFailures: number;
    sendFailures: number;
    lastWifiDisconnectReason: number;
    lastErrorGeneration: number;
    lastErrorType: KitControlWebsocketErrorType;
    lastTlsError: number;
    lastTlsStackError: number;
    lastTransportErrno: number;
    lastHandshakeStatusCode: number;
    lastCloseStatusCode: number;
    protocolFailureGeneration: number;
    lastApplicationCapnwebGeneration: number;
    lastApplicationCapnwebStatus: KitCapnwebStatus;
    lastControlReceiveStatus: KitCapnwebStatus;
    messagesSent: number;
    messagesDiscarded: number;
    inboxDiscarded: number;
    outboxDiscarded: number;
    inbox: KitControlRingDiagnostics;
    outbox: KitControlRingDiagnostics;
  };
  /*
   * This remains separate from `control`: station association and the PCM
   * socket are data-plane/network evidence, while `control` is the established
   * Cap'n Web reconnect postmortem contract.
   *
   * A missing wifiRssiDbm means the device could not obtain a current AP-info
   * observation. Consumers must not substitute zero or carry a prior sample.
   */
}

interface KitControlNetworkDiagnosticsV3 {
  wifiConnected: boolean;
  wifiRssiDbm?: number;
  pcmWebsocketConnections: number;
  pcmWebsocketDisconnects: number;
  pcmWebsocketErrors: number;
}

interface KitControlNetworkDiagnosticsV4 extends KitControlNetworkDiagnosticsV3 {
  /** Terminal raw-write calls, distinct from ordinary nonblocking deferrals. */
  pcmWebsocketRawWriteFailures: number;
  /** Number of retained connect/read/write lower-transport incidents. */
  pcmTransportFailureIncidents: number;
  /** 0 none, 1 connect, 2 read, 3 write. */
  pcmLastFailureOperation: KitPcmTransportFailureOperation;
  /** Exact return from the ESP-IDF transport operation. */
  pcmLastRawResult: number;
  /** Exact lwIP/socket errno, or zero when that domain had no cause. */
  pcmLastSocketErrno: number;
  /** Exact `esp_err_t` returned by ESP-TLS's retained error handle. */
  pcmLastEspTlsError: number;
  /** Exact mbedTLS/wolfSSL error retained by ESP-TLS. */
  pcmLastTlsStackError: number;
  /** Exact certificate verification flags retained by ESP-TLS. */
  pcmLastTlsCertFlags: number;
}

/**
 * Schema v3 remains readable for already-flashed devices. New firmware emits
 * v4 and must provide the complete PCM transport tuple; making those fields
 * optional on v4 would let a partial diagnosis masquerade as zero/healthy.
 */
export type KitControlDiagnosticsV3 = KitControlDiagnosticsCommon & {
  schemaVersion: 3;
  network: KitControlNetworkDiagnosticsV3;
};

export type KitControlDiagnosticsV4 = KitControlDiagnosticsCommon & {
  schemaVersion: 4;
  network: KitControlNetworkDiagnosticsV4;
};

export type KitControlDiagnostics = KitControlDiagnosticsV3 | KitControlDiagnosticsV4;

export interface KitDeviceDescription {
  instructions: string;
  children: Record<string, string>;
}

export interface KitDeviceEvent {
  active: boolean;
  coalescedNotifications: number;
  conversationActive: boolean;
  result: number;
  schemaVersion: 1;
  sequence: number;
  snapshot: boolean;
  source: "physical" | "remote" | "system";
  type: "conversation.ended" | "conversation.started" | "pushToTalk.started" | "pushToTalk.stopped";
}

export interface KitDevice {
  __describe(): Promise<KitDeviceDescription>;
  changeColour(colour: "red" | "green"): Promise<boolean>;
  getDiagnostics(): Promise<KitControlDiagnostics>;
  subscribeToMetrics(callback: (metrics: KitMetrics) => void): Promise<void>;
  renderOnScreen(input: { url: string }): Promise<boolean>;
}
