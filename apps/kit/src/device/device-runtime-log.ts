import { z } from "zod";
import type { KitBufferMetrics } from "./kit-device-contract.ts";

export type DeviceRuntimeMetricValue = number | string;

export type DeviceRuntimeMetrics = Record<string, DeviceRuntimeMetricValue>;

export type DeviceRuntimeLogObservation =
  | {
      kind: "device-event";
      event: string;
      source: string;
      result: number;
    }
  | {
      kind: "failure";
      reason: string;
    }
  | {
      family: string;
      kind: "metrics";
      values: DeviceRuntimeMetrics;
    };

export interface DeviceRuntimeHealthThresholds {
  maximumTaskWorkCyclesPerReport?: number;
  minimumNetworkStackHeadroomBytes: number;
}

const sequencedRuntimeMetricFamilies = new Set(["system", "control", "pcm"]);

/**
 * Bounded state for proving that serial metric families remain one ordered
 * report stream.
 *
 * The device deliberately permits sequence gaps when a diagnostics sink is
 * stalled, but it never permits reordering: one retained report drains all
 * families before the next report begins. Checking each family plus the most
 * recent cross-family timestamp catches stale replay and mixed records without
 * turning an explicitly counted skip into a false failure. Capability and
 * legacy metrics have no report envelope and are intentionally ignored.
 */
export class DeviceRuntimeMetricsContinuity {
  readonly #latestByFamily = new Map<string, { reportSequence: number; sampleMs: number }>();
  #latestReportSequence: number | undefined;
  #latestSampleMs: number | undefined;

  observe(observation: DeviceRuntimeLogObservation): DeviceRuntimeLogObservation | undefined {
    if (observation.kind !== "metrics" || !sequencedRuntimeMetricFamilies.has(observation.family)) {
      return;
    }
    const reportSequence = observation.values.report_seq;
    const sampleMs = observation.values.sample_ms;
    if (
      typeof reportSequence !== "number" ||
      !Number.isSafeInteger(reportSequence) ||
      reportSequence < 0 ||
      typeof sampleMs !== "number" ||
      !Number.isSafeInteger(sampleMs) ||
      sampleMs < 0
    ) {
      return {
        kind: "failure",
        reason:
          `Device runtime ${observation.family} metrics must carry ` +
          "nonnegative safe-integer report_seq and sample_ms.",
      };
    }

    const previous = this.#latestByFamily.get(observation.family);
    if (previous && (reportSequence <= previous.reportSequence || sampleMs <= previous.sampleMs)) {
      return {
        kind: "failure",
        reason:
          `Device runtime ${observation.family} report regressed from ` +
          `sequence ${previous.reportSequence}/sample ${previous.sampleMs} ` +
          `to sequence ${reportSequence}/sample ${sampleMs}.`,
      };
    }
    if (this.#latestReportSequence !== undefined && reportSequence < this.#latestReportSequence) {
      return {
        kind: "failure",
        reason:
          `Device runtime report sequence ${reportSequence} arrived after ` +
          `${this.#latestReportSequence}.`,
      };
    }
    if (reportSequence === this.#latestReportSequence && sampleMs !== this.#latestSampleMs) {
      return {
        kind: "failure",
        reason:
          `Device runtime report ${reportSequence} mixed sample_ms=${sampleMs} ` +
          `with ${this.#latestSampleMs} from another family.`,
      };
    }

    this.#latestByFamily.set(observation.family, {
      reportSequence,
      sampleMs,
    });
    if (this.#latestReportSequence === undefined || reportSequence > this.#latestReportSequence) {
      this.#latestReportSequence = reportSequence;
      this.#latestSampleMs = sampleMs;
    }
  }
}

export function deviceTransportsReady(metrics: DeviceRuntimeMetrics, requirePcm: boolean) {
  return (
    metrics.control_transport === "ready" && (!requirePcm || metrics.pcm_transport === "ready")
  );
}

const legacyMetricsMarker = "iterate-kit: metrics ";
const metricsFamilyMarker = "iterate-kit: metrics.";
const pcmRecoveryMarker = "iterate-kit: pcm_uplink_recovery ";
const eventMarker = "iterate-kit: would_post_to_stream ";
const panicMarkers = [
  "Guru Meditation Error:",
  "Stack canary watchpoint triggered",
  "abort() was called",
] as const;
const brownoutMarker = "Brownout detector was triggered";
const zeroErrorMetrics = [
  "ws_errors",
  "net_stack_exhaustions",
  "control_discarded",
  "event_backpressure",
  "event_failures",
  "inbox_backpressure",
  "outbox_backpressure",
  "pcm_dropped",
  "pcm_net_stack_exhaustions",
  "audio_dropped",
  "audio_send_failures",
  "completion_errors",
  "uplink_transport_discarded",
  "uplink_send_failures",
  "uplink_backpressure",
  "downlink_receive_failures",
  "downlink_backpressure",
  "audio_failures",
  "uplink_dropped",
  "uplink_failures",
  "downlink_dropped",
  "downlink_failures",
  "playback_failures",
  "playback_submit_failures",
  "playback_invalid",
  "playback_state_errors",
  "protocol_failures",
  "diag_format_failures",
  "diag_sink_contract_failures",
] as const;
const stringMetrics = new Set(["transport", "control_transport", "pcm_transport", "reason"]);
const kitMetricFields = [
  ["uptimeMs", "uptime_ms"],
  ["freeHeapBytes", "heap"],
  ["minimumFreeHeapBytes", "min_heap"],
  ["freeInternalHeapBytes", "internal"],
  ["minimumFreeInternalHeapBytes", "min_internal"],
  ["freePsramBytes", "psram"],
  ["taskStackHighWaterBytes", "main_stack_headroom"],
  ["cpuPermille", "cpu_permille"],
] as const;
const kitAudioMetricFields = [
  [["capture", "sent"], "audio_sent"],
  [["capture", "dropped"], "audio_dropped"],
  [["capture", "failures"], "audio_failures"],
  [["uplink", "sent"], "uplink_sent"],
  [["uplink", "dropped"], "uplink_dropped"],
  [["uplink", "depth"], "uplink_current"],
  [["uplink", "highWater"], "uplink_high_water"],
  [["uplink", "sendDeferrals"], "uplink_send_deferrals"],
  [["uplink", "consecutiveSendDeferrals"], "uplink_consecutive_send_deferrals"],
  [["uplink", "maximumConsecutiveSendDeferrals"], "uplink_maximum_consecutive_send_deferrals"],
  [["uplink", "restartIncidents"], "uplink_restart_incidents"],
  [["uplink", "inPlaceFreshnessRecoveries"], "uplink_in_place_freshness_recoveries"],
  [["uplink", "socketRestarts"], "uplink_socket_restarts"],
  [["uplink", "producerBackpressureRestarts"], "uplink_producer_backpressure_restarts"],
  [["uplink", "transportDisconnectRestarts"], "uplink_transport_disconnect_restarts"],
  [["uplink", "noProgressTimeoutRestarts"], "uplink_no_progress_timeout_restarts"],
  [["uplink", "frameSendTimeoutRestarts"], "uplink_frame_send_timeout_restarts"],
  [["uplink", "captureStaleRestarts"], "uplink_capture_stale_restarts"],
  [["uplink", "lastTransportAcceptAgeMs"], "uplink_last_transport_accept_age_ms"],
  [["uplink", "maximumTransportAcceptAgeMs"], "uplink_maximum_transport_accept_age_ms"],
  [["uplink", "lastRestartOldestCaptureAgeMs"], "uplink_last_restart_oldest_capture_age_ms"],
  [["uplink", "lastRestartFramesDiscarded"], "uplink_last_restart_frames_discarded"],
  [["uplink", "failures"], "uplink_failures"],
  [["downlink", "received"], "downlink_accepted"],
  [["downlink", "dropped"], "downlink_dropped"],
  [["downlink", "depth"], "downlink_current"],
  [["downlink", "highWater"], "downlink_high_water"],
  [["downlink", "failures"], "downlink_failures"],
  [["protocolFailures"], "protocol_failures"],
] as const;
const kitPlaybackMetricFields = [
  [["playback", "submitted"], "playback_submitted"],
  [["playback", "completed"], "playback_completed"],
  [["playback", "flushed"], "playback_flushed"],
  [["playback", "depth"], "playback_current"],
  [["playback", "highWater"], "playback_high_water"],
  [["playback", "failures"], "playback_failures"],
] as const;
const pcmUplinkRestartReasons = new Set([
  "none",
  "producer_backpressure",
  "transport_disconnected",
  "no_progress_timeout",
  "frame_send_timeout",
  "capture_stale",
]);
const kitBufferMetricsSchema = z.object({
  capacity: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(),
  evidence: z.enum(["observed", "derivedBound", "capacityOnly", "unavailable"]),
  highWater: z.number().int().nonnegative(),
});
const kitAudioBuffersSchema = z.object({
  lwipSend: kitBufferMetricsSchema,
  tlsEgress: kitBufferMetricsSchema,
  uplinkApplication: kitBufferMetricsSchema,
  websocketTransmitter: kitBufferMetricsSchema,
  wifiEgress: kitBufferMetricsSchema,
});

export function parseKitMetricsCallback(value: unknown): DeviceRuntimeLogObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformedKitMetrics("expected an object");
  }
  const values: DeviceRuntimeMetrics = {
    control_transport: "ready",
  };
  for (const [callbackName, runtimeName] of kitMetricFields) {
    const metric = Reflect.get(value, callbackName);
    if (typeof metric !== "number" || !Number.isSafeInteger(metric)) {
      return malformedKitMetrics(`${callbackName} must be a safe integer`);
    }
    values[runtimeName] = metric;
  }
  const audio = Reflect.get(value, "audio");
  if (audio !== undefined) {
    for (const [path, runtimeName] of kitAudioMetricFields) {
      const metric = nestedSafeInteger(audio, path);
      if (metric === undefined) {
        return malformedKitMetrics(`audio.${path.join(".")} must be a safe integer`);
      }
      values[runtimeName] = metric;
    }
    const unparsedPlayback =
      typeof audio === "object" && audio !== null && !Array.isArray(audio)
        ? Reflect.get(audio, "playback")
        : undefined;
    if (unparsedPlayback !== undefined) {
      for (const [path, runtimeName] of kitPlaybackMetricFields) {
        const metric = nestedSafeInteger(audio, path);
        if (metric === undefined) {
          return malformedKitMetrics(`audio.${path.join(".")} must be a safe integer`);
        }
        values[runtimeName] = metric;
      }
    }
    const lastRestartReason = nestedString(audio, ["uplink", "lastRestartReason"]);
    if (lastRestartReason === undefined || !pcmUplinkRestartReasons.has(lastRestartReason)) {
      return malformedKitMetrics("audio.uplink.lastRestartReason must be a known restart reason");
    }
    values.uplink_last_restart_reason = lastRestartReason;
    const unparsedBuffers =
      typeof audio === "object" && audio !== null && !Array.isArray(audio)
        ? Reflect.get(audio, "buffers")
        : undefined;
    if (unparsedBuffers !== undefined) {
      const parsedBuffers = kitAudioBuffersSchema.safeParse(unparsedBuffers);
      if (!parsedBuffers.success) {
        const firstIssue = parsedBuffers.error.issues[0];
        const path = firstIssue?.path.join(".") ?? "unknown";
        const reason = firstIssue?.message ?? "failed validation";
        return malformedKitMetrics(`audio.buffers.${path}: ${reason}`);
      }
      appendKitBufferMetrics(
        values,
        "buffer_uplink_application",
        parsedBuffers.data.uplinkApplication,
      );
      appendKitBufferMetrics(
        values,
        "buffer_websocket_transmitter",
        parsedBuffers.data.websocketTransmitter,
      );
      appendKitBufferMetrics(values, "buffer_lwip_send", parsedBuffers.data.lwipSend);
      appendKitBufferMetrics(values, "buffer_tls_egress", parsedBuffers.data.tlsEgress);
      appendKitBufferMetrics(values, "buffer_wifi_egress", parsedBuffers.data.wifiEgress);
    }
  }
  return {
    family: "capability",
    kind: "metrics",
    values,
  };
}

/*
 * Keep evidence adjacent to each numeric value in the normalized hardware
 * health model. Flattening only the byte counts would erase the distinction
 * between an exact application queue and a zero from an unobservable driver
 * queue—the precise ambiguity this telemetry exists to prevent.
 */
function appendKitBufferMetrics(
  values: DeviceRuntimeMetrics,
  runtimePrefix: string,
  metrics: KitBufferMetrics,
) {
  values[`${runtimePrefix}_evidence`] = metrics.evidence;
  values[`${runtimePrefix}_current_bytes`] = metrics.current;
  values[`${runtimePrefix}_high_water_bytes`] = metrics.highWater;
  values[`${runtimePrefix}_capacity_bytes`] = metrics.capacity;
}

export function deviceVoiceRoundTripCompleted(
  before: DeviceRuntimeMetrics,
  after: DeviceRuntimeMetrics,
) {
  return deviceUplinkStreaming(before, after) && devicePlaybackCompleted(before, after);
}

export function deviceUplinkStreaming(before: DeviceRuntimeMetrics, after: DeviceRuntimeMetrics) {
  return (
    metricIncreased(before, after, "audio_sent") && metricIncreased(before, after, "uplink_sent")
  );
}

export function devicePlaybackCompleted(before: DeviceRuntimeMetrics, after: DeviceRuntimeMetrics) {
  return (
    metricIncreased(before, after, "downlink_accepted") &&
    metricIncreased(before, after, "playback_submitted") &&
    metricIncreased(before, after, "playback_completed") &&
    after.downlink_current === 0 &&
    after.playback_current === 0
  );
}

/**
 * Exact conservation gate for one provider response whose frame count was
 * observed at the userspace-to-device WebSocket boundary.
 *
 * Queue depth returning to zero is ambiguous: it can mean every frame became
 * audible, or that an underrun/reset discarded the remainder. The physical
 * Stick produced the latter state after playing 12 of 46 accepted frames, and
 * the former exploratory predicate accepted it. This gate couples the host's
 * exact sent-frame count to device receive, submit, and completion counters
 * while requiring every relevant loss/reset counter to remain unchanged.
 */
export function devicePlaybackResponseCompleted(
  before: DeviceRuntimeMetrics,
  after: DeviceRuntimeMetrics,
  expectedFrames: number,
) {
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames <= 0) {
    return false;
  }
  return (
    metricChangedByExactly(before, after, "downlink_accepted", expectedFrames) &&
    metricChangedByExactly(before, after, "playback_submitted", expectedFrames) &&
    metricChangedByExactly(before, after, "playback_completed", expectedFrames) &&
    metricChangedByExactly(before, after, "downlink_dropped", 0) &&
    metricChangedByExactly(before, after, "downlink_failures", 0) &&
    metricChangedByExactly(before, after, "playback_flushed", 0) &&
    metricChangedByExactly(before, after, "playback_failures", 0) &&
    after.downlink_current === 0 &&
    after.playback_current === 0
  );
}

/**
 * Exact two-direction conservation gate for one conversational PTT turn.
 *
 * A later audible response does not prove that the current microphone interval
 * stayed realtime: firmware can discard a stale uplink generation, reconnect,
 * and still receive a fresh downlink. That recovery is intentionally useful in
 * the product, but accepting it inside a no-drift endurance turn would hide the
 * very accumulating-delay failure the physical rig is meant to detect. Match
 * the host-observed provider sends exactly and require every device loss/
 * restart counter to remain unchanged, while delegating the independently
 * strict speaker accounting to `devicePlaybackResponseCompleted`.
 */
export function deviceVoiceTurnCompleted(
  before: DeviceRuntimeMetrics,
  after: DeviceRuntimeMetrics,
  expected: { microphoneFrames: number; speakerFrames: number },
) {
  if (!Number.isSafeInteger(expected.microphoneFrames) || expected.microphoneFrames <= 0) {
    return false;
  }
  return (
    devicePlaybackResponseCompleted(before, after, expected.speakerFrames) &&
    metricChangedByExactly(before, after, "uplink_sent", expected.microphoneFrames) &&
    metricChangedByExactly(before, after, "audio_dropped", 0) &&
    metricChangedByExactly(before, after, "audio_failures", 0) &&
    metricChangedByExactly(before, after, "uplink_dropped", 0) &&
    metricChangedByExactly(before, after, "uplink_failures", 0) &&
    metricChangedByExactly(before, after, "uplink_restart_incidents", 0) &&
    after.uplink_current === 0
  );
}

/**
 * Exact two-direction ledger for a two-epoch barge-in sequence.
 *
 * Ordinary turns forbid every flush. Barge-in has the opposite semantic
 * requirement: obsolete assistant audio must stop, but only that named loss
 * is acceptable. Every speaker frame observed leaving userspace must therefore
 * end in exactly one of two buckets—physically completed or generation-flushed.
 * Transport drops, failures, microphone loss, and generation restarts remain
 * forbidden, and both realtime queues must be empty before the proof closes.
 */
export function deviceInterruptedVoiceSequenceCompleted(
  before: DeviceRuntimeMetrics,
  after: DeviceRuntimeMetrics,
  expected: { microphoneFrames: number; speakerFrames: number },
) {
  if (
    !Number.isSafeInteger(expected.microphoneFrames) ||
    expected.microphoneFrames <= 0 ||
    !Number.isSafeInteger(expected.speakerFrames) ||
    expected.speakerFrames <= 0
  ) {
    return false;
  }
  const delta = (name: string) => {
    const beforeValue = before[name];
    const afterValue = after[name];
    return typeof beforeValue === "number" && typeof afterValue === "number"
      ? afterValue - beforeValue
      : undefined;
  };
  const accepted = delta("downlink_accepted");
  const submitted = delta("playback_submitted");
  const completed = delta("playback_completed");
  const flushed = delta("playback_flushed");
  return (
    accepted === expected.speakerFrames &&
    submitted !== undefined &&
    completed !== undefined &&
    flushed !== undefined &&
    flushed > 0 &&
    completed + flushed === accepted &&
    submitted >= completed &&
    submitted <= accepted &&
    metricChangedByExactly(before, after, "uplink_sent", expected.microphoneFrames) &&
    metricChangedByExactly(before, after, "audio_dropped", 0) &&
    metricChangedByExactly(before, after, "audio_failures", 0) &&
    metricChangedByExactly(before, after, "uplink_dropped", 0) &&
    metricChangedByExactly(before, after, "uplink_failures", 0) &&
    metricChangedByExactly(before, after, "uplink_restart_incidents", 0) &&
    metricChangedByExactly(before, after, "downlink_dropped", 0) &&
    metricChangedByExactly(before, after, "downlink_failures", 0) &&
    metricChangedByExactly(before, after, "playback_failures", 0) &&
    after.uplink_current === 0 &&
    after.downlink_current === 0 &&
    after.playback_current === 0
  );
}

/**
 * Exact digital completion gate for a deterministic fixed-duration response.
 *
 * "Some counters increased" is enough for an exploratory provider proof but
 * dangerously weak for endurance: a three-second response could lose its last
 * two seconds and still satisfy it. This variant requires every expected wire
 * frame to traverse receive, speaker submission, and observed completion while
 * both explicit queues return to zero.
 */
export function devicePlaybackFramesCompleted(
  before: DeviceRuntimeMetrics,
  after: DeviceRuntimeMetrics,
  expectedFrames: number,
) {
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames <= 0) {
    return false;
  }
  return (
    metricIncreasedByAtLeast(before, after, "downlink_accepted", expectedFrames) &&
    metricIncreasedByAtLeast(before, after, "playback_submitted", expectedFrames) &&
    metricIncreasedByAtLeast(before, after, "playback_completed", expectedFrames) &&
    after.downlink_current === 0 &&
    after.playback_current === 0
  );
}

export function parseDeviceRuntimeLogLine(line: string): DeviceRuntimeLogObservation | undefined {
  const brownoutIndex = line.indexOf(brownoutMarker);
  if (brownoutIndex !== -1) {
    /*
     * Brownout is not a recoverable transport disconnect. The CPU has already
     * reset, all audio ownership and monotonic counters were lost, and the
     * provider may continue emitting into a dead session. Preserve ESP-IDF's
     * definitive cause rather than letting the physical rig misclassify the
     * run as a later speaker-queue timeout.
     */
    return {
      kind: "failure",
      reason: `Device brownout: ${line.slice(brownoutIndex).trim()}`,
    };
  }
  for (const marker of panicMarkers) {
    const markerIndex = line.indexOf(marker);
    if (markerIndex !== -1) {
      return {
        kind: "failure",
        reason: `Device panic: ${line.slice(markerIndex).trim()}`,
      };
    }
  }

  const pcmRecoveryIndex = line.indexOf(pcmRecoveryMarker);
  if (pcmRecoveryIndex !== -1) {
    return parseMetrics(line.slice(pcmRecoveryIndex + pcmRecoveryMarker.length), "pcm-recovery");
  }

  const metricsFamilyIndex = line.indexOf(metricsFamilyMarker);
  if (metricsFamilyIndex !== -1) {
    const familyStart = metricsFamilyIndex + metricsFamilyMarker.length;
    const payloadStart = line.indexOf(" ", familyStart);
    if (payloadStart === -1 || payloadStart === familyStart) {
      return malformedLog("metrics family", line.slice(familyStart).trim());
    }
    return parseMetrics(line.slice(payloadStart + 1), line.slice(familyStart, payloadStart));
  }

  const legacyMetricsIndex = line.indexOf(legacyMetricsMarker);
  if (legacyMetricsIndex !== -1) {
    return parseMetrics(line.slice(legacyMetricsIndex + legacyMetricsMarker.length), "legacy");
  }

  const eventIndex = line.indexOf(eventMarker);
  if (eventIndex !== -1) {
    return parseDeviceEvent(line.slice(eventIndex + eventMarker.length));
  }
}

export function assessDeviceRuntimeMetrics(
  metrics: DeviceRuntimeMetrics,
  thresholds: DeviceRuntimeHealthThresholds,
): DeviceRuntimeLogObservation | undefined {
  for (const name of ["net_stack_headroom", "pcm_net_stack_headroom"] as const) {
    if (name === "pcm_net_stack_headroom" && metrics.pcm_transport === "idle") {
      continue;
    }
    const networkHeadroom = metrics[name];
    if (
      typeof networkHeadroom === "number" &&
      networkHeadroom < thresholds.minimumNetworkStackHeadroomBytes
    ) {
      const task = name === "net_stack_headroom" ? "Network" : "PCM network";
      return {
        kind: "failure",
        reason:
          `${task} task stack headroom fell to ${networkHeadroom} bytes; ` +
          `the required minimum is ${thresholds.minimumNetworkStackHeadroomBytes} bytes.`,
      };
    }
  }
  const cpuPermille = metrics.cpu_permille;
  if (
    (metrics.transport === "ready" || metrics.control_transport === "ready") &&
    (typeof cpuPermille !== "number" || cpuPermille < 0 || cpuPermille > 1000)
  ) {
    return {
      kind: "failure",
      reason:
        `Device runtime CPU utilization is ${String(cpuPermille)} permille ` +
        "while the transport is ready; expected 0..1000.",
    };
  }
  const maximumTaskWorkCycles = thresholds.maximumTaskWorkCyclesPerReport;
  if (maximumTaskWorkCycles !== undefined) {
    for (const name of ["main_cycles", "net_cycles", "pcm_net_cycles"] as const) {
      const value = metrics[name];
      if (typeof value === "number" && (value < 0 || value > maximumTaskWorkCycles)) {
        return {
          kind: "failure",
          reason:
            `Device runtime metric ${name} reached ${value} cycles per report; ` +
            `expected at most ${maximumTaskWorkCycles}.`,
        };
      }
    }
  }
  for (const name of zeroErrorMetrics) {
    const value = metrics[name];
    if (typeof value === "number" && value !== 0) {
      return {
        kind: "failure",
        reason: `Device runtime metric ${name} reached ${value}; expected zero.`,
      };
    }
  }
}

function parseMetrics(payload: string, family: string): DeviceRuntimeLogObservation {
  const values: DeviceRuntimeMetrics = {};
  for (const field of payload.trim().split(/\s+/)) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) {
      return malformedLog("metrics", field);
    }
    const name = field.slice(0, separator);
    const encodedValue = field.slice(separator + 1);
    if (stringMetrics.has(name)) {
      values[name] = encodedValue;
      continue;
    }
    if (!/^-?\d+$/.test(encodedValue)) {
      return malformedLog("metrics", field);
    }
    const value = Number(encodedValue);
    if (!Number.isSafeInteger(value)) {
      return malformedLog("metrics", field);
    }
    values[name] = value;
  }
  return { family, kind: "metrics", values };
}

function parseDeviceEvent(payload: string): DeviceRuntimeLogObservation {
  const fields = parseFields(payload);
  const event = fields.event;
  const source = fields.source;
  const encodedResult = fields.result;
  if (
    event === undefined ||
    source === undefined ||
    encodedResult === undefined ||
    !/^-?\d+$/.test(encodedResult)
  ) {
    return malformedLog("device event", payload.trim());
  }
  const result = Number(encodedResult);
  if (!Number.isSafeInteger(result)) {
    return malformedLog("device event", payload.trim());
  }
  return {
    event,
    kind: "device-event",
    result,
    source,
  };
}

function parseFields(payload: string) {
  const fields: Record<string, string> = {};
  for (const field of payload.trim().split(/\s+/)) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) continue;
    fields[field.slice(0, separator)] = field.slice(separator + 1);
  }
  return fields;
}

function malformedLog(kind: string, value: string): DeviceRuntimeLogObservation {
  return {
    kind: "failure",
    reason: `Malformed device ${kind} log field: ${value}.`,
  };
}

function malformedKitMetrics(reason: string): DeviceRuntimeLogObservation {
  return {
    kind: "failure",
    reason: `Malformed Cap'n Web metrics callback: ${reason}.`,
  };
}

function nestedSafeInteger(value: unknown, path: readonly string[]) {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return typeof current === "number" && Number.isSafeInteger(current) ? current : undefined;
}

function nestedString(value: unknown, path: readonly string[]) {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return typeof current === "string" ? current : undefined;
}

function metricIncreased(before: DeviceRuntimeMetrics, after: DeviceRuntimeMetrics, name: string) {
  const beforeValue = before[name];
  const afterValue = after[name];
  return (
    typeof beforeValue === "number" && typeof afterValue === "number" && afterValue > beforeValue
  );
}

function metricIncreasedByAtLeast(
  before: DeviceRuntimeMetrics,
  after: DeviceRuntimeMetrics,
  name: string,
  minimumIncrease: number,
) {
  const beforeValue = before[name];
  const afterValue = after[name];
  return (
    typeof beforeValue === "number" &&
    typeof afterValue === "number" &&
    afterValue - beforeValue >= minimumIncrease
  );
}

function metricChangedByExactly(
  before: DeviceRuntimeMetrics,
  after: DeviceRuntimeMetrics,
  name: string,
  expectedChange: number,
) {
  const beforeValue = before[name];
  const afterValue = after[name];
  return (
    typeof beforeValue === "number" &&
    typeof afterValue === "number" &&
    afterValue - beforeValue === expectedChange
  );
}
