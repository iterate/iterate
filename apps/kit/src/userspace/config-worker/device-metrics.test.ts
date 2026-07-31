import { describe, expect, test } from "vitest";
import { DeviceMetricsSessionTracker } from "./device-metrics.ts";

const validMetrics = {
  audio: {
    capture: { dropped: 0, failures: 0, sent: 12 },
  },
  cpuPermille: 83,
  freeHeapBytes: 220_000,
  freeInternalHeapBytes: 90_000,
  freePsramBytes: 1_000_000,
  minimumFreeHeapBytes: 210_000,
  minimumFreeInternalHeapBytes: 85_000,
  taskStackHighWaterBytes: 4_096,
  uptimeMs: 1_234,
};

describe("userspace device metrics retention", () => {
  test("retains one defensive latest-state snapshot instead of a growing history", () => {
    const tracker = new DeviceMetricsSessionTracker();
    const first = structuredClone(validMetrics);

    expect(tracker.observe(first, 10_000)).toMatchObject({ ok: true });
    first.audio.capture.sent = 999;
    expect(tracker.observe({ ...validMetrics, uptimeMs: 2_234 }, 11_000)).toMatchObject({
      ok: true,
    });

    expect(tracker.metrics()).toEqual({
      invalidSamples: 0,
      lastInvalidReason: null,
      latestSample: {
        metrics: { ...validMetrics, uptimeMs: 2_234 },
        receivedAtMs: 11_000,
      },
      samplesReceived: 2,
    });
  });

  test("rejects malformed or unexpectedly large callbacks without replacing good evidence", () => {
    const tracker = new DeviceMetricsSessionTracker();
    tracker.observe(validMetrics, 10_000);

    expect(tracker.observe({ ...validMetrics, freeHeapBytes: "lots" }, 11_000)).toEqual({
      ok: false,
      reason: "Device metrics must contain safe-integer runtime resource fields.",
    });
    expect(tracker.observe({ ...validMetrics, extra: "x".repeat(9_000) }, 12_000)).toEqual({
      ok: false,
      reason: "Device metrics exceeded the 8192-byte userspace snapshot limit.",
    });

    expect(tracker.metrics()).toMatchObject({
      invalidSamples: 2,
      latestSample: { metrics: validMetrics, receivedAtMs: 10_000 },
      samplesReceived: 1,
    });
  });
});
