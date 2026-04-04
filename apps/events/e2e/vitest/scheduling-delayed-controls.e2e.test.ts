/**
 * Deployed delayed-schedule coverage over the public oRPC API only.
 *
 * These tests intentionally avoid private Durable Object methods. They drive
 * delayed one-shot schedules entirely through append/stream/getState so the
 * public API stays the contract.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { StreamPath, type EventType } from "@iterate-com/events-contract";
import {
  SCHEDULE_ADDED_TYPE,
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
const durableObjectConstructedType =
  "https://events.iterate.com/events/stream/durable-object-constructed";
const shortDelaySeconds = 8;
const firstFireDelaySeconds = 2;
const secondFireDelaySeconds = 4;
const idleRestartDelaySeconds = 62;

describeDeployedScheduling("events delayed scheduling e2e", () => {
  test("a delayed schedule can be cancelled before it fires", async () => {
    const path = uniqueStreamPath();
    const scheduleId = `sched-${randomUUID()}`;
    const markerType =
      `https://events.iterate.com/events/example/delayed-cancelled/${randomUUID()}` as EventType;

    await appendDelayedSchedule({
      delayInSeconds: shortDelaySeconds,
      markerType,
      path,
      scheduleId,
    });

    await delay(1_000);

    await app.append({
      path,
      event: {
        type: SCHEDULE_CANCELLED_TYPE,
        payload: {
          scheduleId,
        },
      },
    });

    await delay(10_000);

    const events = await readHistory(path);
    expect(events.map((event) => event.type)).toEqual([
      SCHEDULE_ADDED_TYPE,
      SCHEDULE_CANCELLED_TYPE,
    ]);
    expect(events[0]?.payload).toMatchObject({
      scheduleId,
      callback: "append",
      scheduleType: "delayed",
    });
    expect(events[1]?.payload).toEqual({
      scheduleId,
    });
    const state = await app.client.getState({ path });
    expect(state).toMatchObject({
      path,
      childPaths: [],
    });
    expect(state.eventCount).toBeGreaterThanOrEqual(3);
  }, 30_000);

  test("two delayed schedules fire in time order", async () => {
    const path = uniqueStreamPath();
    const firstScheduleId = `sched-${randomUUID()}`;
    const secondScheduleId = `sched-${randomUUID()}`;
    const firstMarkerType =
      `https://events.iterate.com/events/example/delayed-order/first/${randomUUID()}` as EventType;
    const secondMarkerType =
      `https://events.iterate.com/events/example/delayed-order/second/${randomUUID()}` as EventType;

    await appendDelayedSchedule({
      delayInSeconds: firstFireDelaySeconds,
      markerType: firstMarkerType,
      path,
      scheduleId: firstScheduleId,
    });
    await appendDelayedSchedule({
      delayInSeconds: secondFireDelaySeconds,
      markerType: secondMarkerType,
      path,
      scheduleId: secondScheduleId,
    });

    const events = await waitForHistoryMatch({
      path,
      predicate: (history) =>
        history.some((event) => event.type === firstMarkerType) &&
        history.some((event) => event.type === secondMarkerType),
      timeoutMs: 30_000,
    });

    expect(events.map((event) => event.type)).toEqual([
      SCHEDULE_ADDED_TYPE,
      SCHEDULE_ADDED_TYPE,
      firstMarkerType,
      SCHEDULE_EXECUTION_FINISHED_TYPE,
      secondMarkerType,
      SCHEDULE_EXECUTION_FINISHED_TYPE,
    ]);
    expect(events[0]?.payload).toMatchObject({
      scheduleId: firstScheduleId,
      callback: "append",
      scheduleType: "delayed",
    });
    expect(events[1]?.payload).toMatchObject({
      scheduleId: secondScheduleId,
      callback: "append",
      scheduleType: "delayed",
    });
    expect(events[2]?.payload).toEqual({
      scheduleId: firstScheduleId,
      source: "alarm",
    });
    expect(events[4]?.payload).toEqual({
      scheduleId: secondScheduleId,
      source: "alarm",
    });
    const state = await app.client.getState({ path });
    expect(state).toMatchObject({
      path,
      childPaths: [],
    });
    expect(state.eventCount).toBeGreaterThanOrEqual(6);
  }, 45_000);

  test("a delayed schedule still fires after the stream has gone idle", async () => {
    const path = uniqueStreamPath();
    const scheduleId = `sched-${randomUUID()}`;
    const markerType =
      `https://events.iterate.com/events/example/delayed-idle/${randomUUID()}` as EventType;

    await appendDelayedSchedule({
      delayInSeconds: idleRestartDelaySeconds,
      markerType,
      path,
      scheduleId,
    });

    const events = await waitForHistoryMatch({
      path,
      predicate: (history) => history.some((event) => event.type === markerType),
      timeoutMs: 90_000,
    });

    expect(events.map((event) => event.type)).toEqual([
      SCHEDULE_ADDED_TYPE,
      markerType,
      SCHEDULE_EXECUTION_FINISHED_TYPE,
    ]);
    expect(events[1]?.payload).toEqual({
      scheduleId,
      source: "alarm",
    });
    expect(events[2]?.payload).toMatchObject({
      scheduleId,
      outcome: "succeeded",
      nextTime: null,
    });
    const state = await app.client.getState({ path });
    expect(state).toMatchObject({
      path,
      childPaths: [],
    });
    expect(state.eventCount).toBeGreaterThanOrEqual(4);
  }, 110_000);
});

async function appendDelayedSchedule(args: {
  delayInSeconds: number;
  markerType: EventType;
  path: StreamPath;
  scheduleId: string;
}) {
  const time = Math.floor(Date.now() / 1000) + args.delayInSeconds;

  await app.append({
    path: args.path,
    event: {
      type: SCHEDULE_ADDED_TYPE,
      payload: {
        scheduleId: args.scheduleId,
        callback: "append",
        payloadJson: JSON.stringify({
          type: args.markerType,
          payload: {
            scheduleId: args.scheduleId,
            source: "alarm",
          },
        }),
        scheduleType: "delayed",
        time,
        delayInSeconds: args.delayInSeconds,
      },
    },
  });
}

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

    await delay(1_000);
  }

  throw new Error(`Timed out waiting for scheduled event on ${args.path}`);
}

function uniqueStreamPath() {
  return StreamPath.parse(`/e2e-delayed-scheduling/${randomUUID().slice(0, 8)}`);
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
