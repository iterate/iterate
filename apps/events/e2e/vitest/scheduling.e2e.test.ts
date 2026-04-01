/**
 * Deployed scheduler smoke over the public oRPC API only.
 *
 * We intentionally do not call private Durable Object methods here. Instead,
 * the test appends internal scheduler control events through the normal stream
 * append API, then waits for the alarm-driven callback side effects to appear
 * over the same public stream/history surface.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { StreamPath, type EventType } from "@iterate-com/events-contract";
import {
  SCHEDULE_ADDED_TYPE,
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

describeDeployedScheduling("events scheduling e2e", () => {
  test(
    "delayed schedule appended over oRPC fires once on a deployed worker",
    async () => {
      const path = uniqueStreamPath();
      const scheduleId = `sched-${randomUUID()}`;
      const markerType =
        `https://events.iterate.com/events/example/schedule-fired/${randomUUID()}` as EventType;
      const scheduledTime = Math.floor(Date.now() / 1000) + scheduleDelaySeconds;

      await app.client.append({
        path,
        type: SCHEDULE_ADDED_TYPE,
        payload: {
          scheduleId,
          callback: "append",
          payloadJson: JSON.stringify({
            events: [
              {
                path,
                type: markerType,
                payload: {
                  scheduleId,
                  source: "alarm",
                },
              },
            ],
          }),
          scheduleType: "delayed",
          time: scheduledTime,
          delayInSeconds: scheduleDelaySeconds,
        },
      });

      const firedEvents = await waitForHistoryMatch({
        path,
        timeoutMs: waitForAlarmTimeoutMs,
        predicate: (events) => events.some((event) => event.type === markerType),
      });

      expect(firedEvents.map((event) => event.type)).toEqual([
        SCHEDULE_ADDED_TYPE,
        markerType,
        SCHEDULE_EXECUTION_FINISHED_TYPE,
      ]);

      expect(firedEvents[0]?.payload).toMatchObject({
        scheduleId,
        callback: "append",
        scheduleType: "delayed",
      });
      expect(firedEvents[1]?.payload).toEqual({
        scheduleId,
        source: "alarm",
      });
      expect(firedEvents[2]?.payload).toMatchObject({
        scheduleId,
        outcome: "succeeded",
        nextTime: null,
      });

      await delay(settleAfterFireMs);

      const settledEvents = await readHistory(path);
      expect(settledEvents.map((event) => event.type)).toEqual([
        SCHEDULE_ADDED_TYPE,
        markerType,
        SCHEDULE_EXECUTION_FINISHED_TYPE,
      ]);

      expect(await app.client.getState({ streamPath: path })).toMatchObject({
        path,
        eventCount: 3,
      });
    },
    waitForAlarmTimeoutMs + settleAfterFireMs + 15_000,
  );
});

async function readHistory(path: StreamPath) {
  return collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({
      path,
      live: false,
    }),
    idleMs: historyIdleTimeoutMs,
  });
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
