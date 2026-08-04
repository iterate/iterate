import { describe, expect, test } from "vitest";
import {
  deviceDownlinkDepth,
  deviceMetricsCallbackBracket,
  DeviceMetricsSessionTracker,
} from "./device-metrics.ts";

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
  subscriptionEnds: 3,
  taskStackHighWaterBytes: 4_096,
  uptimeMs: 1_234,
};

describe("userspace device metrics retention", () => {
  test("labels sampled counter coverage as a conservative callback bracket", () => {
    /*
     * Firmware publishes general metrics roughly once per second, whereas the
     * PCM worker owns exact frame-boundary counters. Subtracting the latest
     * callback at two worker snapshots therefore includes some work outside
     * the requested media interval. The durable proof must say so explicitly;
     * otherwise a plausible 599-versus-546 comparison looks like unexplained
     * frame loss even though the two clocks never shared a boundary.
     */
    const tracker = new DeviceMetricsSessionTracker();
    tracker.observe({ ...validMetrics, uptimeMs: 20_000 }, 30_000);
    const baseline = tracker.metrics();
    tracker.observe({ ...validMetrics, uptimeMs: 21_000 }, 31_050);

    expect(deviceMetricsCallbackBracket(baseline, tracker.metrics())).toEqual({
      baseline: { receivedAtMs: 30_000, uptimeMs: 20_000 },
      deviceUptimeSpanMs: 1_000,
      exactMediaInterval: false,
      receiptSpanMs: 1_050,
      sampleCountDelta: 1,
      semantics: "conservative-callback-bracket",
      status: "valid",
      terminal: { receivedAtMs: 31_050, uptimeMs: 21_000 },
    });
  });

  test("rejects a callback bracket which crosses a device reboot", () => {
    /*
     * A decreasing uptime means the terminal callback belongs to a new boot.
     * Treating its smaller counters as an interval delta can disguise both the
     * reset and any lost media. The evidence boundary must remain durable but
     * explicitly invalid instead of manufacturing negative accounting.
     */
    const beforeRestart = new DeviceMetricsSessionTracker();
    beforeRestart.observe({ ...validMetrics, uptimeMs: 50_000 }, 70_000);
    const afterRestart = new DeviceMetricsSessionTracker();
    afterRestart.observe({ ...validMetrics, uptimeMs: 2_000 }, 71_000);

    expect(deviceMetricsCallbackBracket(beforeRestart.metrics(), afterRestart.metrics())).toEqual({
      exactMediaInterval: false,
      reason: "Device uptime moved backwards across the metrics callback bracket.",
      semantics: "conservative-callback-bracket",
      status: "invalid",
    });
  });

  test("retains an explicit unavailable verdict when a proof boundary has no callback", () => {
    /*
     * Failure manifests are most useful when they preserve why accounting was
     * impossible. Returning null here would make an absent subscription look
     * indistinguishable from an older harness which never checked metrics.
     */
    const tracker = new DeviceMetricsSessionTracker();
    tracker.observe(validMetrics, 10_000);

    expect(deviceMetricsCallbackBracket(null, tracker.metrics())).toEqual({
      exactMediaInterval: false,
      reason: "Both proof boundaries require a retained device metrics callback.",
      semantics: "conservative-callback-bracket",
      status: "unavailable",
    });
  });

  test("rejects a bracket which crosses a userspace metrics-tracker generation", () => {
    /*
     * A Durable Object restart can leave device uptime increasing while the
     * userspace sample counter starts again at one. Comparing those snapshots
     * would cross two tracker generations, so the manifest must not call the
     * result one continuous observation interval.
     */
    const oldTracker = new DeviceMetricsSessionTracker();
    oldTracker.observe({ ...validMetrics, uptimeMs: 20_000 }, 30_000);
    oldTracker.observe({ ...validMetrics, uptimeMs: 21_000 }, 31_000);
    const newTracker = new DeviceMetricsSessionTracker();
    newTracker.observe({ ...validMetrics, uptimeMs: 22_000 }, 32_000);

    expect(deviceMetricsCallbackBracket(oldTracker.metrics(), newTracker.metrics())).toEqual({
      exactMediaInterval: false,
      reason: "Userspace sample count moved backwards across the metrics callback bracket.",
      semantics: "conservative-callback-bracket",
      status: "invalid",
    });
  });

  test("extracts only a valid optional physical downlink depth", () => {
    /*
     * Playback feedback is fed by an untrusted capability callback, while the
     * bridge API deliberately accepts only a checked integer. Missing audio
     * metrics are normal for non-audio/older targets; malformed depths must not
     * become scheduler corrections or force a device-specific worker branch.
     */
    expect(
      deviceDownlinkDepth({
        ...validMetrics,
        audio: { downlink: { depth: 17 } },
      }),
    ).toBe(17);
    expect(deviceDownlinkDepth(validMetrics)).toBeNull();
    expect(
      deviceDownlinkDepth({
        ...validMetrics,
        audio: { downlink: { depth: -1 } },
      }),
    ).toBeNull();
    expect(
      deviceDownlinkDepth({
        ...validMetrics,
        audio: { downlink: { depth: 1.5 } },
      }),
    ).toBeNull();
  });

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
    const { subscriptionEnds: _missing, ...missingLifecycleCounter } = validMetrics;
    expect(tracker.observe(missingLifecycleCounter, 11_500)).toEqual({
      ok: false,
      reason: "Device metrics must contain safe-integer runtime resource fields.",
    });
    expect(tracker.observe({ ...validMetrics, extra: "x".repeat(9_000) }, 12_000)).toEqual({
      ok: false,
      reason: "Device metrics exceeded the 8192-byte userspace snapshot limit.",
    });

    expect(tracker.metrics()).toMatchObject({
      invalidSamples: 3,
      latestSample: { metrics: validMetrics, receivedAtMs: 10_000 },
      samplesReceived: 1,
    });
  });
});
