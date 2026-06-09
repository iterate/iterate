// Defines the "circuit-breaker" processor contract.
//
// This processor owns the token-bucket rate limiter. When tokens go negative it
// appends `events.iterate.com/stream/paused` so the core processor can shut
// the door via its beforeAppend gate. More elaborate breakers — per-tenant
// budgets, ML anomaly detectors, upstream coordination — could run as separate
// processors and use the same paused/resumed contract with the inline core
// processor.

import { z } from "zod";
import { defineProcessorContract } from "../../shared/stream-processors.ts";
import { CoreProcessorContract } from "../core/contract.ts";

// Experiment defaults: effectively no rate limiting for normal browser/load tests.
// Refill is per minute in the token bucket; 6_000_000/min ≈ 100k events/s sustained.
export const DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY = 100_000;
export const DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE = 6_000_000;

const CircuitBreakerProcessorState = z.object({
  availableTokens: z.number(),
  lastRefillAtMs: z.number().int().min(0).nullable(),
  burstCapacity: z.number().int().positive(),
  refillRatePerMinute: z.number().int().positive(),
});

export type CircuitBreakerProcessorState = z.infer<typeof CircuitBreakerProcessorState>;

export const circuitBreakerProcessorContract = defineProcessorContract({
  slug: "circuit-breaker",
  version: "0.1.0",
  description: "Token-bucket rate limiter that trips the stream into paused state.",
  stateSchema: CircuitBreakerProcessorState,
  initialState: {
    availableTokens: DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
    lastRefillAtMs: null,
    burstCapacity: DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
    refillRatePerMinute: DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE,
  },
  processorDeps: [CoreProcessorContract],
  events: {
    "events.iterate.com/circuit-breaker/configured": {
      description: "Configures burst capacity and refill rate for the token bucket.",
      payloadSchema: z.object({
        burstCapacity: z.number().int().positive(),
        refillRatePerMinute: z.number().int().positive(),
      }),
    },
  },
  consumes: [
    "*",
    "events.iterate.com/circuit-breaker/configured",
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/configured",
    "events.iterate.com/stream/metadata-updated",
    "events.iterate.com/stream/child-stream-created",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/processor-registered",
    "events.iterate.com/stream/error-occurred",
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
  ],
  emits: ["events.iterate.com/stream/paused"],
  reduce({ state, event }) {
    if (event.type === "events.iterate.com/circuit-breaker/configured") {
      return {
        ...state,
        burstCapacity: event.payload.burstCapacity,
        refillRatePerMinute: event.payload.refillRatePerMinute,
        availableTokens: event.payload.burstCapacity,
        lastRefillAtMs: Date.parse(event.createdAt),
      };
    }

    if (
      event.type === "events.iterate.com/stream/paused" ||
      event.type === "events.iterate.com/stream/resumed"
    ) {
      return {
        ...state,
        availableTokens: state.burstCapacity,
        lastRefillAtMs: Date.parse(event.createdAt),
      };
    }

    if (event.type === "events.iterate.com/stream/woken") {
      return state;
    }

    return spendCircuitBreakerToken({ state, event });
  },
});

export function shouldTripCircuitBreaker(state: CircuitBreakerProcessorState) {
  return state.availableTokens < 0;
}

function spendCircuitBreakerToken(args: {
  state: CircuitBreakerProcessorState;
  event: { createdAt: string };
}): CircuitBreakerProcessorState {
  const createdAtMs = Date.parse(args.event.createdAt);
  const refilled =
    args.state.lastRefillAtMs === null
      ? args.state.burstCapacity
      : Math.min(
          args.state.burstCapacity,
          args.state.availableTokens +
            (createdAtMs - args.state.lastRefillAtMs) * (args.state.refillRatePerMinute / 60_000),
        );

  return {
    ...args.state,
    availableTokens: refilled - 1,
    lastRefillAtMs: createdAtMs,
  };
}
