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
 * Raw ESP WebSocket error categories. Keep the numeric SDK value on the wire
 * and map it only for display: the accompanying TLS, errno, handshake, and
 * close fields live in different domains and must not be collapsed into one
 * generic JavaScript exception.
 */
export type KitControlWebsocketErrorType = 0 | 1 | 2 | 3 | 4;

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

export interface KitControlDiagnostics {
  schemaVersion: 3;
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
  network: {
    wifiConnected: boolean;
    wifiRssiDbm?: number;
    pcmWebsocketConnections: number;
    pcmWebsocketDisconnects: number;
    pcmWebsocketErrors: number;
  };
}

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
