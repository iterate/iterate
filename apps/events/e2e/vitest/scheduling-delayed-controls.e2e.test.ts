/**
 * Deployed delayed-schedule coverage over the public oRPC API only.
 *
 * These tests intentionally avoid private Durable Object methods. They drive
 * one-shot scheduling entirely through append/stream/getState so the control
 * events remain the contract.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_CONFIGURED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
  StreamPath,
  type EventType,
} from "@iterate-com/events-contract";
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
    const slug = `sched-${randomUUID()}`;
    const markerType =
      `https://events.iterate.com/events/example/delayed-cancelled/${randomUUID()}` as EventType;

    await appendDelayedSchedule({
      delaySeconds: shortDelaySeconds,
      markerType,
      path,
      slug,
    });

    await delay(1_000);

    await app.append({
      path,
      event: {
        type: SCHEDULE_CANCELLED_TYPE,
        payload: {
          slug,
        },
      },
    });

    await delay(10_000);

    const events = await readHistory(path);
    expect(events.map((event) => event.type)).toEqual([
      SCHEDULE_CONFIGURED_TYPE,
      SCHEDULE_CANCELLED_TYPE,
    ]);
    expect(events[0]?.payload).toMatchObject({
      slug,
      callback: "append",
      schedule: {
        kind: "once-in",
        delaySeconds: shortDelaySeconds,
      },
    });
    expect(events[1]?.payload).toEqual({
      slug,
    });
  }, 30_000);

  test("two delayed schedules fire in time order", async () => {
    const path = uniqueStreamPath();
    const firstSlug = `sched-${randomUUID()}`;
    const secondSlug = `sched-${randomUUID()}`;
    const firstMarkerType =
      `https://events.iterate.com/events/example/delayed-order/first/${randomUUID()}` as EventType;
    const secondMarkerType =
      `https://events.iterate.com/events/example/delayed-order/second/${randomUUID()}` as EventType;

    await appendDelayedSchedule({
      delaySeconds: firstFireDelaySeconds,
      markerType: firstMarkerType,
      path,
      slug: firstSlug,
    });
    await appendDelayedSchedule({
      delaySeconds: secondFireDelaySeconds,
      markerType: secondMarkerType,
      path,
      slug: secondSlug,
    });

    const events = await waitForHistoryMatch({
      path,
      predicate: (history) =>
        history.some((event) => event.type === firstMarkerType) &&
        history.some((event) => event.type === secondMarkerType),
      timeoutMs: 30_000,
    });

    expect(events.map((event) => event.type)).toEqual([
      SCHEDULE_CONFIGURED_TYPE,
      SCHEDULE_CONFIGURED_TYPE,
      firstMarkerType,
      SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
      secondMarkerType,
      SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
    ]);
    expect(events[2]?.payload).toEqual({
      slug: firstSlug,
      source: "alarm",
    });
    expect(events[4]?.payload).toEqual({
      slug: secondSlug,
      source: "alarm",
    });
  }, 45_000);

  test("a delayed schedule still fires after the stream has gone idle", async () => {
    const path = uniqueStreamPath();
    const slug = `sched-${randomUUID()}`;
    const markerType =
      `https://events.iterate.com/events/example/delayed-idle/${randomUUID()}` as EventType;

    await appendDelayedSchedule({
      delaySeconds: idleRestartDelaySeconds,
      markerType,
      path,
      slug,
    });

    const events = await waitForHistoryMatch({
      path,
      predicate: (history) => history.some((event) => event.type === markerType),
      timeoutMs: 90_000,
    });

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
});

async function appendDelayedSchedule(args: {
  delaySeconds: number;
  markerType: EventType;
  path: StreamPath;
  slug: string;
}) {
  await app.append({
    path: args.path,
    event: {
      type: SCHEDULE_CONFIGURED_TYPE,
      payload: {
        slug: args.slug,
        callback: "append",
        payloadJson: JSON.stringify({
          type: args.markerType,
          payload: {
            slug: args.slug,
            source: "alarm",
          },
        }),
        schedule: {
          kind: "once-in",
          delaySeconds: args.delaySeconds,
        },
        nextRunAt: Math.floor(Date.now() / 1000) + args.delaySeconds,
      },
    },
  });
}

async function readHistory(path: StreamPath) {
  const events = await collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({
      path,
      beforeOffset: "end",
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
