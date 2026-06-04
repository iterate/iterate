// Implements the built-in "circuit-breaker" processor.
// Runs inline in the Stream Durable Object. When the bucket goes negative it
// appends stream/paused; the core processor's beforeAppend gate enforces it.

import { implementBuiltinProcessor } from "../../processor.ts";
import type { CoreProcessorState } from "../core/contract.ts";
import { circuitBreakerProcessorContract, shouldTripCircuitBreaker } from "./contract.ts";

export const circuitBreakerProcessor = implementBuiltinProcessor(
  circuitBreakerProcessorContract,
  (deps: { readStreamState: () => CoreProcessorState }) => ({
    afterAppend({ event, state, stream, keepAlive }) {
      if (deps.readStreamState().paused) return;
      if (!shouldTripCircuitBreaker(state)) return;
      if (event.type === "events.iterate.com/stream/paused") return;
      keepAlive(
        stream.append({
          event: {
            type: "events.iterate.com/stream/paused",
            idempotencyKey: `stream-paused:${event.offset}`,
            payload: { reason: "circuit breaker tripped: burst rate limit exceeded" },
          },
        }),
      );
    },
  }),
);
