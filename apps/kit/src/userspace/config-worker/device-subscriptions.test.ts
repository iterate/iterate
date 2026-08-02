import { describe, expect, test } from "vitest";
import { DeviceSubscriptionCoordinator } from "./device-subscriptions.ts";

describe("userspace device subscription ownership", () => {
  test("keeps the working PTT event callback when the independent metrics capacity is exhausted", async () => {
    /*
     * Production reproduced this exact partial success: the device delivered
     * seven initial event snapshots, but each subsequent metrics subscription
     * failed. Treating both calls as one transaction disposed the Cap'n Web
     * session that owned the already-working PTT callback, so an online Stick
     * could open /pcm yet never start Grok or forward microphone frames.
     *
     * Metrics are important evidence, but losing them must be a visible
     * degraded state—not permission to disable the realtime control path.
     */
    let eventCallback: (() => void) | undefined;
    let acceptedEvents = 0;
    let releasedProjects = 0;
    const coordinator = new DeviceSubscriptionCoordinator({
      isCurrent: () => true,
      onDiagnostic: () => undefined,
      openProject: async () => ({ generation: 1 }),
      releaseProject: () => {
        releasedProjects += 1;
      },
      retainProject: () => true,
      retryDelaysMs: [0, 0],
      subscribeToEvents: async () => {
        eventCallback = () => {
          acceptedEvents += 1;
        };
        eventCallback();
      },
      subscribeToMetrics: async () => {
        throw new Error("metrics subscription limit reached");
      },
      wait: async () => undefined,
    });

    await coordinator.establish();
    eventCallback?.();

    expect(acceptedEvents).toBe(2);
    expect(releasedProjects).toBe(0);
    expect(coordinator.metrics()).toEqual({
      eventAttempts: 1,
      eventFailures: 0,
      eventReady: true,
      lastEventError: null,
      lastMetricsError: "metrics subscription limit reached",
      metricsAttempts: 2,
      metricsFailures: 2,
      metricsReady: false,
    });
  });
});
