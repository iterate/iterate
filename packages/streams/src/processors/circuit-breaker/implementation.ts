// Implements the "circuit-breaker" processor.
// Runs as an ordinary subscription processor. When the bucket goes negative it
// appends stream/paused; the core processor's beforeAppend gate enforces it.

import { implementProcessor } from "../../processor.ts";
import { circuitBreakerProcessorContract, shouldTripCircuitBreaker } from "./contract.ts";

export const circuitBreakerProcessor = implementProcessor(circuitBreakerProcessorContract, () => ({
  afterAppend({ event, previousState, state, stream, shouldApplySideEffects, keepAlive }) {
    if (!shouldTripCircuitBreaker(state)) return;
    if (shouldTripCircuitBreaker(previousState)) return;
    if (event.type === "events.iterate.com/stream/paused") return;
    if (!shouldApplySideEffects({ event })) return;
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
}));
