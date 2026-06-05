import { describe, expect, it } from "vitest";
import { coreProcessorContract } from "../core/contract.ts";
import { assertStreamAppendAllowed } from "../core/implementation.ts";
import { circuitBreakerProcessorContract, shouldTripCircuitBreaker } from "./contract.ts";

const coreReduce = coreProcessorContract.reduce;
const circuitBreakerReduce = circuitBreakerProcessorContract.reduce;
if (coreReduce === undefined || circuitBreakerReduce === undefined) {
  throw new Error("builtin processors must have reducers");
}

describe("circuit breaker processor", () => {
  it("configures burst and refill via its owned configured event", () => {
    let state = circuitBreakerProcessorContract.stateSchema.parse(
      circuitBreakerProcessorContract.initialState,
    );
    const event = {
      offset: 1,
      createdAt: "2026-06-01T12:00:00.000Z",
      type: "events.iterate.com/circuit-breaker/configured" as const,
      payload: { burstCapacity: 10, refillRatePerMinute: 60 },
    };
    state = circuitBreakerProcessorContract.stateSchema.parse(
      circuitBreakerReduce({
        contract: circuitBreakerProcessorContract,
        state,
        event,
      }),
    );

    expect(state).toMatchObject({
      burstCapacity: 10,
      refillRatePerMinute: 60,
      availableTokens: 10,
    });
  });

  it("trips after the burst budget and drives stream pause/resume", () => {
    let coreState = coreProcessorContract.stateSchema.parse(coreProcessorContract.initialState);
    let circuitBreakerState = circuitBreakerProcessorContract.stateSchema.parse(
      circuitBreakerProcessorContract.initialState,
    );

    const createdEvent = {
      offset: 1,
      type: "events.iterate.com/stream/created" as const,
      payload: { namespace: "stream", path: "/cb" },
      createdAt: "2026-06-01T12:00:00.000Z",
    };
    coreState = coreProcessorContract.stateSchema.parse(
      coreReduce({ contract: coreProcessorContract, state: coreState, event: createdEvent }),
    );
    circuitBreakerState = circuitBreakerProcessorContract.stateSchema.parse(
      circuitBreakerReduce({
        contract: circuitBreakerProcessorContract,
        state: circuitBreakerState,
        event: createdEvent,
      }),
    );

    const configuredEvent = {
      offset: 2,
      createdAt: "2026-06-01T12:00:00.100Z",
      type: "events.iterate.com/circuit-breaker/configured" as const,
      payload: { burstCapacity: 1, refillRatePerMinute: 1 },
    };
    circuitBreakerState = circuitBreakerProcessorContract.stateSchema.parse(
      circuitBreakerReduce({
        contract: circuitBreakerProcessorContract,
        state: circuitBreakerState,
        event: configuredEvent,
      }),
    );
    for (const [offset, createdAt] of [
      [3, "2026-06-01T12:00:01.000Z"],
      [4, "2026-06-01T12:00:02.000Z"],
    ] as const) {
      const metadataEvent = {
        offset,
        createdAt,
        type: "events.iterate.com/stream/metadata-updated" as const,
        payload: { metadata: { n: offset } },
      };
      circuitBreakerState = circuitBreakerProcessorContract.stateSchema.parse(
        circuitBreakerReduce({
          contract: circuitBreakerProcessorContract,
          state: circuitBreakerState,
          event: metadataEvent,
        }),
      );
    }

    expect(shouldTripCircuitBreaker(circuitBreakerState)).toBe(true);

    const pausedEvent = {
      offset: 5,
      createdAt: "2026-06-01T12:00:02.001Z",
      type: "events.iterate.com/stream/paused" as const,
      payload: { reason: "circuit breaker tripped" },
    };
    coreState = coreProcessorContract.stateSchema.parse(
      coreReduce({ contract: coreProcessorContract, state: coreState, event: pausedEvent }),
    );
    circuitBreakerState = circuitBreakerProcessorContract.stateSchema.parse(
      circuitBreakerReduce({
        contract: circuitBreakerProcessorContract,
        state: circuitBreakerState,
        event: pausedEvent,
      }),
    );

    expect(coreState.paused).toBe(true);
    expect(circuitBreakerState.availableTokens).toBe(1);
    expect(() =>
      assertStreamAppendAllowed({
        event: { type: "test.event", payload: {} },
        state: coreState,
      }),
    ).toThrow("stream paused");

    const resumedEvent = {
      offset: 6,
      createdAt: "2026-06-01T12:00:03.000Z",
      type: "events.iterate.com/stream/resumed" as const,
      payload: { reason: "operator" },
    };
    coreState = coreProcessorContract.stateSchema.parse(
      coreReduce({ contract: coreProcessorContract, state: coreState, event: resumedEvent }),
    );
    circuitBreakerState = circuitBreakerProcessorContract.stateSchema.parse(
      circuitBreakerReduce({
        contract: circuitBreakerProcessorContract,
        state: circuitBreakerState,
        event: resumedEvent,
      }),
    );

    expect(coreState.paused).toBe(false);
    expect(circuitBreakerState.availableTokens).toBe(1);
  });
});
