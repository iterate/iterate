/**
 * Deployed scheduler smoke over the public oRPC API only.
 *
 * We intentionally do not call private Durable Object methods here. Instead,
 * the test appends the public append-scheduled event through the normal stream
 * append API, then waits for the alarm-driven callback side effects to appear
 * over the same public stream/history surface.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  STREAM_APPEND_SCHEDULED_TYPE,
  StreamPath,
  type EventType,
} from "@iterate-com/events-contract";
import {
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_EXECUTION_FINISHED_TYPE,
} from "../../src/durable-objects/scheduling-types.ts";
import {
  collectAsyncIterableUntilIdle,
  createEvents2AppFixture,
  requireEventsBaseUrl,
} from "../helpers.ts";

const describeDeployedScheduling = process.env.CI ? describe.skip : describe;
const eventsBaseUrl = process.env.CI ? "http://127.0.0.1" : requireEventsBaseUrl();
const app = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const historyIdleTimeoutMs = 250;
const pollIntervalMs = 1_000;
const scheduleDelaySeconds = 5;
const settleAfterFireMs = 8_000;
const waitForAlarmTimeoutMs = 90_000;
const durableObjectConstructedType =
  "https://events.iterate.com/events/stream/durable-object-constructed";

describeDeployedScheduling("events scheduling e2e", () => {
  test("append-scheduled fires within 10 seconds when scheduled for 5 seconds from now", async () => {
    const path = uniqueStreamPath();
    const scheduleId = `sched-${randomUUID()}`;
    const markerType =
      `https://events.iterate.com/events/example/schedule-fired-fast/${randomUUID()}` as EventType;

    await app.client.append({
      path,
      event: {
        type: STREAM_APPEND_SCHEDULED_TYPE,
        payload: {
          scheduleId,
          append: {
            type: markerType,
            payload: {
              scheduleId,
              source: "alarm",
            },
          },
          schedule: {
            kind: "once-in",
            delaySeconds: scheduleDelaySeconds,
          },
        },
      },
    });

    const firedEvents = await waitForHistoryMatch({
      path,
      timeoutMs: 10_000,
      predicate: (events) => events.some((event) => event.type === markerType),
    });

    expect(firedEvents.map((event) => event.type)).toContain(markerType);
    expect(firedEvents.some((event) => event.type === SCHEDULE_EXECUTION_FINISHED_TYPE)).toBe(true);
  }, 20_000);

  test(
    "append-scheduled event appended over oRPC fires once on a deployed worker",
    async () => {
      const path = uniqueStreamPath();
      const scheduleId = `sched-${randomUUID()}`;
      const markerType =
        `https://events.iterate.com/events/example/schedule-fired/${randomUUID()}` as EventType;
      const scheduledTime = Math.floor(Date.now() / 1000) + scheduleDelaySeconds;

      await app.client.append({
        path,
        event: {
          type: STREAM_APPEND_SCHEDULED_TYPE,
          payload: {
            scheduleId,
            append: {
              type: markerType,
              payload: {
                scheduleId,
                source: "alarm",
              },
            },
            schedule: {
              kind: "once-in",
              delaySeconds: scheduleDelaySeconds,
            },
          },
        },
      });

      const firedEvents = await waitForHistoryMatch({
        path,
        timeoutMs: waitForAlarmTimeoutMs,
        predicate: (events) => events.some((event) => event.type === markerType),
      });

      expect(firedEvents.map((event) => event.type)).toEqual([
        STREAM_APPEND_SCHEDULED_TYPE,
        "https://events.iterate.com/events/stream/schedule/added",
        markerType,
        SCHEDULE_EXECUTION_FINISHED_TYPE,
      ]);

      expect(firedEvents[0]?.payload).toMatchObject({
        scheduleId,
        schedule: {
          kind: "once-in",
          delaySeconds: scheduleDelaySeconds,
        },
      });
      expect(firedEvents[1]?.payload).toMatchObject({
        scheduleId,
        callback: "append",
        scheduleType: "delayed",
      });
      expect(
        (firedEvents[1]?.payload as { time?: number } | undefined)?.time,
      ).toBeGreaterThanOrEqual(scheduledTime);
      expect(firedEvents[2]?.payload).toEqual({
        scheduleId,
        source: "alarm",
      });
      expect(firedEvents[3]?.payload).toMatchObject({
        scheduleId,
        outcome: "succeeded",
        nextTime: null,
      });

      await delay(settleAfterFireMs);

      const settledEvents = await readHistory(path);
      expect(settledEvents.map((event) => event.type)).toEqual([
        STREAM_APPEND_SCHEDULED_TYPE,
        "https://events.iterate.com/events/stream/schedule/added",
        markerType,
        SCHEDULE_EXECUTION_FINISHED_TYPE,
      ]);

      expect(await app.client.getState({ path })).toMatchObject({
        path,
        eventCount: 5,
        childPaths: [],
      });
    },
    waitForAlarmTimeoutMs + settleAfterFireMs + 15_000,
  );

  test(
    "append-scheduled can be cancelled through schedule-cancelled before it fires",
    async () => {
      const path = uniqueStreamPath();
      const scheduleId = `sched-${randomUUID()}`;
      const markerType =
        `https://events.iterate.com/events/example/schedule-cancelled/${randomUUID()}` as EventType;

      await app.client.append({
        path,
        event: {
          type: STREAM_APPEND_SCHEDULED_TYPE,
          payload: {
            scheduleId,
            append: {
              type: markerType,
              payload: {
                scheduleId,
                source: "alarm",
              },
            },
            schedule: {
              kind: "once-in",
              delaySeconds: scheduleDelaySeconds,
            },
          },
        },
      });

      await waitForHistoryMatch({
        path,
        timeoutMs: waitForAlarmTimeoutMs,
        predicate: (events) =>
          events.some(
            (event) => event.type === "https://events.iterate.com/events/stream/schedule/added",
          ),
      });

      await app.client.append({
        path,
        event: {
          type: SCHEDULE_CANCELLED_TYPE,
          payload: {
            scheduleId,
          },
        },
      });

      await delay(scheduleDelaySeconds * 1000 + 4_000);

      const settledEvents = await readHistory(path);
      expect(settledEvents.map((event) => event.type)).toEqual([
        STREAM_APPEND_SCHEDULED_TYPE,
        "https://events.iterate.com/events/stream/schedule/added",
        SCHEDULE_CANCELLED_TYPE,
      ]);

      expect(settledEvents.some((event) => event.type === markerType)).toBe(false);
      expect(settledEvents.some((event) => event.type === SCHEDULE_EXECUTION_FINISHED_TYPE)).toBe(
        false,
      );
    },
    scheduleDelaySeconds * 1000 + 20_000,
  );
});

async function readHistory(path: StreamPath) {
  const events = await collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({
      path,
      live: false,
    }),
    idleMs: historyIdleTimeoutMs,
  });

  return events.filter(
    (event) =>
      !(
        event.type === durableObjectConstructedType ||
        (event.type === "https://events.iterate.com/events/stream/initialized" &&
          event.streamPath === path &&
          getPayloadPath(event) === path)
      ),
  );
}

async function waitForHistoryMatch(args: {
  path: StreamPath;
  predicate(events: Awaited<ReturnType<typeof readHistory>>): boolean;
  timeoutMs: number;
}) {
  const deadline = Date.now() + args.timeoutMs;

  while (Date.now() < deadline) {
    const events = await readHistory(args.path);
    if (args.predicate(events)) {
      return events;
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for scheduled event on ${args.path}`);
}

function uniqueStreamPath() {
  return StreamPath.parse(`/e2e-scheduling/${randomUUID().slice(0, 8)}`);
}

function getPayloadPath(event: { payload: unknown }) {
  if (
    typeof event.payload === "object" &&
    event.payload !== null &&
    "path" in event.payload &&
    typeof event.payload.path === "string"
  ) {
    return event.payload.path;
  }

  return undefined;
}
