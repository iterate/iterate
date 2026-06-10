// Defines the "circuit-breaker" processor contract.
//
// This processor owns the token-bucket rate limiter. When tokens go negative it
// appends `events.iterate.com/stream/paused` so the core processor can shut
// the door via its validateAppend gate. More elaborate breakers — per-tenant
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

export const CircuitBreakerContract = defineProcessorContract({
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
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
    "events.iterate.com/stream/woken",
  ],
  emits: ["events.iterate.com/stream/paused"],
});

export function shouldTripCircuitBreaker(state: CircuitBreakerProcessorState) {
  return state.availableTokens < 0;
}

export function spendCircuitBreakerToken(args: {
  state: CircuitBreakerProcessorState;
  event: { createdAt: string };
}): CircuitBreakerProcessorState {
  const createdAtMs = Date.parse(args.event.createdAt);
  // Clamp the elapsed time to >= 0. createdAt is per-event wall clock, so DO
  // migration or clock skew can make it regress; without the clamp a negative
  // delta would *subtract* refill and instantly drain the bucket into a false trip.
  const elapsedMs = Math.max(0, createdAtMs - (args.state.lastRefillAtMs ?? createdAtMs));
  const refilled =
    args.state.lastRefillAtMs === null
      ? args.state.burstCapacity
      : Math.min(
          args.state.burstCapacity,
          args.state.availableTokens + elapsedMs * (args.state.refillRatePerMinute / 60_000),
        );

  return {
    ...args.state,
    availableTokens: refilled - 1,
    lastRefillAtMs: createdAtMs,
  };
}
