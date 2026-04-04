import { describe, expect, test } from "vitest";
import {
  type Event,
  type EventInput,
  type CircuitBreakerState,
} from "@iterate-com/events-contract";
import { circuitBreakerProcessor } from "./circuit-breaker.ts";

describe("circuitBreaker", () => {
  test("reduce tracks recent event timestamps", () => {
    const state = structuredClone(circuitBreakerProcessor.initialState);

    const nextState = circuitBreakerProcessor.reduce!({
      state,
      event: createEvent({ createdAt: "2026-04-02T12:00:00.000Z" }),
    });

    expect(nextState).toEqual({
      recentEventTimestamps: ["2026-04-02T12:00:00.000Z"],
      paused: false,
      pauseReason: null,
      pausedAt: null,
    });
  });

  test("beforeAppend rejects new events while paused but still allows stream/resumed", () => {
    const state: CircuitBreakerState = {
      ...circuitBreakerProcessor.initialState,
      paused: true,
      pauseReason: "manual pause",
      pausedAt: "2026-04-02T12:00:00.000Z",
    };

    expect(() =>
      circuitBreakerProcessor.beforeAppend?.({
        state,
        event: {
          type: "example",
          payload: {},
        },
      }),
    ).toThrow("stream is paused; only stream/resumed is allowed");

    expect(() =>
      circuitBreakerProcessor.beforeAppend?.({
        state,
        event: {
          type: "https://events.iterate.com/events/stream/resumed",
          payload: { reason: "operator override" },
        },
      }),
    ).not.toThrow();
  });

  test("reduce stores paused and resumed state transitions", () => {
    const state = structuredClone(circuitBreakerProcessor.initialState);

    const pausedState = circuitBreakerProcessor.reduce!({
      state,
      event: createEvent({
        type: "https://events.iterate.com/events/stream/paused",
        payload: { reason: "too hot" },
        createdAt: "2026-04-02T12:00:00.000Z",
      }),
    });

    expect(pausedState).toEqual({
      paused: true,
      pauseReason: "too hot",
      pausedAt: "2026-04-02T12:00:00.000Z",
      recentEventTimestamps: ["2026-04-02T12:00:00.000Z"],
    });

    const resumedState = circuitBreakerProcessor.reduce!({
      state: pausedState,
      event: createEvent({
        type: "https://events.iterate.com/events/stream/resumed",
        payload: { reason: "operator override" },
        createdAt: "2026-04-02T12:00:05.000Z",
      }),
    });

    expect(resumedState).toEqual({
      paused: false,
      pauseReason: null,
      pausedAt: null,
      recentEventTimestamps: ["2026-04-02T12:00:05.000Z"],
    });
  });

  test("afterAppend auto-appends a pause event when 100 events arrive in under one second", async () => {
    const appended: EventInput[] = [];
    const base = Date.parse("2026-04-02T12:00:00.000Z");
    const recentEventTimestamps = Array.from({ length: 100 }, (_, index) =>
      new Date(base + index * 9).toISOString(),
    );

    await circuitBreakerProcessor.afterAppend?.({
      append: (event) => {
        appended.push(event);
        return createEvent({
          type: event.type,
          payload: event.payload,
        });
      },
      event: createEvent({
        createdAt: recentEventTimestamps[99],
      }),
      state: {
        paused: false,
        pauseReason: null,
        pausedAt: null,
        recentEventTimestamps,
      },
    });

    expect(appended).toEqual([
      {
        type: "https://events.iterate.com/events/stream/paused",
        payload: {
          reason: "circuit breaker tripped: 100 events in under 1 second",
        },
      },
    ]);
  });

  test("afterAppend rejects when append fails", async () => {
    const base = Date.parse("2026-04-02T12:00:00.000Z");
    const recentEventTimestamps = Array.from({ length: 100 }, (_, index) =>
      new Date(base + index * 9).toISOString(),
    );

    await expect(
      circuitBreakerProcessor.afterAppend?.({
        append: () => {
          throw new Error("sqlite write failed");
        },
        event: createEvent({ createdAt: recentEventTimestamps[99] }),
        state: {
          paused: false,
          pauseReason: null,
          pausedAt: null,
          recentEventTimestamps,
        },
      }),
    ).rejects.toThrow("sqlite write failed");
  });
});

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    streamPath: "/demo",
    type: "https://events.iterate.com/manual-event-appended",
    payload: {},
    offset: 1,
    createdAt: "2026-04-02T12:00:00.000Z",
    ...overrides,
  };
}
