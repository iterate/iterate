const MAXIMUM_DEVICE_METRICS_BYTES = 8_192;

type JsonValue = boolean | null | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

export interface DeviceMetricsPayload extends JsonObject {
  cpuPermille: number;
  freeHeapBytes: number;
  freeInternalHeapBytes: number;
  freePsramBytes: number;
  minimumFreeHeapBytes: number;
  minimumFreeInternalHeapBytes: number;
  subscriptionEnds: number;
  taskStackHighWaterBytes: number;
  uptimeMs: number;
}

export interface DeviceMetricsSessionMetrics {
  invalidSamples: number;
  lastInvalidReason: string | null;
  latestSample: {
    metrics: DeviceMetricsPayload;
    receivedAtMs: number;
  } | null;
  samplesReceived: number;
}

export type DeviceMetricsCallbackBracket =
  | {
      baseline: { receivedAtMs: number; uptimeMs: number };
      deviceUptimeSpanMs: number;
      exactMediaInterval: false;
      receiptSpanMs: number;
      sampleCountDelta: number;
      semantics: "conservative-callback-bracket";
      status: "valid";
      terminal: { receivedAtMs: number; uptimeMs: number };
    }
  | {
      exactMediaInterval: false;
      reason: string;
      semantics: "conservative-callback-bracket";
      status: "invalid";
    }
  | {
      exactMediaInterval: false;
      reason: string;
      semantics: "conservative-callback-bracket";
      status: "unavailable";
    };

/**
 * Describes the coverage of two low-rate capability snapshots honestly.
 *
 * A worker can read its own PCM counters at an exact scenario boundary, but a
 * device metrics callback is pushed on the firmware's independent one-second
 * clock. The two retained callback samples therefore bracket the interesting
 * interval; subtracting counters from them is useful for leak/reset detection,
 * but is not exact frame conservation. Encoding that distinction in the
 * artifact prevents a later analyzer from silently upgrading sampled evidence
 * into a transport claim.
 */
export function deviceMetricsCallbackBracket(
  baseline: DeviceMetricsSessionMetrics | null | undefined,
  terminal: DeviceMetricsSessionMetrics | null | undefined,
): DeviceMetricsCallbackBracket {
  if (
    baseline?.latestSample === null ||
    baseline?.latestSample === undefined ||
    terminal?.latestSample === null ||
    terminal?.latestSample === undefined
  ) {
    return {
      exactMediaInterval: false,
      reason: "Both proof boundaries require a retained device metrics callback.",
      semantics: "conservative-callback-bracket",
      status: "unavailable",
    };
  }
  if (terminal.latestSample.metrics.uptimeMs < baseline.latestSample.metrics.uptimeMs) {
    return {
      exactMediaInterval: false,
      reason: "Device uptime moved backwards across the metrics callback bracket.",
      semantics: "conservative-callback-bracket",
      status: "invalid",
    };
  }
  if (terminal.samplesReceived < baseline.samplesReceived) {
    return {
      exactMediaInterval: false,
      reason: "Userspace sample count moved backwards across the metrics callback bracket.",
      semantics: "conservative-callback-bracket",
      status: "invalid",
    };
  }
  return {
    baseline: {
      receivedAtMs: baseline.latestSample.receivedAtMs,
      uptimeMs: baseline.latestSample.metrics.uptimeMs,
    },
    deviceUptimeSpanMs:
      terminal.latestSample.metrics.uptimeMs - baseline.latestSample.metrics.uptimeMs,
    exactMediaInterval: false,
    receiptSpanMs: terminal.latestSample.receivedAtMs - baseline.latestSample.receivedAtMs,
    sampleCountDelta: terminal.samplesReceived - baseline.samplesReceived,
    semantics: "conservative-callback-bracket",
    status: "valid",
    terminal: {
      receivedAtMs: terminal.latestSample.receivedAtMs,
      uptimeMs: terminal.latestSample.metrics.uptimeMs,
    },
  };
}

/**
 * Reads the optional physical playback-ring observation from a valid metrics
 * sample. Resource fields are mandatory across every Kit target, but older or
 * non-audio devices may legitimately omit `audio.downlink`. Keeping this
 * target-neutral boundary here avoids both unsafe nested casts in the worker
 * and any device-slug branch in the realtime bridge.
 */
export function deviceDownlinkDepth(metrics: DeviceMetricsPayload): number | null {
  const audio = metrics.audio;
  if (!isJsonObject(audio)) return null;
  const downlink = audio.downlink;
  if (!isJsonObject(downlink)) return null;
  const depth = downlink.depth;
  if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0) return null;
  return depth;
}

/**
 * Retains the most recent capability sample without turning a once-per-second
 * callback into a months-long telemetry array.
 *
 * The stringify/parse boundary is intentional. Cap'n Web delivered values are
 * not owned by this object and may contain getters or later mutation in a host
 * test. A bounded JSON copy both severs that lifetime and proves the retained
 * value cannot hide capabilities. Eight KiB is four times the firmware's fixed
 * two-KiB control-message slot: it leaves schema headroom while still making a
 * mismatched or malicious mounted capability cheap to reject.
 */
export class DeviceMetricsSessionTracker {
  #invalidSamples = 0;
  #lastInvalidReason: string | null = null;
  #latestSample: DeviceMetricsSessionMetrics["latestSample"] = null;
  #samplesReceived = 0;

  observe(
    value: unknown,
    receivedAtMs: number = Date.now(),
  ): { ok: true; sample: DeviceMetricsPayload } | { ok: false; reason: string } {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return this.#reject("Device metrics must be a finite JSON object.");
    }
    if (serialized === undefined) {
      return this.#reject("Device metrics must be a finite JSON object.");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAXIMUM_DEVICE_METRICS_BYTES) {
      return this.#reject(
        `Device metrics exceeded the ${MAXIMUM_DEVICE_METRICS_BYTES}-byte userspace snapshot limit.`,
      );
    }

    const parsed: unknown = JSON.parse(serialized);
    if (!isDeviceMetricsPayload(parsed)) {
      return this.#reject("Device metrics must contain safe-integer runtime resource fields.");
    }
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) {
      return this.#reject("Device metrics receipt time must be a non-negative safe integer.");
    }

    this.#samplesReceived += 1;
    this.#latestSample = { metrics: parsed, receivedAtMs };
    return { ok: true, sample: parsed };
  }

  metrics(): DeviceMetricsSessionMetrics {
    return {
      invalidSamples: this.#invalidSamples,
      lastInvalidReason: this.#lastInvalidReason,
      latestSample: this.#latestSample,
      samplesReceived: this.#samplesReceived,
    };
  }

  #reject(reason: string): { ok: false; reason: string } {
    this.#invalidSamples += 1;
    this.#lastInvalidReason = reason;
    return { ok: false, reason };
  }
}

function isDeviceMetricsPayload(value: unknown): value is DeviceMetricsPayload {
  if (!isJsonObject(value)) return false;
  return [
    value.uptimeMs,
    value.freeHeapBytes,
    value.minimumFreeHeapBytes,
    value.freeInternalHeapBytes,
    value.minimumFreeInternalHeapBytes,
    value.freePsramBytes,
    value.taskStackHighWaterBytes,
    value.cpuPermille,
    value.subscriptionEnds,
  ].every((metric) => typeof metric === "number" && Number.isSafeInteger(metric));
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
