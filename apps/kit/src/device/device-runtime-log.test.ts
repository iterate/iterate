import { describe, expect, test } from "vitest";
import {
  DeviceRuntimeMetricsContinuity,
  assessDeviceRuntimeMetrics,
  devicePlaybackCompleted,
  devicePlaybackFramesCompleted,
  devicePlaybackResponseCompleted,
  deviceInterruptedVoiceSequenceCompleted,
  deviceUplinkStreaming,
  deviceVoiceTurnCompleted,
  deviceVoiceRoundTripCompleted,
  deviceTransportsReady,
  parseKitMetricsCallback,
  parseDeviceRuntimeLogLine,
} from "./device-runtime-log.ts";

const validKitAudioMetrics = {
  buffers: {
    lwipSend: {
      capacity: 5_744,
      current: 0,
      evidence: "capacityOnly",
      highWater: 0,
    },
    tlsEgress: {
      capacity: 0,
      current: 0,
      evidence: "unavailable",
      highWater: 0,
    },
    uplinkApplication: {
      capacity: 20_480,
      current: 640,
      evidence: "observed",
      highWater: 1_920,
    },
    websocketTransmitter: {
      capacity: 648,
      current: 324,
      evidence: "observed",
      highWater: 648,
    },
    wifiEgress: {
      capacity: 0,
      current: 0,
      evidence: "unavailable",
      highWater: 0,
    },
  },
  capture: { dropped: 2, failures: 0, sent: 101 },
  downlink: {
    depth: 0,
    dropped: 0,
    failures: 0,
    highWater: 2,
    received: 98,
  },
  playback: {
    completed: 97,
    depth: 0,
    failures: 0,
    flushed: 0,
    highWater: 2,
    submitted: 98,
  },
  protocolFailures: 0,
  uplink: {
    captureStaleRestarts: 1,
    consecutiveSendDeferrals: 0,
    depth: 0,
    dropped: 0,
    failures: 0,
    frameSendTimeoutRestarts: 0,
    highWater: 2,
    inPlaceFreshnessRecoveries: 1,
    lastRestartOldestCaptureAgeMs: 261,
    lastRestartFramesDiscarded: 4,
    lastRestartReason: "capture_stale",
    lastTransportAcceptAgeMs: 20,
    maximumConsecutiveSendDeferrals: 2,
    maximumTransportAcceptAgeMs: 75,
    noProgressTimeoutRestarts: 0,
    producerBackpressureRestarts: 1,
    restartIncidents: 1,
    sendDeferrals: 3,
    sent: 99,
    socketRestarts: 0,
    transportDisconnectRestarts: 0,
  },
};

describe("device runtime log", () => {
  test("normalizes Cap'n Web metrics callbacks into the hardware health model", () => {
    expect(
      parseKitMetricsCallback({
        cpuPermille: 73,
        freeHeapBytes: 312_000,
        freeInternalHeapBytes: 220_000,
        freePsramBytes: 0,
        minimumFreeHeapBytes: 280_000,
        minimumFreeInternalHeapBytes: 200_000,
        taskStackHighWaterBytes: 4_096,
        uptimeMs: 1_203,
        audio: validKitAudioMetrics,
      }),
    ).toEqual({
      family: "capability",
      kind: "metrics",
      values: {
        control_transport: "ready",
        cpu_permille: 73,
        heap: 312_000,
        internal: 220_000,
        main_stack_headroom: 4_096,
        min_heap: 280_000,
        min_internal: 200_000,
        psram: 0,
        uptime_ms: 1_203,
        audio_dropped: 2,
        audio_failures: 0,
        audio_sent: 101,
        buffer_lwip_send_capacity_bytes: 5_744,
        buffer_lwip_send_current_bytes: 0,
        buffer_lwip_send_evidence: "capacityOnly",
        buffer_lwip_send_high_water_bytes: 0,
        buffer_tls_egress_capacity_bytes: 0,
        buffer_tls_egress_current_bytes: 0,
        buffer_tls_egress_evidence: "unavailable",
        buffer_tls_egress_high_water_bytes: 0,
        buffer_uplink_application_capacity_bytes: 20_480,
        buffer_uplink_application_current_bytes: 640,
        buffer_uplink_application_evidence: "observed",
        buffer_uplink_application_high_water_bytes: 1_920,
        buffer_websocket_transmitter_capacity_bytes: 648,
        buffer_websocket_transmitter_current_bytes: 324,
        buffer_websocket_transmitter_evidence: "observed",
        buffer_websocket_transmitter_high_water_bytes: 648,
        buffer_wifi_egress_capacity_bytes: 0,
        buffer_wifi_egress_current_bytes: 0,
        buffer_wifi_egress_evidence: "unavailable",
        buffer_wifi_egress_high_water_bytes: 0,
        downlink_accepted: 98,
        downlink_dropped: 0,
        downlink_current: 0,
        downlink_failures: 0,
        downlink_high_water: 2,
        playback_completed: 97,
        playback_current: 0,
        playback_failures: 0,
        playback_flushed: 0,
        playback_high_water: 2,
        playback_submitted: 98,
        protocol_failures: 0,
        uplink_capture_stale_restarts: 1,
        uplink_dropped: 0,
        uplink_consecutive_send_deferrals: 0,
        uplink_current: 0,
        uplink_failures: 0,
        uplink_frame_send_timeout_restarts: 0,
        uplink_high_water: 2,
        uplink_in_place_freshness_recoveries: 1,
        uplink_last_restart_oldest_capture_age_ms: 261,
        uplink_last_restart_frames_discarded: 4,
        uplink_last_restart_reason: "capture_stale",
        uplink_last_transport_accept_age_ms: 20,
        uplink_maximum_consecutive_send_deferrals: 2,
        uplink_maximum_transport_accept_age_ms: 75,
        uplink_no_progress_timeout_restarts: 0,
        uplink_producer_backpressure_restarts: 1,
        uplink_restart_incidents: 1,
        uplink_send_deferrals: 3,
        uplink_sent: 99,
        uplink_socket_restarts: 0,
        uplink_transport_disconnect_restarts: 0,
      },
    });
  });

  test("retains transport audio evidence when playback evidence is unavailable", () => {
    const { playback: _unavailable, ...audioWithoutPlayback } = validKitAudioMetrics;
    expect(
      parseKitMetricsCallback({
        cpuPermille: 73,
        freeHeapBytes: 312_000,
        freeInternalHeapBytes: 220_000,
        freePsramBytes: 0,
        minimumFreeHeapBytes: 280_000,
        minimumFreeInternalHeapBytes: 200_000,
        taskStackHighWaterBytes: 4_096,
        uptimeMs: 1_203,
        audio: audioWithoutPlayback,
      }),
    ).toMatchObject({
      family: "capability",
      kind: "metrics",
      values: {
        audio_sent: 101,
        downlink_accepted: 98,
        uplink_sent: 99,
      },
    });
  });

  test("rejects malformed Cap'n Web metrics instead of treating them as measurements", () => {
    expect(
      parseKitMetricsCallback({
        cpuPermille: 73,
        freeHeapBytes: Number.NaN,
        freeInternalHeapBytes: 220_000,
        freePsramBytes: 0,
        minimumFreeHeapBytes: 280_000,
        minimumFreeInternalHeapBytes: 200_000,
        taskStackHighWaterBytes: 4_096,
        uptimeMs: 1_203,
      }),
    ).toEqual({
      kind: "failure",
      reason: "Malformed Cap'n Web metrics callback: freeHeapBytes must be a safe integer.",
    });
  });

  test("rejects malformed nested audio metrics", () => {
    expect(
      parseKitMetricsCallback({
        cpuPermille: 73,
        freeHeapBytes: 312_000,
        freeInternalHeapBytes: 220_000,
        freePsramBytes: 0,
        minimumFreeHeapBytes: 280_000,
        minimumFreeInternalHeapBytes: 200_000,
        taskStackHighWaterBytes: 4_096,
        uptimeMs: 1_203,
        audio: {
          capture: { dropped: 0, failures: 0, sent: 1 },
          downlink: {
            depth: 0,
            dropped: 0,
            failures: 0,
            highWater: 1,
            received: 1,
          },
          playback: {
            completed: 1,
            depth: 0,
            failures: Number.NaN,
            flushed: 0,
            highWater: 1,
            submitted: 1,
          },
          protocolFailures: 0,
          uplink: {
            captureStaleRestarts: 0,
            consecutiveSendDeferrals: 0,
            depth: 0,
            dropped: 0,
            failures: 0,
            frameSendTimeoutRestarts: 0,
            highWater: 1,
            inPlaceFreshnessRecoveries: 0,
            lastRestartOldestCaptureAgeMs: 0,
            lastRestartFramesDiscarded: 0,
            lastRestartReason: "none",
            lastTransportAcceptAgeMs: 0,
            maximumConsecutiveSendDeferrals: 0,
            maximumTransportAcceptAgeMs: 0,
            noProgressTimeoutRestarts: 0,
            producerBackpressureRestarts: 0,
            restartIncidents: 0,
            sendDeferrals: 0,
            sent: 1,
            socketRestarts: 0,
            transportDisconnectRestarts: 0,
          },
        },
      }),
    ).toEqual({
      kind: "failure",
      reason:
        "Malformed Cap'n Web metrics callback: audio.playback.failures must be a safe integer.",
    });
  });

  /*
   * A new firmware bug or protocol-version mismatch could emit a byte count
   * while inventing an evidence class the host does not understand. Silently
   * retaining the number would let a health report overstate what it knows
   * about hidden network queues, so the whole observation must become a
   * visible diagnostic failure.
   */
  test("rejects an unknown buffer evidence class", () => {
    const observation = parseKitMetricsCallback({
      audio: {
        ...validKitAudioMetrics,
        buffers: {
          ...validKitAudioMetrics.buffers,
          wifiEgress: {
            ...validKitAudioMetrics.buffers.wifiEgress,
            evidence: "estimated",
          },
        },
      },
      cpuPermille: 73,
      freeHeapBytes: 312_000,
      freeInternalHeapBytes: 220_000,
      freePsramBytes: 0,
      minimumFreeHeapBytes: 280_000,
      minimumFreeInternalHeapBytes: 200_000,
      taskStackHighWaterBytes: 4_096,
      uptimeMs: 1_203,
    });

    expect(observation.kind).toBe("failure");
    if (observation.kind === "failure") {
      expect(observation.reason).toContain("audio.buffers.wifiEgress.evidence");
    }
  });

  test("requires fresh capture, transport, and drained speaker consumption for a voice proof", () => {
    const before = {
      audio_sent: 100,
      downlink_accepted: 80,
      downlink_current: 0,
      playback_completed: 79,
      playback_current: 0,
      playback_submitted: 80,
      uplink_sent: 99,
    };
    expect(
      deviceVoiceRoundTripCompleted(before, {
        ...before,
        audio_sent: 120,
        downlink_accepted: 100,
        playback_completed: 99,
        playback_submitted: 100,
        uplink_sent: 119,
      }),
    ).toBe(true);
    expect(
      deviceVoiceRoundTripCompleted(before, {
        ...before,
        audio_sent: 120,
        downlink_accepted: 100,
        playback_completed: 99,
        playback_current: 1,
        playback_submitted: 100,
        uplink_sent: 119,
      }),
    ).toBe(false);
    expect(
      deviceVoiceRoundTripCompleted(before, {
        ...before,
        audio_sent: 120,
        downlink_accepted: 100,
        playback_completed: 79,
        playback_submitted: 100,
        uplink_sent: 119,
      }),
    ).toBe(false);
  });

  test("proves microphone frames keep reaching the provider before push-to-talk release", () => {
    const first = {
      audio_sent: 50,
      uplink_sent: 48,
    };
    expect(
      deviceUplinkStreaming(first, {
        audio_sent: 100,
        uplink_sent: 98,
      }),
    ).toBe(true);
    expect(
      deviceUplinkStreaming(first, {
        audio_sent: 100,
        uplink_sent: 48,
      }),
    ).toBe(false);
    expect(
      deviceUplinkStreaming(first, {
        audio_sent: 50,
        uplink_sent: 98,
      }),
    ).toBe(false);
  });

  test("proves provider playback without requiring a microphone turn", () => {
    const before = {
      downlink_accepted: 80,
      downlink_current: 0,
      playback_completed: 79,
      playback_current: 0,
      playback_submitted: 80,
    };
    expect(
      devicePlaybackCompleted(before, {
        ...before,
        downlink_accepted: 100,
        playback_completed: 99,
        playback_submitted: 100,
      }),
    ).toBe(true);
    expect(
      devicePlaybackCompleted(before, {
        ...before,
        downlink_accepted: 100,
        playback_completed: 99,
        playback_current: 1,
        playback_submitted: 100,
      }),
    ).toBe(false);
  });

  test("requires every expected deterministic frame, not merely some playback progress", () => {
    const before = {
      downlink_accepted: 40,
      downlink_current: 0,
      playback_completed: 40,
      playback_current: 0,
      playback_submitted: 40,
    };
    expect(
      devicePlaybackFramesCompleted(
        before,
        {
          ...before,
          downlink_accepted: 42,
          playback_completed: 42,
          playback_submitted: 42,
        },
        3,
      ),
    ).toBe(false);
    expect(
      devicePlaybackFramesCompleted(
        before,
        {
          ...before,
          downlink_accepted: 43,
          playback_completed: 43,
          playback_submitted: 43,
        },
        3,
      ),
    ).toBe(true);
  });

  test("does not mistake flushed Grok frames for a completed response", () => {
    /*
     * A physical reply accepted 46 frames, played 12, flushed 34 after an
     * underrun, and returned both queues to zero. The old exploratory gate
     * considered that success because each progress counter merely increased.
     * A production response is complete only when the exact host-observed
     * frame count is conserved through receive, submit, and completion with no
     * loss/reset counters changing.
     */
    const before = {
      downlink_accepted: 100,
      downlink_current: 0,
      downlink_dropped: 3,
      downlink_failures: 2,
      playback_completed: 90,
      playback_current: 0,
      playback_failures: 1,
      playback_flushed: 4,
      playback_submitted: 90,
    };
    const clean = {
      ...before,
      downlink_accepted: 146,
      playback_completed: 136,
      playback_submitted: 136,
    };
    expect(devicePlaybackResponseCompleted(before, clean, 46)).toBe(true);
    expect(
      devicePlaybackResponseCompleted(
        before,
        {
          ...clean,
          playback_completed: 102,
          playback_flushed: 38,
          playback_submitted: 102,
        },
        46,
      ),
    ).toBe(false);
    expect(
      devicePlaybackResponseCompleted(
        before,
        {
          ...clean,
          downlink_dropped: 4,
        },
        46,
      ),
    ).toBe(false);
    expect(devicePlaybackResponseCompleted(before, clean, 45)).toBe(false);
  });

  test("conserves both directions of one repeated voice turn without hiding an uplink reset", () => {
    /*
     * A multi-turn run cannot infer microphone health from “some frames moved”.
     * The device may discard an old uplink generation, recover, and still
     * produce a perfectly audible reply. That is useful recovery behaviour but
     * invalid evidence for a no-drift conversational turn, so the exact host
     * observations and every loss/restart counter must agree.
     */
    const before = {
      audio_dropped: 2,
      audio_failures: 1,
      downlink_accepted: 100,
      downlink_current: 0,
      downlink_dropped: 3,
      downlink_failures: 2,
      playback_completed: 90,
      playback_current: 0,
      playback_failures: 1,
      playback_flushed: 4,
      playback_submitted: 90,
      uplink_current: 0,
      uplink_dropped: 5,
      uplink_failures: 6,
      uplink_restart_incidents: 7,
      uplink_sent: 200,
    };
    const clean = {
      ...before,
      downlink_accepted: 146,
      playback_completed: 136,
      playback_submitted: 136,
      uplink_sent: 320,
    };

    expect(
      deviceVoiceTurnCompleted(before, clean, {
        microphoneFrames: 120,
        speakerFrames: 46,
      }),
    ).toBe(true);
    expect(
      deviceVoiceTurnCompleted(before, clean, {
        microphoneFrames: 119,
        speakerFrames: 46,
      }),
    ).toBe(false);
    expect(
      deviceVoiceTurnCompleted(
        before,
        { ...clean, uplink_restart_incidents: 8 },
        { microphoneFrames: 120, speakerFrames: 46 },
      ),
    ).toBe(false);
    expect(
      deviceVoiceTurnCompleted(
        before,
        { ...clean, uplink_current: 1 },
        { microphoneFrames: 120, speakerFrames: 46 },
      ),
    ).toBe(false);
  });

  test("conserves an intentional interruption as played plus explicitly flushed speech", () => {
    /*
     * An interruption is the one path where stale assistant PCM is supposed
     * to disappear. Calling it an ordinary drop would trip the global health
     * policy; ignoring it would let arbitrary loss pass. The exact ledger is
     * stronger: every userspace-observed speaker frame must be either completed
     * by I2S or named by the generation-flush counter, with no fault counter,
     * restart, or residual queue movement hidden beside it.
     */
    const before = {
      audio_dropped: 0,
      audio_failures: 0,
      downlink_accepted: 100,
      downlink_current: 0,
      downlink_dropped: 0,
      downlink_failures: 0,
      playback_completed: 90,
      playback_current: 0,
      playback_failures: 0,
      playback_flushed: 0,
      playback_submitted: 90,
      uplink_current: 0,
      uplink_dropped: 0,
      uplink_failures: 0,
      uplink_restart_incidents: 0,
      uplink_sent: 200,
    };
    const cleanInterruption = {
      ...before,
      downlink_accepted: 180,
      playback_completed: 162,
      playback_flushed: 8,
      playback_submitted: 168,
      uplink_sent: 320,
    };

    expect(
      deviceInterruptedVoiceSequenceCompleted(before, cleanInterruption, {
        microphoneFrames: 120,
        speakerFrames: 80,
      }),
    ).toBe(true);
    expect(
      deviceInterruptedVoiceSequenceCompleted(
        before,
        { ...cleanInterruption, playback_completed: 161 },
        { microphoneFrames: 120, speakerFrames: 80 },
      ),
    ).toBe(false);
    expect(
      deviceInterruptedVoiceSequenceCompleted(
        before,
        { ...cleanInterruption, downlink_dropped: 1 },
        { microphoneFrames: 120, speakerFrames: 80 },
      ),
    ).toBe(false);
    expect(
      deviceInterruptedVoiceSequenceCompleted(
        before,
        { ...cleanInterruption, playback_flushed: 0, playback_completed: 170 },
        { microphoneFrames: 120, speakerFrames: 80 },
      ),
    ).toBe(false);
  });

  test("requires the independent PCM socket before a voice capture proof", () => {
    expect(
      deviceTransportsReady(
        {
          control_transport: "ready",
          pcm_transport: "connecting",
        },
        true,
      ),
    ).toBe(false);
    expect(
      deviceTransportsReady(
        {
          control_transport: "ready",
          pcm_transport: "ready",
        },
        true,
      ),
    ).toBe(true);
    expect(
      deviceTransportsReady(
        {
          control_transport: "ready",
          pcm_transport: "idle",
        },
        false,
      ),
    ).toBe(true);
  });

  test("parses each current metrics family without colliding repeated field names", () => {
    expect(
      parseDeviceRuntimeLogLine(
        "I (1203) iterate-kit: metrics.system control_transport=ready " +
          "pcm_transport=ready capnweb=0 heap=238175 min_heap=233147 " +
          "internal=220000 min_internal=210000 psram=0 " +
          "main_stack_headroom=4960 net_stack_headroom=864 " +
          "pcm_net_stack_headroom=912 cpu_permille=73 main_cycles=54000 " +
          "main_max_cycles=1800 net_cycles=91000 net_max_cycles=22000 " +
          "pcm_net_cycles=81000 pcm_net_max_cycles=19000 " +
          "net_stack_exhaustions=0 pcm_net_stack_exhaustions=0",
      ),
    ).toEqual({
      family: "system",
      kind: "metrics",
      values: {
        capnweb: 0,
        control_transport: "ready",
        cpu_permille: 73,
        heap: 238_175,
        internal: 220_000,
        main_cycles: 54_000,
        main_max_cycles: 1_800,
        main_stack_headroom: 4_960,
        min_heap: 233_147,
        min_internal: 210_000,
        net_cycles: 91_000,
        net_max_cycles: 22_000,
        net_stack_exhaustions: 0,
        net_stack_headroom: 864,
        pcm_net_cycles: 81_000,
        pcm_net_max_cycles: 19_000,
        pcm_net_stack_exhaustions: 0,
        pcm_net_stack_headroom: 912,
        pcm_transport: "ready",
        psram: 0,
      },
    });
    expect(
      parseDeviceRuntimeLogLine(
        "I (1204) iterate-kit: metrics.pcm ws_errors=0 " + "uplink_current=1 downlink_current=0",
      ),
    ).toEqual({
      family: "pcm",
      kind: "metrics",
      values: {
        downlink_current: 0,
        uplink_current: 1,
        ws_errors: 0,
      },
    });
    expect(
      parseDeviceRuntimeLogLine(
        "I (1205) iterate-kit: metrics.control ws_errors=0 " +
          "events_processed=2 event_backpressure=0",
      ),
    ).toEqual({
      family: "control",
      kind: "metrics",
      values: {
        event_backpressure: 0,
        events_processed: 2,
        ws_errors: 0,
      },
    });
  });

  /*
   * A stalled exporter may legitimately skip report numbers, but the one
   * retained report and ordered family drain must never move backward or mix
   * timestamps. Without a stateful host check, a late stale line can satisfy a
   * readiness waiter even though a newer device observation was already seen.
   */
  test("rejects regressing or internally inconsistent metric reports", () => {
    const continuity = new DeviceRuntimeMetricsContinuity();
    expect(
      continuity.observe({
        family: "system",
        kind: "metrics",
        values: { report_seq: 10, sample_ms: 10_000 },
      }),
    ).toBeUndefined();
    expect(
      continuity.observe({
        family: "control",
        kind: "metrics",
        values: { report_seq: 10, sample_ms: 10_000 },
      }),
    ).toBeUndefined();
    expect(
      continuity.observe({
        family: "pcm",
        kind: "metrics",
        values: { report_seq: 10, sample_ms: 9_000 },
      }),
    ).toEqual({
      kind: "failure",
      reason: "Device runtime report 10 mixed sample_ms=9000 with 10000 from another family.",
    });

    const regression = new DeviceRuntimeMetricsContinuity();
    expect(
      regression.observe({
        family: "system",
        kind: "metrics",
        values: { report_seq: 10, sample_ms: 10_000 },
      }),
    ).toBeUndefined();
    expect(
      regression.observe({
        family: "system",
        kind: "metrics",
        values: { report_seq: 9, sample_ms: 9_000 },
      }),
    ).toEqual({
      kind: "failure",
      reason:
        "Device runtime system report regressed from sequence 10/sample 10000 to sequence 9/sample 9000.",
    });
  });

  test("records PCM freshness recoveries as structured diagnostics", () => {
    expect(
      parseDeviceRuntimeLogLine(
        "W (1420) iterate-kit: pcm_uplink_recovery incidents=3 " +
          "reason=producer_backpressure discarded=32 queue_depth=0 " +
          "queue_high_water=32 reset_requests=1 oldest_capture_age_ms=640 " +
          "in_place_recoveries=3 socket_restarts=0",
      ),
    ).toEqual({
      family: "pcm-recovery",
      kind: "metrics",
      values: {
        discarded: 32,
        incidents: 3,
        in_place_recoveries: 3,
        oldest_capture_age_ms: 640,
        queue_depth: 0,
        queue_high_water: 32,
        reason: "producer_backpressure",
        reset_requests: 1,
        socket_restarts: 0,
      },
    });
  });

  test("parses resource metrics needed by the hardware proof", () => {
    expect(
      parseDeviceRuntimeLogLine(
        "I (1203) iterate-kit: metrics transport=ready capnweb=0 " +
          "heap=8598872 min_heap=8598660 internal=238175 min_internal=233147 " +
          "psram=8384968 main_stack_headroom=4960 net_stack_headroom=864 " +
          "cpu_permille=73 main_cycles=54000 main_max_cycles=1800 " +
          "net_cycles=91000 net_max_cycles=22000 " +
          "pcm_frames=0 pcm_dropped=0 pcm_samples=0 peak=0 " +
          "events_published=2 events_processed=2 event_backpressure=0 " +
          "event_failures=0 event_high_water=1 event_current=0 " +
          "ws_connections=1 ws_disconnects=0 ws_errors=0 " +
          "control_sent=5 control_discarded=0 inbox_current=0 " +
          "inbox_high_water=1 inbox_backpressure=0 outbox_current=0 " +
          "outbox_high_water=1 outbox_backpressure=0",
      ),
    ).toEqual({
      family: "legacy",
      kind: "metrics",
      values: {
        capnweb: 0,
        control_discarded: 0,
        control_sent: 5,
        cpu_permille: 73,
        event_backpressure: 0,
        event_current: 0,
        event_failures: 0,
        event_high_water: 1,
        events_processed: 2,
        events_published: 2,
        heap: 8_598_872,
        inbox_backpressure: 0,
        inbox_current: 0,
        inbox_high_water: 1,
        internal: 238_175,
        main_cycles: 54_000,
        main_max_cycles: 1_800,
        main_stack_headroom: 4_960,
        min_heap: 8_598_660,
        min_internal: 233_147,
        net_stack_headroom: 864,
        net_cycles: 91_000,
        net_max_cycles: 22_000,
        outbox_backpressure: 0,
        outbox_current: 0,
        outbox_high_water: 1,
        pcm_dropped: 0,
        pcm_frames: 0,
        pcm_samples: 0,
        peak: 0,
        psram: 8_384_968,
        transport: "ready",
        ws_connections: 1,
        ws_disconnects: 0,
        ws_errors: 0,
      },
    });
  });

  test("classifies both physical and remote semantic events", () => {
    expect(
      parseDeviceRuntimeLogLine(
        "I (1320) iterate-kit: would_post_to_stream " +
          "event=pushToTalk.started source=physical result=0",
      ),
    ).toEqual({
      event: "pushToTalk.started",
      kind: "device-event",
      result: 0,
      source: "physical",
    });
    expect(
      parseDeviceRuntimeLogLine(
        "I (1430) iterate-kit: would_post_to_stream " +
          "event=pushToTalk.stopped source=remote result=0",
      ),
    ).toEqual({
      event: "pushToTalk.stopped",
      kind: "device-event",
      result: 0,
      source: "remote",
    });
  });

  test("turns the observed stack exhaustion and panic into explicit failures", () => {
    const observation = parseDeviceRuntimeLogLine(
      "I (1203) iterate-kit: metrics transport=websocket_connecting " + "net_stack_headroom=96",
    );
    expect(observation?.kind).toBe("metrics");
    if (observation?.kind !== "metrics") {
      throw new Error("Expected a metrics observation.");
    }
    expect(
      assessDeviceRuntimeMetrics(observation.values, {
        minimumNetworkStackHeadroomBytes: 512,
      }),
    ).toEqual({
      kind: "failure",
      reason: "Network task stack headroom fell to 96 bytes; the required minimum is 512 bytes.",
    });

    expect(
      parseDeviceRuntimeLogLine("Guru Meditation Error: Core  0 panic'ed (LoadProhibited)."),
    ).toEqual({
      kind: "failure",
      reason: "Device panic: Guru Meditation Error: Core  0 panic'ed (LoadProhibited).",
    });
  });

  test("turns the ESP brownout reset banner into an immediate terminal failure", () => {
    /*
     * A speaker-current transient can reset the board while the provider and
     * host recorder continue normally. If the serial parser ignores ESP-IDF's
     * brownout banner, the only visible harness result is a much later
     * playback-completion timeout and the acoustic artifact contains tens of
     * seconds after the actual fault. The reset reason is definitive physical
     * evidence and must abort the active proof at the line where it appears.
     */
    expect(parseDeviceRuntimeLogLine("I BOD: Brownout detector was triggered")).toEqual({
      kind: "failure",
      reason: "Device brownout: Brownout detector was triggered",
    });
  });

  test("does not treat an unstarted PCM task's zero headroom as exhaustion", () => {
    expect(
      assessDeviceRuntimeMetrics(
        {
          control_transport: "websocket_connecting",
          net_stack_headroom: 864,
          pcm_net_stack_exhaustions: 0,
          pcm_net_stack_headroom: 0,
          pcm_transport: "idle",
        },
        { minimumNetworkStackHeadroomBytes: 512 },
      ),
    ).toBeUndefined();
  });

  /*
   * A formatter overflow or impossible sink count abandons a report on-device
   * to protect memory safety. Treating the next report as healthy merely
   * because transport/audio counters are zero would hide an observability
   * defect precisely when the physical rig depends on complete evidence.
   */
  test("rejects classified diagnostics exporter defects", () => {
    for (const name of ["diag_format_failures", "diag_sink_contract_failures"] as const) {
      expect(
        assessDeviceRuntimeMetrics(
          {
            [name]: 1,
            net_stack_headroom: 800,
          },
          { minimumNetworkStackHeadroomBytes: 512 },
        ),
      ).toEqual({
        kind: "failure",
        reason: `Device runtime metric ${name} reached 1; expected zero.`,
      });
    }
  });

  test("rejects unexplained runtime error, loss, and backpressure counters", () => {
    expect(
      assessDeviceRuntimeMetrics(
        {
          net_stack_headroom: 800,
          ws_errors: 1,
        },
        { minimumNetworkStackHeadroomBytes: 512 },
      ),
    ).toEqual({
      kind: "failure",
      reason: "Device runtime metric ws_errors reached 1; expected zero.",
    });
    expect(
      assessDeviceRuntimeMetrics(
        {
          event_backpressure: 2,
          net_stack_headroom: 800,
        },
        { minimumNetworkStackHeadroomBytes: 512 },
      ),
    ).toEqual({
      kind: "failure",
      reason: "Device runtime metric event_backpressure reached 2; expected zero.",
    });

    expect(
      assessDeviceRuntimeMetrics(
        {
          cpu_permille: -1,
          net_stack_headroom: 800,
          transport: "ready",
        },
        { minimumNetworkStackHeadroomBytes: 512 },
      ),
    ).toEqual({
      kind: "failure",
      reason:
        "Device runtime CPU utilization is -1 permille while the transport is ready; expected 0..1000.",
    });
    expect(
      assessDeviceRuntimeMetrics(
        {
          cpu_permille: 1001,
          net_stack_headroom: 800,
          transport: "ready",
        },
        { minimumNetworkStackHeadroomBytes: 512 },
      ),
    ).toEqual({
      kind: "failure",
      reason:
        "Device runtime CPU utilization is 1001 permille while the transport is ready; expected 0..1000.",
    });

    expect(
      assessDeviceRuntimeMetrics(
        {
          cpu_permille: 75,
          net_cycles: 4_196_359_374,
          net_stack_headroom: 800,
          transport: "ready",
        },
        {
          maximumTaskWorkCyclesPerReport: 300_000_000,
          minimumNetworkStackHeadroomBytes: 512,
        },
      ),
    ).toEqual({
      kind: "failure",
      reason:
        "Device runtime metric net_cycles reached 4196359374 cycles per report; expected at most 300000000.",
    });
  });
});
