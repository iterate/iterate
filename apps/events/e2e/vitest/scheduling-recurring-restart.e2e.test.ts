/**
 * Extra scheduler coverage over the public oRPC API only.
 *
 * The tests here avoid private Durable Object access and focus on repeated
 * interval execution plus recovery after a long idle gap.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  SCHEDULE_CONFIGURED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
  StreamPath,
  type EventType,
} from "@iterate-com/events-contract";
import { describe, expect, test } from "vitest";
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
const intervalFireDelayMs = 12_000;
const idleGapDelayMs = 75_000;
const wakeCanaryIdleGapMs = 180_000;
const wakeCanaryFutureDelaySeconds = 600;
const durableObjectConstructedType =
  "https://events.iterate.com/events/stream/durable-object-constructed";

describeDeployedScheduling("events recurring/restart scheduling e2e", () => {
  test("an interval schedule keeps emitting ordered callback and finished events", async () => {
    const path = uniqueStreamPath("interval");
    const slug = `sched-${randomUUID()}`;
    const markerType =
      `https://events.iterate.com/events/example/interval-fired/${randomUUID()}` as EventType;

    await app.client.append({
      path,
      event: {
        type: SCHEDULE_CONFIGURED_TYPE,
        payload: {
          slug,
          callback: "append",
          payloadJson: JSON.stringify({
            type: markerType,
            payload: {
              slug,
              source: "alarm",
            },
          }),
          schedule: {
            kind: "every",
            intervalSeconds: 1,
          },
          nextRunAt: Math.floor(Date.now() / 1000) + 1,
        },
      },
    });

    await delay(intervalFireDelayMs);

    const events = await readHistory(path);
    const types = events.map((event) => event.type);

    expect(countTypes(types, markerType)).toBeGreaterThanOrEqual(2);
    expect(countTypes(types, SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE)).toBeGreaterThanOrEqual(2);
    expect(countTypes(types, SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE)).toBeGreaterThanOrEqual(2);
    expect(types.slice(0, 8)).toEqual([
      SCHEDULE_CONFIGURED_TYPE,
      SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
      markerType,
      SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
      SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
      markerType,
      SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
      SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
    ]);

    expect(events[2]?.payload).toEqual({
      slug,
      source: "alarm",
    });
    expect(events[3]?.payload).toMatchObject({
      slug,
      outcome: "succeeded",
      nextRunAt: expect.any(Number),
    });
  }, 45_000);

  test("a delayed schedule still fires after the stream has been idle long enough to restart", async () => {
    const path = uniqueStreamPath("idle-gap");
    const slug = `sched-${randomUUID()}`;
    const markerType =
      `https://events.iterate.com/events/example/delayed-idle/${randomUUID()}` as EventType;

    await app.client.append({
      path,
      event: {
        type: SCHEDULE_CONFIGURED_TYPE,
        payload: {
          slug,
          callback: "append",
          payloadJson: JSON.stringify({
            type: markerType,
            payload: {
              slug,
              source: "alarm",
            },
          }),
          schedule: {
            kind: "once-in",
            delaySeconds: 70,
          },
          nextRunAt: Math.floor(Date.now() / 1000) + 70,
        },
      },
    });

    await delay(idleGapDelayMs);

    const events = await readHistory(path);
    expect(events.map((event) => event.type)).toEqual([
      SCHEDULE_CONFIGURED_TYPE,
      markerType,
      SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
    ]);
    expect(events[1]?.payload).toEqual({
      slug,
      source: "alarm",
    });
    expect(events[2]?.payload).toMatchObject({
      slug,
      outcome: "succeeded",
      nextRunAt: null,
    });
  }, 110_000);

  test("a foreground request wakes an idle stream after three minutes and leaves wake evidence", async () => {
    const path = uniqueStreamPath("wake-canary");
    const slug = `sched-${randomUUID()}`;

    await app.client.append({
      path,
      event: {
        type: SCHEDULE_CONFIGURED_TYPE,
        payload: {
          slug,
          callback: "append",
          payloadJson: JSON.stringify({
            type: `https://events.iterate.com/events/example/wake-canary/${randomUUID()}` as EventType,
            payload: {
              slug,
              source: "alarm",
            },
          }),
          schedule: {
            kind: "once-in",
            delaySeconds: wakeCanaryFutureDelaySeconds,
          },
          nextRunAt: Math.floor(Date.now() / 1000) + wakeCanaryFutureDelaySeconds,
        },
      },
    });

    await delay(wakeCanaryIdleGapMs);

    const state = await app.client.getState({ path });
    expect(state.processors.scheduler[slug]).toMatchObject({
      callback: "append",
      schedule: {
        kind: "once-in",
        delaySeconds: wakeCanaryFutureDelaySeconds,
      },
    });

    const events = await readHistoryIncludingWake(path);
    expect(events.map((event) => event.type)).toContain(SCHEDULE_CONFIGURED_TYPE);
    expect(events.map((event) => event.type)).toContain(durableObjectConstructedType);

    const configuredOffset = events.find(
      (event) => event.type === SCHEDULE_CONFIGURED_TYPE,
    )?.offset;
    const wakeOffset = events.find((event) => event.type === durableObjectConstructedType)?.offset;

    expect(configuredOffset).toBeTypeOf("number");
    expect(wakeOffset).toBeTypeOf("number");
    expect((wakeOffset ?? 0) > (configuredOffset ?? Number.POSITIVE_INFINITY)).toBe(true);
  }, 230_000);
});

async function readHistory(path: StreamPath) {
  const events = await collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({
      path,
      before: "end",
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

async function readHistoryIncludingWake(path: StreamPath) {
  const events = await collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({
      path,
      before: "end",
    }),
    idleMs: historyIdleTimeoutMs,
  });

  return events.filter(
    (event) =>
      !(
        event.type === "https://events.iterate.com/events/stream/initialized" &&
        event.streamPath === path &&
        getPayloadPath(event) === path
      ),
  );
}

function countTypes(types: string[], type: string) {
  return types.filter((value) => value === type).length;
}

function uniqueStreamPath(scope: string) {
  return StreamPath.parse(`/e2e-scheduling/${scope}-${randomUUID().slice(0, 8)}`);
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
