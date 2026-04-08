import {
  type CircuitBreakerState,
  StreamPausedError,
  StreamPausedEvent,
  StreamResumedEvent,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor } from "@iterate-com/events-contract/sdk";

const maxEventsPerSecond = 100;
const refillRatePerMs = maxEventsPerSecond / 1_000;

/**
 * Rate-limiting circuit breaker for event streams.
 *
 * Uses a token bucket so the reducer can approximate burst rate limiting with
 * constant-size state. Each event spends one token, and the bucket refills at
 * `maxEventsPerSecond`. When a write pushes the bucket below zero, the stream
 * auto-appends "stream/paused".
 *
 * Token bucket gives a bounded burst budget with O(1) state rather than an
 * exact sliding window that grows with the threshold. Primary references:
 * - RFC 1363: https://datatracker.ietf.org/doc/rfc1363/
 * - RFC 3290 Appendix A: https://datatracker.ietf.org/doc/html/rfc3290
 *
 * This prevents runaway producers from flooding a stream while still allowing
 * an operator to resume manually.
 */
export const circuitBreakerProcessor = defineBuiltinProcessor<CircuitBreakerState>(() => ({
  slug: "circuit-breaker",
  initialState: {
    paused: false,
    pauseReason: null,
    pausedAt: null,
    availableTokens: maxEventsPerSecond,
    lastRefillAtMs: null,
  },

  beforeAppend({ event, state }) {
    if (!state.paused) return;
    if (event.type === "https://events.iterate.com/events/stream/resumed") return;
    if (event.type === "https://events.iterate.com/events/stream/durable-object-constructed") {
      return;
    }
    throw new StreamPausedError();
  },

  reduce({ event, state }) {
    const createdAtMs = Date.parse(event.createdAt);
    const pausedEvent = StreamPausedEvent.safeParse(event);
    if (pausedEvent.success) {
      return {
        paused: true,
        pauseReason: pausedEvent.data.payload.reason ?? null,
        pausedAt: event.createdAt,
        availableTokens: maxEventsPerSecond,
        lastRefillAtMs: createdAtMs,
      };
    }

    if (StreamResumedEvent.safeParse(event).success) {
      return {
        paused: false,
        pauseReason: null,
        pausedAt: null,
        availableTokens: maxEventsPerSecond,
        lastRefillAtMs: createdAtMs,
      };
    }

    const refilledTokens =
      state.lastRefillAtMs == null
        ? maxEventsPerSecond
        : Math.min(
            maxEventsPerSecond,
            state.availableTokens + (createdAtMs - state.lastRefillAtMs) * refillRatePerMs,
          );

    return {
      ...state,
      availableTokens: refilledTokens - 1,
      lastRefillAtMs: createdAtMs,
    };
  },

  async afterAppend({ append, state }) {
    if (state.paused) return;
    if (state.availableTokens >= 0) return;

    await append({
      type: "https://events.iterate.com/events/stream/paused",
      payload: { reason: "circuit breaker tripped: burst rate limit exceeded" },
    });
  },
}));
