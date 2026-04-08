import { describe, expect, test } from "vitest";
import {
  type Event,
  type EventInput,
  type CircuitBreakerState,
} from "@iterate-com/events-contract";
import { circuitBreakerProcessor } from "./circuit-breaker.ts";

describe("circuitBreaker", () => {
  test("reduce spends a token for the first event", () => {
    const state = structuredClone(circuitBreakerProcessor.initialState);

    const nextState = circuitBreakerProcessor.reduce!({
      state,
      event: createEvent({
        createdAt: "2026-04-02T12:00:00.000Z",
      }),
    });

    expect(nextState).toEqual({
      paused: false,
      pauseReason: null,
      pausedAt: null,
      availableTokens: 99,
      lastRefillAtMs: Date.parse("2026-04-02T12:00:00.000Z"),
    });
  });

  test("beforeAppend rejects new events while paused but still allows stream/resumed and durable-object-constructed", () => {
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

    expect(() =>
      circuitBreakerProcessor.beforeAppend?.({
        state,
        event: {
          type: "https://events.iterate.com/events/stream/durable-object-constructed",
          payload: {},
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
      availableTokens: 100,
      lastRefillAtMs: Date.parse("2026-04-02T12:00:00.000Z"),
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
      availableTokens: 100,
      lastRefillAtMs: Date.parse("2026-04-02T12:00:05.000Z"),
    });
  });

  test("reduce refills the bucket over time", () => {
    const state = circuitBreakerProcessor.reduce!({
      state: structuredClone(circuitBreakerProcessor.initialState),
      event: createEvent({
        createdAt: "2026-04-02T12:00:00.000Z",
      }),
    });

    const nextState = circuitBreakerProcessor.reduce!({
      state,
      event: createEvent({
        createdAt: "2026-04-02T12:00:00.500Z",
        offset: 2,
      }),
    });

    expect(nextState).toEqual({
      paused: false,
      pauseReason: null,
      pausedAt: null,
      availableTokens: 99,
      lastRefillAtMs: Date.parse("2026-04-02T12:00:00.500Z"),
    });
  });

  test("reduce drives the bucket negative during a rapid burst", () => {
    let state = structuredClone(circuitBreakerProcessor.initialState);

    for (let index = 0; index < 101; index += 1) {
      state = circuitBreakerProcessor.reduce!({
        state,
        event: createEvent({
          createdAt: "2026-04-02T12:00:00.000Z",
          offset: index + 1,
        }),
      });
    }

    expect(state.availableTokens).toBeLessThan(0);
  });

  test("reduce stays within budget for slower sustained traffic", () => {
    let state = structuredClone(circuitBreakerProcessor.initialState);
    const base = Date.parse("2026-04-02T12:00:00.000Z");

    for (let index = 0; index < 105; index += 1) {
      state = circuitBreakerProcessor.reduce!({
        state,
        event: createEvent({
          createdAt: new Date(base + index * 20).toISOString(),
          offset: index + 1,
        }),
      });
    }

    expect(state.availableTokens).toBeGreaterThanOrEqual(0);
  });

  test("afterAppend auto-appends a pause event when the bucket goes negative", async () => {
    const appended: EventInput[] = [];

    await circuitBreakerProcessor.afterAppend?.({
      append: (event) => {
        appended.push(event);
        return createEvent({
          type: event.type,
          payload: event.payload,
        });
      },
      event: createEvent(),
      state: {
        paused: false,
        pauseReason: null,
        pausedAt: null,
        availableTokens: -1,
        lastRefillAtMs: Date.parse("2026-04-02T12:00:00.000Z"),
      },
    });

    expect(appended).toEqual([
      {
        type: "https://events.iterate.com/events/stream/paused",
        payload: {
          reason: "circuit breaker tripped: burst rate limit exceeded",
        },
      },
    ]);
  });

  test("afterAppend rejects when append fails", async () => {
    await expect(
      circuitBreakerProcessor.afterAppend?.({
        append: () => {
          throw new Error("sqlite write failed");
        },
        event: createEvent(),
        state: {
          paused: false,
          pauseReason: null,
          pausedAt: null,
          availableTokens: -1,
          lastRefillAtMs: Date.parse("2026-04-02T12:00:00.000Z"),
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
