// Implements the "circuit-breaker" processor.
// Runs as an ordinary subscription processor. When the bucket goes negative it
// appends stream/paused; the core processor's validateAppend gate enforces it.

import { StreamProcessor } from "../../stream-processor.ts";
import {
  CircuitBreakerContract,
  shouldTripCircuitBreaker,
  spendCircuitBreakerToken,
  type CircuitBreakerProcessorState,
} from "./contract.ts";
export { CircuitBreakerContract } from "./contract.ts";

export type CircuitBreakerContract = typeof CircuitBreakerContract;

export class CircuitBreakerProcessor extends StreamProcessor<CircuitBreakerContract> {
  readonly contract = CircuitBreakerContract;

  protected override reduce(
    args: Parameters<StreamProcessor<CircuitBreakerContract>["reduce"]>[0],
  ): CircuitBreakerProcessorState {
    const { event, state } = args;
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
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<CircuitBreakerContract>["processEvent"]>[0],
  ): void {
    // Level-triggered, not edge-triggered: fire whenever the bucket is in deficit
    // on a live event. An edge guard (`!tripped(previousState)`) would miss the
    // common case where the not-tripped->tripped transition happened at or below
    // the side-effect anchor during replay — processEvent isn't called there, so
    // the live flood that follows would never pause. The pause append is
    // idempotency-keyed per offset and self-limits: once the stream is paused,
    // ordinary appends are rejected, so the breaker stops being fed.
    if (!shouldTripCircuitBreaker(args.state)) return;
    args.runInBackground(async () => {
      await this.ctx.stream.append({
        event: {
          type: "events.iterate.com/stream/paused",
          idempotencyKey: `stream-paused:${args.event.offset}`,
          payload: { reason: "circuit breaker tripped: burst rate limit exceeded" },
        },
      });
    });
  }
}
