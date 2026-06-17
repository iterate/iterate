import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../shared/event.ts";
import { CoreProcessorContract, type CoreProcessorState } from "../core/contract.ts";
import { CoreStreamProcessor } from "../core/implementation.ts";
import { CircuitBreakerProcessor } from "./implementation.ts";
import { shouldTripCircuitBreaker, spendCircuitBreakerToken } from "./contract.ts";
import type { StreamProcessorStream } from "../../stream-processor.ts";

const stream = () => ({ append() {}, appendBatch() {} }) as unknown as StreamProcessorStream;

describe("circuit breaker processor", () => {
  const coreProcessor = new CoreStreamProcessor({ stream: stream() });
  const coreReduce = (args: { state: CoreProcessorState; event: StreamEvent }) =>
    coreProcessor.reduceEvent(args);

  it("spends and refills tokens against the configured rate", () => {
    let state = spendCircuitBreakerToken({
      state: {
        availableTokens: 1,
        lastRefillAtMs: null,
        burstCapacity: 1,
        refillRatePerMinute: 60,
      },
      event: { createdAt: "2026-06-01T12:00:00.000Z" },
    });
    expect(state).toMatchObject({ availableTokens: 0 });
    expect(shouldTripCircuitBreaker(state)).toBe(false);

    // 1 token per second refill: 500ms refills half a token, not enough for one.
    state = spendCircuitBreakerToken({ state, event: { createdAt: "2026-06-01T12:00:00.500Z" } });
    expect(state.availableTokens).toBeLessThan(0);
    expect(shouldTripCircuitBreaker(state)).toBe(true);
  });

  it("configures burst and refill via its owned configured event", async () => {
    const processor = new CircuitBreakerProcessor({ stream: stream() });

    await processor.ingest({
      events: [
        {
          offset: 1,
          createdAt: "2026-06-01T12:00:00.000Z",
          type: "events.iterate.com/circuit-breaker/configured",
          payload: { burstCapacity: 10, refillRatePerMinute: 60 },
        },
      ],
      streamMaxOffset: 1,
    });

    expect(processor.state).toMatchObject({
      burstCapacity: 10,
      refillRatePerMinute: 60,
      availableTokens: 10,
    });
  });

  it("trips after the burst budget and drives stream pause/resume", async () => {
    let coreState = CoreProcessorContract.stateSchema.parse(CoreProcessorContract.initialState);
    const processor = new CircuitBreakerProcessor({ stream: stream() });

    const ingest = async (event: StreamEvent) => {
      await processor.ingest({ events: [event], streamMaxOffset: event.offset });
    };

    const createdEvent: StreamEvent = {
      offset: 1,
      type: "events.iterate.com/stream/created",
      payload: { projectId: "stream", path: "/cb" },
      createdAt: "2026-06-01T12:00:00.000Z",
    };
    coreState = coreReduce({ state: coreState, event: createdEvent });
    await ingest(createdEvent);

    await ingest({
      offset: 2,
      createdAt: "2026-06-01T12:00:00.100Z",
      type: "events.iterate.com/circuit-breaker/configured",
      payload: { burstCapacity: 1, refillRatePerMinute: 1 },
    });
    for (const [offset, createdAt] of [
      [3, "2026-06-01T12:00:01.000Z"],
      [4, "2026-06-01T12:00:02.000Z"],
    ] as const) {
      await ingest({
        offset,
        createdAt,
        type: "events.iterate.com/stream/metadata-updated",
        payload: { metadata: { n: offset } },
      });
    }

    expect(shouldTripCircuitBreaker(processor.state)).toBe(true);

    const pausedEvent: StreamEvent = {
      offset: 5,
      createdAt: "2026-06-01T12:00:02.001Z",
      type: "events.iterate.com/stream/paused",
      payload: { reason: "circuit breaker tripped" },
    };
    coreState = coreReduce({ state: coreState, event: pausedEvent });
    await ingest(pausedEvent);

    expect(coreState.paused).toBe(true);
    expect(processor.state.availableTokens).toBe(1);
    expect(() =>
      coreProcessor.validateAppend({
        event: { type: "test.event", payload: {} },
        state: coreState,
      }),
    ).toThrow("stream paused");

    const resumedEvent: StreamEvent = {
      offset: 6,
      createdAt: "2026-06-01T12:00:03.000Z",
      type: "events.iterate.com/stream/resumed",
      payload: { reason: "operator" },
    };
    coreState = coreReduce({ state: coreState, event: resumedEvent });
    await ingest(resumedEvent);

    expect(coreState.paused).toBe(false);
    expect(processor.state.availableTokens).toBe(1);
  });
});
