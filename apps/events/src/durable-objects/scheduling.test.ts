import { setTimeout as delay } from "node:timers/promises";
import { env } from "cloudflare:test";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_CONFIGURED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
  STREAM_APPEND_SCHEDULED_TYPE,
} from "@iterate-com/events-contract";
import { describe, expect, it } from "vitest";
import { HUNG_INTERVAL_TIMEOUT_SECONDS } from "~/durable-objects/scheduling.ts";
import workerEntry, {
  StreamDurableObject,
  type TestScheduleStreamDurableObject,
} from "~/entry.workerd.vitest.ts";

// `vitest.config.ts` wires the worker entry by path/class-name strings. Touch
// the exports here so static analysis also sees the runtime-required symbols.
void workerEntry;
void StreamDurableObject;

const testEnv = env as {
  TEST_SCHEDULE_STREAM: DurableObjectNamespace<TestScheduleStreamDurableObject>;
};

describe("scheduler control events", () => {
  it("eventually rewrites append-scheduled into schedule-configured", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("append-scheduled-test");
    const slug = "append-scheduled-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/append-scheduled-test" });
    await streamStub.append({
      type: STREAM_APPEND_SCHEDULED_TYPE,
      payload: {
        slug,
        append: {
          type: "https://events.iterate.com/events/example/append-scheduled-fired",
          payload: {
            source: "test",
          },
        },
        schedule: {
          kind: "once-in",
          delaySeconds: 60,
        },
      },
    });

    const [events, state] = await waitForSchedulerProjection({
      predicate: (value) => value[slug] != null,
      streamStub,
    });

    expect(events.slice(-2).map((event) => event.type)).toEqual([
      STREAM_APPEND_SCHEDULED_TYPE,
      SCHEDULE_CONFIGURED_TYPE,
    ]);
    expect(state[slug]).toMatchObject({
      callback: "append",
      executionCount: 0,
      payloadJson: JSON.stringify({
        type: "https://events.iterate.com/events/example/append-scheduled-fired",
        payload: {
          source: "test",
        },
      }),
      schedule: {
        kind: "once-in",
        delaySeconds: 60,
      },
      running: false,
    });

    const configuredPayload = events.at(-1)?.payload as { nextRunAt: number } | undefined;
    expect(await streamStub.getStoredAlarm()).toBe(configuredPayload?.nextRunAt * 1000);
  });

  it("schedule-configured upserts the slug in scheduler state", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("configured-upsert-test");
    const slug = "upsert-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/configured-upsert-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "testCallback",
        nextRunAt: Math.floor(Date.now() / 1000) + 60,
        schedule: {
          kind: "once-in",
          delaySeconds: 60,
        },
        slug,
      }),
    );
    await streamStub.append(
      makeConfiguredEvent({
        callback: "intervalCallback",
        nextRunAt: Math.floor(Date.now() / 1000) + 1,
        payloadJson: JSON.stringify({ hello: "world" }),
        schedule: {
          kind: "every",
          intervalSeconds: 1,
        },
        slug,
      }),
    );

    const schedulerState = (await streamStub.getState()).processors.scheduler;
    expect(Object.keys(schedulerState)).toEqual([slug]);
    expect(schedulerState[slug]).toMatchObject({
      callback: "intervalCallback",
      executionCount: 0,
      payloadJson: JSON.stringify({ hello: "world" }),
      schedule: {
        kind: "every",
        intervalSeconds: 1,
      },
    });
  });

  it("schedule-cancelled removes the slug and clears the alarm", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("configured-cancelled-test");
    const slug = "cancelled-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/configured-cancelled-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "testCallback",
        nextRunAt: Math.floor(Date.now() / 1000) + 60,
        schedule: {
          kind: "once-in",
          delaySeconds: 60,
        },
        slug,
      }),
    );

    await waitForSchedulerProjection({
      predicate: (value) => value[slug] != null,
      streamStub,
    });

    await streamStub.append({
      type: SCHEDULE_CANCELLED_TYPE,
      payload: {
        slug,
      },
    });

    await waitForSchedulerProjection({
      predicate: (value) => value[slug] == null,
      streamStub,
    });

    expect(await streamStub.getStoredAlarm()).toBeNull();
  });

  it("alarm fires a one-shot configured append and retires it", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("alarm-once-test");
    const slug = "once-slug";
    const markerType = "https://events.iterate.com/events/example/schedule-fired-once";

    await streamStub.initialize({ projectSlug: "test", path: "/alarm-once-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "append",
        nextRunAt: Math.floor(Date.now() / 1000) - 1,
        payloadJson: JSON.stringify({
          type: markerType,
          payload: {
            slug,
            source: "alarm",
          },
        }),
        schedule: {
          kind: "once-in",
          delaySeconds: 1,
        },
        slug,
      }),
    );

    await runDurableObjectAlarm(streamStub);

    const history = await waitForCondition(async () => {
      const nextHistory = await streamStub.history();
      return nextHistory.some((event) => event.type === markerType) ? nextHistory : false;
    });
    expect(history.map((event) => event.type)).toContain(markerType);
    expect(history.map((event) => event.type)).toContain(SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE);
    expect((await streamStub.getState()).processors.scheduler[slug]).toBeUndefined();
  });

  it("invalid callbacks are retired with a failed internal finish event", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("invalid-callback-test");
    const slug = "invalid-callback-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/invalid-callback-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "missingCallback",
        nextRunAt: Math.floor(Date.now() / 1000) - 1,
        schedule: {
          kind: "once-in",
          delaySeconds: 1,
        },
        slug,
      }),
    );

    await runDurableObjectAlarm(streamStub);

    const finishedEvent = await waitForCondition(async () => {
      const history = await streamStub.history();
      return (
        history.find((event) => event.type === SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE) || false
      );
    });

    expect(finishedEvent.payload).toEqual({
      slug,
      outcome: "failed",
      nextRunAt: null,
    });
    expect((await streamStub.getState()).processors.scheduler[slug]).toBeUndefined();
  });

  it("disallowed callbacks are never invoked on the durable object instance", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("disallowed-callback-test");
    const slug = "disallowed-callback-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/disallowed-callback-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "destroy",
        nextRunAt: Math.floor(Date.now() / 1000) - 1,
        schedule: {
          kind: "once-in",
          delaySeconds: 1,
        },
        slug,
      }),
    );

    await runDurableObjectAlarm(streamStub);

    const finishedEvent = await waitForCondition(async () => {
      const history = await streamStub.history();
      return (
        history.find((event) => event.type === SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE) || false
      );
    });

    expect(finishedEvent.payload).toEqual({
      slug,
      outcome: "failed",
      nextRunAt: null,
    });
    expect((await streamStub.getState()).path).toBe("/disallowed-callback-test");
    expect((await streamStub.getState()).processors.scheduler[slug]).toBeUndefined();
  });

  it("interval schedules append internal execution-started and stay configured", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("interval-running-test");
    const slug = "interval-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/interval-running-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "intervalCallback",
        nextRunAt: Math.floor(Date.now() / 1000) - 1,
        schedule: {
          kind: "every",
          intervalSeconds: 1,
        },
        slug,
      }),
    );

    await runDurableObjectAlarm(streamStub);

    const history = await streamStub.history();
    expect(history.map((event) => event.type)).toEqual([
      "https://events.iterate.com/events/stream/initialized",
      SCHEDULE_CONFIGURED_TYPE,
      SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
      SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
    ]);

    const schedulerEntry = (await streamStub.getState()).processors.scheduler[slug];
    expect(schedulerEntry).toMatchObject({
      executionCount: 1,
      running: false,
      schedule: {
        kind: "every",
        intervalSeconds: 1,
      },
    });
    expect(schedulerEntry?.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1);
  });

  it("non-hung running intervals re-arm to the hang timeout instead of running immediately", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("interval-recovery-alarm-test");
    const slug = "running-interval-slug";
    const nowSeconds = Math.floor(Date.now() / 1000);

    await streamStub.initialize({ projectSlug: "test", path: "/interval-recovery-alarm-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "intervalCallback",
        nextRunAt: nowSeconds + 60,
        schedule: {
          kind: "every",
          intervalSeconds: 1,
        },
        slug,
      }),
    );
    await streamStub.append({
      type: SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
      payload: {
        slug,
        startedAt: nowSeconds,
      },
    });

    await waitForCondition(async () => {
      const alarm = await streamStub.getStoredAlarm();
      return alarm != null && alarm >= (nowSeconds + HUNG_INTERVAL_TIMEOUT_SECONDS) * 1000;
    });

    const history = await streamStub.history();
    expect(history.map((event) => event.type)).toEqual([
      "https://events.iterate.com/events/stream/initialized",
      SCHEDULE_CONFIGURED_TYPE,
      SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
    ]);
  });

  it("hung running intervals recover on the next alarm", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("hung-interval-recovery-test");
    const slug = "hung-interval-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/hung-interval-recovery-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "intervalCallback",
        nextRunAt: Math.floor(Date.now() / 1000) - 1,
        schedule: {
          kind: "every",
          intervalSeconds: 1,
        },
        slug,
      }),
    );
    await streamStub.append({
      type: SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
      payload: {
        slug,
        startedAt: Math.floor(Date.now() / 1000) - HUNG_INTERVAL_TIMEOUT_SECONDS - 1,
      },
    });

    await runDurableObjectAlarm(streamStub);

    const history = await streamStub.history();
    const finishedEvents = history.filter(
      (event) => event.type === SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
    );
    expect(finishedEvents).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          nextRunAt: expect.any(Number),
          outcome: "succeeded",
          slug,
        }),
      }),
    );
  });

  it("malformed payloadJson retires the schedule without invoking the callback", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("malformed-payload-test");
    const slug = "malformed-payload-slug";

    await streamStub.initialize({ projectSlug: "test", path: "/malformed-payload-test" });
    await streamStub.append(
      makeConfiguredEvent({
        callback: "intervalCallback",
        nextRunAt: Math.floor(Date.now() / 1000) - 1,
        payloadJson: "{not-json",
        schedule: {
          kind: "once-in",
          delaySeconds: 1,
        },
        slug,
      }),
    );

    await runDurableObjectAlarm(streamStub);

    const intervalCallbackCount = await runInDurableObject(
      streamStub,
      (instance: TestScheduleStreamDurableObject) => instance.intervalCallbackCount,
    );

    expect(intervalCallbackCount).toBe(0);
    expect((await streamStub.getState()).processors.scheduler[slug]).toBeUndefined();
  });
});

function makeConfiguredEvent(args: {
  callback: string;
  nextRunAt: number;
  payloadJson?: string | null;
  schedule:
    | { kind: "once-at"; at: string }
    | { kind: "once-in"; delaySeconds: number }
    | { kind: "every"; intervalSeconds: number }
    | { kind: "cron"; cron: string };
  slug: string;
}) {
  return {
    type: SCHEDULE_CONFIGURED_TYPE,
    payload: {
      slug: args.slug,
      callback: args.callback,
      payloadJson: args.payloadJson ?? null,
      schedule: args.schedule,
      nextRunAt: args.nextRunAt,
    },
  } as const;
}

async function waitForSchedulerProjection(args: {
  predicate(value: Awaited<ReturnType<typeof readSchedulerState>>): boolean;
  streamStub: DurableObjectStub<TestScheduleStreamDurableObject>;
}) {
  return waitForCondition(async () => {
    const state = await readSchedulerState(args.streamStub);
    if (!args.predicate(state)) {
      return false;
    }

    return [await args.streamStub.history(), state] as const;
  });
}

async function readSchedulerState(streamStub: DurableObjectStub<TestScheduleStreamDurableObject>) {
  return (await streamStub.getState()).processors.scheduler;
}

async function waitForCondition<T>(predicate: () => Promise<T | false>) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await predicate();
    if (value !== false) {
      return value;
    }

    await delay(10);
  }

  throw new Error("Timed out waiting for scheduling condition");
}
