import {
  type CircuitBreakerConfig,
  CircuitBreakerConfiguredEvent,
  type CircuitBreakerState,
  StreamPausedError,
  StreamPausedEvent,
  StreamResumedEvent,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor } from "@iterate-com/events-contract/sdk";

const defaultCircuitBreakerConfig: CircuitBreakerConfig = {
  burstCapacity: 500,
  refillRatePerMinute: 500,
};

function getRefillRatePerMs(config: CircuitBreakerConfig) {
  return config.refillRatePerMinute / 60_000;
}

/**
 * Rate-limiting circuit breaker for event streams.
 *
 * Uses a token bucket so the reducer can approximate burst rate limiting with
 * constant-size state.
 *
 * The mental model is:
 * - the bucket starts full, so a stream can absorb a short burst immediately
 * - tokens refill continuously at the configured per-minute rate
 * - every appended event spends one token
 * - if an event arrives after the bucket is already empty, the reducer records
 *   a negative balance and `afterAppend` turns that into `stream/paused`
 *
 * In practice this means the processor allows a configured sustained throughput
 * with an explicit burst budget, while only persisting two rate-limiter fields:
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
    config: defaultCircuitBreakerConfig,
    availableTokens: defaultCircuitBreakerConfig.burstCapacity,
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
    const configuredEvent = CircuitBreakerConfiguredEvent.safeParse(event);
    if (configuredEvent.success) {
      return {
        ...state,
        config: configuredEvent.data.payload,
        availableTokens: configuredEvent.data.payload.burstCapacity,
        lastRefillAtMs: createdAtMs,
      };
    }

    const pausedEvent = StreamPausedEvent.safeParse(event);
    if (pausedEvent.success) {
      return {
        paused: true,
        pauseReason: pausedEvent.data.payload.reason ?? null,
        pausedAt: event.createdAt,
        config: state.config,
        availableTokens: state.config.burstCapacity,
        lastRefillAtMs: createdAtMs,
      };
    }

    if (StreamResumedEvent.safeParse(event).success) {
      return {
        paused: false,
        pauseReason: null,
        pausedAt: null,
        config: state.config,
        availableTokens: state.config.burstCapacity,
        lastRefillAtMs: createdAtMs,
      };
    }

    // Rebuild the current bucket level from the last persisted balance plus
    // the time that has elapsed since then. We cap at `burstCapacity`
    // because idle time should restore the full burst budget, not accumulate
    // unbounded credit.
    const refilledTokens =
      state.lastRefillAtMs == null
        ? state.config.burstCapacity
        : Math.min(
            state.config.burstCapacity,
            state.availableTokens +
              (createdAtMs - state.lastRefillAtMs) * getRefillRatePerMs(state.config),
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
