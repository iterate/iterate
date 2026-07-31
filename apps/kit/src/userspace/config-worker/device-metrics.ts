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
