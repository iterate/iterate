import { describe, expect, test } from "vitest";
import { DeviceSubscriptionCoordinator } from "./device-subscriptions.ts";

describe("userspace device subscription ownership", () => {
  test("keeps recovering the critical event callback after the warm-up retry ladder", async () => {
    /*
     * A production Stick recovered its independent /pcm WebSocket while its
     * Cap'n Web capability remained unavailable. The old seven-attempt loop
     * then stopped forever: a later device remount could not restore PTT for
     * that otherwise-live PCM session. The delay list is a backoff shape, not
     * a declaration that a physical device becomes permanently irrelevant
     * after 15.75 seconds. Once its last delay is reached, the coordinator
     * must retain that bounded cadence until either the callback succeeds or
     * the owning PCM generation ends.
     */
    const diagnostics: Array<{ code: string; nextDelayMs: number | null }> = [];
    const waits: number[] = [];
    let eventAttempts = 0;
    let releasedProjects = 0;
    const coordinator = new DeviceSubscriptionCoordinator({
      isCurrent: () => true,
      onDiagnostic: (diagnostic) => {
        diagnostics.push({ code: diagnostic.code, nextDelayMs: diagnostic.nextDelayMs });
      },
      openProject: async () => ({ generation: eventAttempts + 1 }),
      releaseProject: () => {
        releasedProjects += 1;
      },
      retainProject: () => true,
      retryDelaysMs: [0, 1, 2],
      subscribeToEvents: async () => {
        eventAttempts += 1;
        if (eventAttempts < 5) throw new Error("capability offline");
      },
      subscribeToMetrics: async () => undefined,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    await coordinator.establish();

    expect(eventAttempts).toBe(5);
    expect(releasedProjects).toBe(4);
    expect(waits).toEqual([1, 2, 2, 2]);
    expect(diagnostics).toEqual([
      { code: "device-event-subscribe-retrying", nextDelayMs: 1 },
      { code: "device-event-subscribe-retrying", nextDelayMs: 2 },
      { code: "device-event-subscribe-retrying", nextDelayMs: 2 },
      { code: "device-event-subscribed", nextDelayMs: null },
      { code: "device-metrics-subscribed", nextDelayMs: null },
    ]);
    expect(coordinator.metrics()).toMatchObject({
      eventAttempts: 5,
      eventFailures: 4,
      eventReady: true,
      lastEventError: null,
    });
  });

  test("abandons event recovery when its owning PCM generation ends", async () => {
    /*
     * Lifetime recovery must not become a leaked retry task after a replacement
     * /pcm session takes ownership. Re-checking isCurrent after every bounded
     * wait makes the old generation self-cancel without an AbortController or
     * another timer-owning abstraction in the Durable Object.
     */
    let current = true;
    let eventAttempts = 0;
    let waits = 0;
    const coordinator = new DeviceSubscriptionCoordinator({
      isCurrent: () => current,
      onDiagnostic: () => undefined,
      openProject: async () => ({ generation: eventAttempts + 1 }),
      releaseProject: () => undefined,
      retainProject: () => true,
      retryDelaysMs: [0, 1],
      subscribeToEvents: async () => {
        eventAttempts += 1;
        throw new Error("capability offline");
      },
      subscribeToMetrics: async () => undefined,
      wait: async () => {
        waits += 1;
        if (waits === 3) current = false;
      },
    });

    await coordinator.establish();

    expect(eventAttempts).toBe(3);
    expect(waits).toBe(3);
    expect(coordinator.metrics()).toMatchObject({
      eventAttempts: 3,
      eventFailures: 3,
      eventReady: false,
    });
  });

  test("does not publish a late event subscription into a closed PCM generation", async () => {
    /*
     * A Cap'n Web subscribe call may settle after a newer /pcm socket has
     * already replaced this session. Checking ownership only before the await
     * would record a ghost eventReady=true and retain an export whose callback
     * can no longer control the current bridge.
     */
    let current = true;
    let releaseSubscription: (() => void) | undefined;
    let markSubscriptionStarted: (() => void) | undefined;
    let releasedProjects = 0;
    const subscriptionStarted = new Promise<void>((resolve) => {
      markSubscriptionStarted = resolve;
    });
    const subscriptionSettles = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    const diagnostics: string[] = [];
    const coordinator = new DeviceSubscriptionCoordinator({
      isCurrent: () => current,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      openProject: async () => ({ generation: 1 }),
      releaseProject: () => {
        releasedProjects += 1;
      },
      retainProject: () => true,
      retryDelaysMs: [0, 1],
      subscribeToEvents: async () => {
        markSubscriptionStarted?.();
        await subscriptionSettles;
      },
      subscribeToMetrics: async () => undefined,
      wait: async () => undefined,
    });

    const establishing = coordinator.establish();
    await subscriptionStarted;
    current = false;
    releaseSubscription?.();
    await establishing;

    expect(releasedProjects).toBe(1);
    expect(diagnostics).toEqual([]);
    expect(coordinator.metrics()).toMatchObject({
      eventAttempts: 1,
      eventFailures: 0,
      eventReady: false,
      metricsAttempts: 0,
    });
  });

  test("keeps recovering metrics for the lifetime of the retained event project", async () => {
    /*
     * Metrics are the only low-cost heartbeat and buffer/heap evidence during
     * unattended calls. A temporary subscriber-capacity failure must remain a
     * visible degraded state, but a finite attempt budget would discard the
     * only automatic route back to observability while PTT stays live.
     */
    let metricsAttempts = 0;
    let releasedProjects = 0;
    const waits: number[] = [];
    const coordinator = new DeviceSubscriptionCoordinator({
      isCurrent: () => true,
      onDiagnostic: () => undefined,
      openProject: async () => ({ generation: 1 }),
      releaseProject: () => {
        releasedProjects += 1;
      },
      retainProject: () => true,
      retryDelaysMs: [0, 1, 2],
      subscribeToEvents: async () => undefined,
      subscribeToMetrics: async () => {
        metricsAttempts += 1;
        if (metricsAttempts < 5) throw new Error("metrics subscription limit reached");
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    await coordinator.establish();

    expect(metricsAttempts).toBe(5);
    expect(releasedProjects).toBe(0);
    expect(waits).toEqual([1, 2, 2, 2]);
    expect(coordinator.metrics()).toMatchObject({
      eventReady: true,
      metricsAttempts: 5,
      metricsFailures: 4,
      metricsReady: true,
      lastMetricsError: null,
    });
  });

  test("does not report metrics ready after the PCM generation closes in flight", async () => {
    let current = true;
    let releaseSubscription: (() => void) | undefined;
    let markSubscriptionStarted: (() => void) | undefined;
    const subscriptionStarted = new Promise<void>((resolve) => {
      markSubscriptionStarted = resolve;
    });
    const subscriptionSettles = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    const diagnostics: string[] = [];
    const coordinator = new DeviceSubscriptionCoordinator({
      isCurrent: () => current,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      openProject: async () => ({ generation: 1 }),
      releaseProject: () => undefined,
      retainProject: () => true,
      retryDelaysMs: [0, 1],
      subscribeToEvents: async () => undefined,
      subscribeToMetrics: async () => {
        markSubscriptionStarted?.();
        await subscriptionSettles;
      },
      wait: async () => undefined,
    });

    const establishing = coordinator.establish();
    await subscriptionStarted;
    current = false;
    releaseSubscription?.();
    await establishing;

    expect(diagnostics).toEqual(["device-event-subscribed"]);
    expect(coordinator.metrics()).toMatchObject({
      eventReady: true,
      metricsAttempts: 1,
      metricsFailures: 0,
      metricsReady: false,
    });
  });

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
    let current = true;
    let metricsAttempts = 0;
    let releasedProjects = 0;
    const coordinator = new DeviceSubscriptionCoordinator({
      isCurrent: () => current,
      onDiagnostic: () => undefined,
      openProject: async () => ({ generation: 1 }),
      releaseProject: () => {
        releasedProjects += 1;
      },
      retainProject: () => true,
      retryDelaysMs: [0, 1],
      subscribeToEvents: async () => {
        eventCallback = () => {
          acceptedEvents += 1;
        };
        eventCallback();
      },
      subscribeToMetrics: async () => {
        metricsAttempts += 1;
        if (metricsAttempts === 2) current = false;
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
