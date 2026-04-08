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
 * constant-size state.
 *
 * The mental model is:
 * - the bucket starts full, so a stream can absorb a short burst immediately
 * - tokens refill continuously at `maxEventsPerSecond`
 * - every appended event spends one token
 * - if an event arrives after the bucket is already empty, the reducer records
 *   a negative balance and `afterAppend` turns that into `stream/paused`
 *
 * In practice this means the processor allows roughly `maxEventsPerSecond`
 * sustained throughput with a burst budget of about the same size, while only
 * persisting two rate-limiter fields:
 * - `availableTokens`
 * - `lastRefillAtMs`
 *
 * That tradeoff is deliberate. This is a circuit breaker, not billing-grade
 * metering, so approximate burst control with O(1) state is a better fit than
 * storing one timestamp per recent event.
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

    // Rebuild the current bucket level from the last persisted balance plus
    // the time that has elapsed since then. We cap at `maxEventsPerSecond`
    // because idle time should restore the full burst budget, not accumulate
    // unbounded credit.
    const refilledTokens =
      state.lastRefillAtMs == null
        ? maxEventsPerSecond
        : Math.min(
            maxEventsPerSecond,
            state.availableTokens + (createdAtMs - state.lastRefillAtMs) * refillRatePerMs,
          );

    return {
      ...state,
      // Spending one token here means the reducer has already decided whether
      // this append stayed within budget. `afterAppend` only has to look for a
      // negative balance and emit the pause event.
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
