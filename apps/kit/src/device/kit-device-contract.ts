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
export type KitBufferMetricEvidence =
  | "observed"
  | "derivedBound"
  | "capacityOnly"
  | "unavailable";

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
  playback: {
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
   * so those two values can overlap by one frame. `peerUnconfirmed` starts at
   * complete local acceptance and is a conservative PCM-only bound; control
   * PING bytes are represented by `websocketTransmitter`, not by that bound.
   */
  buffers?: {
    uplinkApplication: KitBufferMetrics;
    websocketTransmitter: KitBufferMetrics;
    peerUnconfirmed: KitBufferMetrics;
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

export interface KitDeviceDescription {
  instructions: string;
  children: Record<string, string>;
}

export interface KitDevice {
  __describe(): Promise<KitDeviceDescription>;
  subscribeToMetrics(callback: (metrics: KitMetrics) => void): Promise<void>;
  renderOnScreen(input: { url: string }): Promise<boolean>;
}
